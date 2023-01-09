import { inspect } from "util";
import { Command } from "../../command.js";
import { Context } from "../../context.js";
import {
  createEvent,
  getEventId,
  HistoryStateEvent,
  isHistoryEvent,
  isSleepCompleted,
  isWorkflowSucceeded,
  isWorkflowFailed,
  isWorkflowStarted,
  WorkflowSucceeded,
  WorkflowEvent,
  WorkflowEventType,
  WorkflowFailed,
  WorkflowRunCompleted,
  WorkflowRunStarted,
  WorkflowTimedOut,
  filterEvents,
} from "../../workflow-events.js";
import {
  SucceededExecution,
  ExecutionStatus,
  FailedExecution,
  isSucceededExecution,
} from "../../execution.js";
import { isFailed, isResolved, isResult, Result } from "../../result.js";
import {
  generateSyntheticEvents,
  lookupWorkflow,
  runWorkflowDefinition,
  Workflow,
} from "../../workflow.js";
import {
  EventClient,
  ExecutionHistoryClient,
  MetricsClient,
  Schedule,
  TimerClient,
  WorkflowClient,
  WorkflowRuntimeClient,
} from "../clients/index.js";
import { CommandExecutor } from "../command-executor.js";
import { isExecutionId, parseWorkflowName } from "../execution-id.js";
import type { Logger } from "../logger.js";
import { MetricsCommon, OrchestratorMetrics } from "../metrics/constants.js";
import { MetricsLogger } from "../metrics/metrics-logger.js";
import { Unit } from "../metrics/unit.js";
import { timed, timedSync } from "../metrics/utils.js";
import { groupBy, promiseAllSettledPartitioned } from "../utils.js";
import { extendsError } from "../../util.js";
import { WorkflowTask } from "../../tasks.js";
import { ExecutionLogContext, LogAgent, LogContextType } from "../log-agent.js";
import { interpret, WorkflowResult } from "../../interpret.js";
import { clearEventualCollector } from "../../global.js";
import { DeterminismError } from "../../error.js";

/**
 * The Orchestrator's client dependencies.
 */
export interface OrchestratorDependencies {
  executionHistoryClient: ExecutionHistoryClient;
  timerClient: TimerClient;
  workflowRuntimeClient: WorkflowRuntimeClient;
  workflowClient: WorkflowClient;
  metricsClient: MetricsClient;
  eventClient: EventClient;
  logger: Logger;
  logAgent: LogAgent;
}

export interface OrchestratorResult {
  /**
   * IDs of the Executions that failed to orchestrate.
   */
  failedExecutionIds: string[];
}

export interface Orchestrator {
  (workflowTasks: WorkflowTask[], baseTime?: Date): Promise<OrchestratorResult>;
}

/**
 * Creates a generic function for orchestrating a batch of executions
 * that can be used in runtime implementations. This implementation is
 * decoupled from a runtime's specifics by the clients. A runtime must
 * inject its own client implementations designed for that platform.
 */
