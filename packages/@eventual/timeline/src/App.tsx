import { useQuery } from "@tanstack/react-query";
import { Buffer } from "buffer";
import ky from "ky";
import { ReactNode } from "react";
import { ActivityList } from "./components/activity-list/activity-list.js";
import styles from "./App.module.css";
import { TimelineActivity } from "./activity.js";
import { Timeline } from "./components/timeline/timeline.js";
import { WorkflowStarted } from "@eventual/core";

function Layout({
  start,
  children,
}: {
  start?: WorkflowStarted;
  children: ReactNode;
}) {
  const path = window.location.href.split("/");
  const service = path.at(-2);
  const executionId = path.at(-1);
  if (!service) {
    return <div>No service in path!</div>;
  }
  if (!executionId) {
    return <div>No execution id in path!</div>;
  }
  const decodedExecutionId = Buffer.from(executionId, "base64").toString(
    "utf-8"
  );
  return (
    <main className={styles.layout}>
      <div style={{ textAlign: "center" }}>
        <h1>Execution timeline</h1>
      </div>
      <div className={styles.info}>
        <h2 className={styles.subtitle}>Service</h2>
        <div>{service}</div>
        <h2 className={styles.subtitle}>Execution id</h2>
        <div>{decodedExecutionId}</div>
        <h2 className={styles.subtitle}>Execution Started</h2>
        <div>
          {start?.timestamp != null
            ? new Date(start.timestamp).toLocaleString(undefined, {
                dateStyle: "long",
                timeStyle: "long",
              })
            : ""}
        </div>
        <h2 className={styles.subtitle}>Execution input</h2>
        <pre className={styles.input}>{JSON.stringify(start?.input)}</pre>
      </div>
      {children}
    </main>
  );
}

function App() {
  const { data: timeline, isLoading } = useQuery(
    ["events"],
    () => {
      const executionId = window.location.href.split("/").at(-1);
      return ky(`/api/timeline/${executionId}`).json<{
        start: WorkflowStarted;
        activities: TimelineActivity[];
      }>();
    },
    { refetchInterval: 5000 }
  );

  if (isLoading) {
    return (
      <Layout>
        <div>Loading activities...</div>
      </Layout>
    );
  } else if (!timeline?.activities.length) {
    return (
      <Layout start={timeline?.start}>
        <div>No activities</div>
      </Layout>
    );
  } else {
    return (
      <Layout start={timeline.start}>
        <Timeline start={timeline.start} activities={timeline.activities} />
        <div className={styles["activity-list-float"]}>
          <ActivityList
            start={timeline.start}
            activities={timeline.activities}
          />
        </div>
      </Layout>
    );
  }
}

export default App;