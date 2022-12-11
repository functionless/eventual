import { Argv } from "yargs";
import { serviceAction, setServiceOptions } from "../service-action.js";
import express from "express";
import { createServer as createViteServer } from "vite";
import getPort, { portNumbers } from "get-port";
import open from "open";
import { resolve } from "import-meta-resolve";
import {
  HistoryStateEvent,
  isActivityCompleted,
  isActivityFailed,
  isActivityScheduled,
  encodeExecutionId,
  isWorkflowStarted,
  WorkflowStarted,
} from "@eventual/core";

export const timeline = (yargs: Argv) =>
  yargs.command(
    "timeline <service> <execution>",
    "Visualise execution history",
    (yargs) =>
      setServiceOptions(yargs).positional("execution", {
        describe: "Execution Id",
        type: "string",
        demandOption: true,
      }),
    serviceAction(async (spinner, ky, { execution, service }) => {
      spinner.start("Starting viz server");
      const app = express();

      app.use("/api/timeline/:execution", async (req, res) => {
        //We forward errors onto our handler for the ui to deal with
        try {
          const events = await ky
            .get(`executions/${req.params.execution}}/workflow-history`)
            .json<HistoryStateEvent[]>();
          const timeline = aggregateEvents(events);
          res.json(timeline);
        } catch (e: any) {
          res.status(500).json({ error: e.toString() });
        }
      });

      const timelinePath = new URL(
        await resolve("@eventual/timeline", import.meta.url)
      ).pathname;
      console.log(timelinePath);

      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: "spa",
        root: timelinePath,
      });

      app.use(vite.middlewares);

      const port = await getPort({ port: portNumbers(3000, 4000) });
      app.listen(port);
      const url = `http://localhost:${port}`;
      spinner.succeed(`Visualiser running on ${url}`);
      open(`${url}/${service}/${encodeExecutionId(execution)}`);
    })
  );

interface TimelineActivity {
  type: "activity";
  seq: number;
  name: string;
  start: number;
  state:
    | { status: "completed"; duration: number }
    | { status: "failed"; duration: number }
    | { status: "inprogress" };
}

function aggregateEvents(events: HistoryStateEvent[]): {
  start: WorkflowStarted;
  activities: TimelineActivity[];
} {
  let start: WorkflowStarted | undefined;
  const activities: Record<number, TimelineActivity> = [];
  events.forEach((event) => {
    if (isWorkflowStarted(event)) {
      start = event;
    } else if (isActivityScheduled(event)) {
      activities[event.seq] = {
        type: "activity",
        name: event.name,
        seq: event.seq,
        start: new Date(event.timestamp).getTime(),
        state: { status: "inprogress" },
      };
    } else if (isActivityCompleted(event)) {
      let existingActivity = activities[event.seq];
      if (existingActivity) {
        existingActivity.state = {
          status: "completed",
          duration: event.duration,
        };
      } else {
        console.log(
          `Warning: Found completion event without matching scheduled event: ${event}`
        );
      }
    } else if (isActivityFailed(event)) {
      let existingActivity = activities[event.seq];
      if (existingActivity) {
        existingActivity.state = {
          status: "failed",
          duration: event.duration,
        };
      } else {
        console.log(
          `Warning: Found failure event without matching scheduled event: ${event}`
        );
      }
    }
  });
  if (!start) {
    throw new Error("Failed to find WorkflowStarted event!");
  }
  return { start, activities: Object.values(activities) };
}