export function createOrchestrator({
  executionHistoryClient,
  timerClient,
  workflowRuntimeClient,
  workflowClient,
  metricsClient,
  eventClient,
  logger,
  logAgent,
}: OrchestratorDependencies): Orchestrator {
  const commandExecutor = new CommandExecutor({
    timerClient,
    workflowClient,
    workflowRuntimeClient,
    eventClient,
  });

  return async (workflowTasks, baseTime = new Date()) => {
    const tasksByExecutionId = groupBy(
      workflowTasks,
      (task) => task.executionId
    );

    const eventsByExecutionId = Object.fromEntries(
      Object.entries(tasksByExecutionId).map(([executionId, records]) => [
        executionId,
        records.flatMap((e) => e.events),
      ])
    );

    logger.info(
      "Found execution ids: " + Object.keys(eventsByExecutionId).join(", ")
    );

    // for each execution id
    const results = await promiseAllSettledPartitioned(
      Object.entries(eventsByExecutionId),
      async ([executionId, records]) => {
        if (!isExecutionId(executionId)) {
          throw new Error(`invalid ExecutionID: '${executionId}'`);
        }
        const workflowName = parseWorkflowName(executionId);
        if (workflowName === undefined) {
          throw new Error(`execution ID '${executionId}' does not exist`);
        }
        // TODO: get workflow from execution id
        return orchestrateExecution(
          workflowName,
          executionId,
          records,
          baseTime
        );
      }
    );

    logger.debug(
      "Executions succeeded: " +
        results.fulfilled.map(([[executionId]]) => executionId).join(",")
    );

    if (results.rejected.length > 0) {
      logger.error(
        "Executions failed: \n" +
          results.rejected
            .map(([[executionId], error]) => `${executionId}: ${error}`)
            .join("\n")
      );
    }

    return {
      failedExecutionIds: results.rejected.map((rejected) => rejected[0][0]),
    };
  };

  async function orchestrateExecution(
    workflowName: string,
    executionId: string,
    events: HistoryStateEvent[],
    baseTime: Date
  ) {
    const executionLogger = logger.createChild({
      persistentLogAttributes: { workflowName, executionId },
    });
    const metrics = initializeMetrics();
    const start = baseTime;
    try {
      // load
      const history = await loadHistory();

      // execute
      const { updatedHistoryEvents, newEvents, resultEvent } =
        await executeWorkflow(history);

      // persist
      await persistWorkflowResult(resultEvent);
      const logFlush = timed(
        metrics,
        OrchestratorMetrics.ExecutionLogWriteTime,
        // write any collected logs to cloudwatch
        () => logAgent.flush()
      );
      await saveNewEventsToExecutionHistory(newEvents);
      await updateHistory(updatedHistoryEvents);
      await logFlush;

      // Only log these metrics once the orchestrator has completed successfully.
      logEventMetrics(metrics, events, start);
    } catch (err) {
      executionLogger.error(inspect(err));
      throw err;
    } finally {
      await metrics.flush();
    }

    /**
     * Executes the workflow and returns the history and events to persist.
     */
    async function executeWorkflow(history: HistoryStateEvent[]) {
      // length of time the oldest event in the queue.
      const maxTaskAge = Math.max(
        ...events.map(
          (event) => new Date().getTime() - Date.parse(event.timestamp)
        )
      );
      metrics.putMetric(
        OrchestratorMetrics.MaxTaskAge,
        maxTaskAge,
        Unit.Milliseconds
      );

      return partitionExecutionResults(history, executeWorkflowGenerator());

      async function* executeWorkflowGenerator() {
        yield createEvent<WorkflowRunStarted>(
          {
            type: WorkflowEventType.WorkflowRunStarted,
          },
          start
        );

        const workflow = lookupWorkflow(workflowName);
        if (workflow === undefined) {
          yield createEvent<WorkflowFailed>(
            {
              type: WorkflowEventType.WorkflowFailed,
              error: "WorkflowNotFound",
              message: `Workflow name ${workflowName} does not exist.`,
            },
            start
          );
          return;
        }

        const startEvent = history.find(isWorkflowStarted);

        /**
         * Check to see if this is the first run of the workflow (or all others have failed).
         * If so, check to see if the workflow has timeout to start.
         */
        if (!startEvent) {
          const newWorkflowStart = events.find(isWorkflowStarted);

          if (newWorkflowStart?.timeoutTime) {
            metrics.setProperty(OrchestratorMetrics.TimeoutStarted, 1);
            await timed(
              metrics,
              OrchestratorMetrics.TimeoutStartedDuration,
              () =>
                timerClient.scheduleEvent<WorkflowTimedOut>({
                  schedule: Schedule.absolute(newWorkflowStart.timeoutTime!),
                  event: createEvent<WorkflowTimedOut>(
                    {
                      type: WorkflowEventType.WorkflowTimedOut,
                    },
                    start
                  ),
                  executionId,
                })
            );
          } else {
            metrics.setProperty(OrchestratorMetrics.TimeoutStarted, 0);
          }
        }

        const {
          result,
          commands: newCommands,
          history: updatedHistoryEvents,
        } = await progressWorkflow(workflow, history, events);

        metrics.setProperty(
          OrchestratorMetrics.AdvanceExecutionEvents,
          updatedHistoryEvents.length
        );

        yield* updatedHistoryEvents;

        executionLogger.debug(
          "Workflow terminated with: " + JSON.stringify(result)
        );

        executionLogger.info(`Found ${newCommands.length} new commands.`);

        yield* await timed(
          metrics,
          OrchestratorMetrics.InvokeCommandsDuration,
          () => processCommands(workflow, newCommands)
        );

        metrics.putMetric(
          OrchestratorMetrics.CommandsInvoked,
          newCommands.length,
          Unit.Count
        );

        // tracks the time it takes for a workflow task to be scheduled until new commands could be emitted.
        // This represent the workflow orchestration time of User Perceived Latency
        // Average expected time for an activity to be invoked until it is considered complete by the workflow should follow:
        // AvgActivityDuration(N) = Avg(TimeToCommandsInvoked) + Avg(ActivityDuration(N))
        metrics.putMetric(
          OrchestratorMetrics.TimeToCommandsInvoked,
          maxTaskAge + (new Date().getTime() - start.getTime())
        );

        yield createEvent<WorkflowRunCompleted>(
          {
            type: WorkflowEventType.WorkflowRunCompleted,
          },
          start
        );

        if (isResult(result)) {
          if (isFailed(result)) {
            const [error, message] = extendsError(result.error)
              ? [result.error.name, result.error.message]
              : ["Error", JSON.stringify(result.error)];
            yield createEvent<WorkflowFailed>(
              {
                type: WorkflowEventType.WorkflowFailed,
                error,
                message,
              },
              start
            );
          } else if (isResolved<any>(result)) {
            yield createEvent<WorkflowSucceeded>(
              {
                type: WorkflowEventType.WorkflowSucceeded,
                output: result.value,
              },
              start
            );
          }
        }

        return result;
      }

      /**
       * Advance a workflow using previous history, new events, and a program.
       */
      async function progressWorkflow(
        workflow: Workflow,
        historyEvents: HistoryStateEvent[],
        taskEvents: HistoryStateEvent[]
      ): Promise<ProgressWorkflowResult> {
        // historical events and incoming events will be fed into the workflow to resume/progress state
        const uniqueTaskEvents = filterEvents<HistoryStateEvent>(
          historyEvents,
          taskEvents
        );

        const inputEvents = [...historyEvents, ...uniqueTaskEvents];

        // Generates events that are time sensitive, like sleep completed events.
        const syntheticEvents = generateSyntheticEvents(inputEvents, baseTime);

        const allEvents = [...inputEvents, ...syntheticEvents];

        const startEvent = inputEvents.find(isWorkflowStarted);

        if (!startEvent) {
          throw new DeterminismError(
            `No ${WorkflowEventType.WorkflowStarted} found.`
          );
        }

        const context: Context = {
          workflow: {
            name: workflow.workflowName,
          },
          execution: {
            ...startEvent.context,
            id: executionId,
            startTime: startEvent.timestamp,
          },
        };

        // execute workflow
        const interpretEvents = allEvents.filter(isHistoryEvent);

        const logContext: ExecutionLogContext = {
          type: LogContextType.Execution,
          executionId,
        };

        logAgent.logWithContext(
          logContext,
          "DEBUG",
          "history events",
          JSON.stringify(historyEvents)
        );
        logAgent.logWithContext(
          logContext,
          "DEBUG",
          "task events",
          JSON.stringify(taskEvents)
        );
        logAgent.logWithContext(
          logContext,
          "DEBUG",
          "synthetic events",
          JSON.stringify(syntheticEvents)
        );
        logAgent.logWithContext(
          logContext,
          "DEBUG",
          "interpret events",
          JSON.stringify(interpretEvents)
        );

        // flush any logs generated to this point
        await logAgent.flush();

        // buffer logs until interpret is complete
        logAgent.disableSendingLogs();

        const result = logAgent.logContextScope(logContext, () =>
          timedSync(
            metrics,
            OrchestratorMetrics.AdvanceExecutionDuration,
            () => {
              try {
                return {
                  ...interpret(
                    runWorkflowDefinition(workflow, startEvent.input, context),
                    interpretEvents,
                    {
                      // when an event is matched, that means all the work to this point has been completed, clear the logs collected.
                      historicalEventMatched: () => logAgent.clearLogs(),
                    }
                  ),
                  history: allEvents,
                };
              } catch (err) {
                // temporary fix when the interpreter fails, but the activities are not cleared.
                clearEventualCollector();
                console.error("workflow error");
                executionLogger.error(inspect(err));
                throw err;
              }
            }
          )
        );

        // re-enable sending logs, any generated logs are new.
        logAgent.enableSendingLogs();

        return result;
      }

      /**
       * Partitions the events output by the workflow.
       *
       * We need two different collection of events.
       *
       * History Events - these are the events that workflow uses to maintain state.
       *                  each run of the workflow we may filter or add events to this collection.
       *                  these events will be persisted for the next run.
       * Workflow Events - these are fined grained events emitted by the workflow. They drive UIs,
       *                   visualization and debugging. They may not be used in the interpreter.
       *                   The new ones will be persisted after each run.
       */
      async function partitionExecutionResults(
        originalHistory: HistoryStateEvent[],
        executionGenerator: AsyncGenerator<WorkflowEvent, Result | undefined>
      ) {
        const updatedHistoryEvents: HistoryStateEvent[] = [];
        const newWorkflowEvents: WorkflowEvent[] = [];
        let resultEvent: WorkflowSucceeded | WorkflowFailed | undefined;
        const seenEvents: Set<string> = new Set(
          originalHistory.map(getEventId)
        );

        for await (const event of executionGenerator) {
          const id = getEventId(event);
          // newWorkflowEvents are the unique new events generated by this workflow execution.
          if (!seenEvents.has(id)) {
            newWorkflowEvents.push(event);
            seenEvents.add(id);
          }
          if (isWorkflowSucceeded(event) || isWorkflowFailed(event)) {
            resultEvent = event;
          }
          // updatedHistoryEvents are all HistoryEvents old and new.
          if (isWorkflowStarted(event) || isHistoryEvent(event)) {
            updatedHistoryEvents.push(event);
          }
        }

        return {
          updatedHistoryEvents,
          newEvents: newWorkflowEvents,
          resultEvent,
        };
      }
    }

    async function loadHistory(): Promise<HistoryStateEvent[]> {
      executionLogger.debug("Load history");
      // load history
      const history = await timed(
        metrics,
        OrchestratorMetrics.LoadHistoryDuration,
        async () => workflowRuntimeClient.getHistory(executionId)
      );

      metrics.setProperty(
        OrchestratorMetrics.LoadedHistoryEvents,
        history.length
      );

      return history;
    }

    /**
     * Saves all new events generated by this execution to the {@link ExecutionHistoryClient}.
     */
    async function saveNewEventsToExecutionHistory(newEvents: WorkflowEvent[]) {
      await timed(
        metrics,
        OrchestratorMetrics.AddNewExecutionEventsDuration,
        () => executionHistoryClient.putEvents(executionId, newEvents)
      );

      metrics.setProperty(
        OrchestratorMetrics.NewExecutionEvents,
        newEvents.length
      );
    }

    /**
     * Saves all of the History Events (the ones the workflow uses) to s3.
     *
     * @param updatedHistoryEvents - The previous history plus task events minus any filtered events plus synthetic events.
     * @param commandEvents - events produced by the commands run.
     */
    async function updateHistory(updatedHistoryEvents: HistoryStateEvent[]) {
      console.debug(
        "New history to save",
        JSON.stringify(updatedHistoryEvents)
      );

      // update history from new commands and events
      // for now, we'll just write the awaitable command events to s3 as those are the ones needed to reconstruct the workflow.
      const { bytes: historyUpdatedBytes } = await timed(
        metrics,
        OrchestratorMetrics.SaveHistoryDuration,
        () =>
          workflowRuntimeClient.updateHistory({
            executionId,
            events: updatedHistoryEvents,
          })
      );

      metrics.setProperty(
        OrchestratorMetrics.SavedHistoryEvents,
        updatedHistoryEvents.length
      );
      metrics.putMetric(
        OrchestratorMetrics.SavedHistoryBytes,
        historyUpdatedBytes,
        Unit.Bytes
      );
    }

    async function persistWorkflowResult(
      resultEvent?: WorkflowSucceeded | WorkflowFailed
    ) {
      // if the workflow is complete, add success and failure to the commands.
      if (resultEvent) {
        if (isWorkflowFailed(resultEvent)) {
          const execution = await timed(
            metrics,
            OrchestratorMetrics.ExecutionStatusUpdateDuration,
            () =>
              workflowRuntimeClient.failExecution({
                executionId,
                error: resultEvent.error,
                message: resultEvent.message,
              })
          );

          logAgent.logWithContext(
            { executionId, type: LogContextType.Execution },
            "INFO",
            "Workflow Failed",
            `${resultEvent.error}: ${resultEvent.message}`
          );

          logExecutionCompleteMetrics(execution);
        } else if (isWorkflowSucceeded(resultEvent)) {
          const execution = await timed(
            metrics,
            OrchestratorMetrics.ExecutionStatusUpdateDuration,
            () =>
              workflowRuntimeClient.succeedExecution({
                executionId,
                result: resultEvent.output,
              })
          );

          logAgent.logWithContext(
            { executionId, type: LogContextType.Execution },
            "INFO",
            "Workflow Succeeded",
            resultEvent.output
          );

          logExecutionCompleteMetrics(execution);
        }
      }
    }

    /**
     * Generate events from commands and create a function which will start the commands.
     *
     * Does not actually write the commands out.
     */
    async function processCommands(
      workflow: Workflow,
      commands: Command[]
    ): Promise<HistoryStateEvent[]> {
      console.debug("Commands to send", JSON.stringify(commands));
      // register command events
      return await Promise.all(
        commands.map((command) =>
          commandExecutor.executeCommand(workflow, executionId, command, start)
        )
      );
    }

    function initializeMetrics() {
      const metrics = metricsClient.createMetricsLogger();
      metricsClient.createMetricsLogger();
      metrics.resetDimensions(false);
      metrics.setNamespace(MetricsCommon.EventualNamespace);
      metrics.setDimensions({
        [MetricsCommon.WorkflowNameDimension]: workflowName,
      });
      // number of events that came from the workflow task
      metrics.setProperty(OrchestratorMetrics.TaskEvents, events.length);
      // number of workflow tasks that are being processed in the batch (max: 10)
      metrics.setProperty(OrchestratorMetrics.AggregatedTasks, events.length);

      metrics.setProperty(OrchestratorMetrics.ExecutionId, executionId);
      metrics.setProperty(
        OrchestratorMetrics.Version,
        OrchestratorMetrics.VersionV1
      );
      return metrics;
    }

    function logExecutionCompleteMetrics(
      execution: SucceededExecution | FailedExecution
    ) {
      metrics.putMetric(
        OrchestratorMetrics.ExecutionComplete,
        execution.status === ExecutionStatus.SUCCEEDED ? 1 : 0,
        Unit.Count
      );
      metrics.putMetric(
        OrchestratorMetrics.ExecutionFailed,
        execution.status === ExecutionStatus.SUCCEEDED ? 0 : 1,
        Unit.Count
      );
      metrics.putMetric(
        OrchestratorMetrics.ExecutionTotalDuration,
        new Date(execution.endTime).getTime() -
          new Date(execution.startTime).getTime()
      );
      if (isSucceededExecution(execution)) {
        metrics.putMetric(
          OrchestratorMetrics.ExecutionResultBytes,
          execution.result ? JSON.stringify(execution.result).length : 0,
          Unit.Bytes
        );
      }
    }
  }
}

/** Logs metrics specific to the incoming events */
function logEventMetrics(
  metrics: MetricsLogger,
  events: WorkflowEvent[],
  now: Date
) {
  const sleepCompletedEvents = events.filter(isSleepCompleted);
  if (sleepCompletedEvents.length > 0) {
    const sleepCompletedVariance = sleepCompletedEvents.map(
      (s) => now.getTime() - new Date(s.timestamp).getTime()
    );
    const avg =
      sleepCompletedVariance.reduce((t, n) => t + n, 0) /
      sleepCompletedVariance.length;
    metrics.setProperty(OrchestratorMetrics.SleepVarianceMillis, avg);
  }
}
interface ProgressWorkflowResult extends WorkflowResult {
  history: HistoryStateEvent[];
}
