import { isAsyncResult } from "../../activity.js";
import { ScheduleActivityCommand } from "../../command.js";
import {
  ActivitySucceeded,
  ActivityFailed,
  createEvent,
  isWorkflowFailed,
  WorkflowEventType,
} from "../../workflow-events.js";
import {
  clearActivityContext,
  registerServiceClient,
  setActivityContext,
} from "../../global.js";
import { createActivityToken } from "../activity-token.js";
import { ActivityRuntimeClient } from "../clients/activity-runtime-client.js";
import { MetricsClient } from "../clients/metrics-client.js";
import { WorkflowClient } from "../clients/workflow-client.js";
import {
  LogAgent,
  LogContextType,
  RuntimeServiceClient,
  Schedule,
  TimerClient,
  TimerRequestType,
} from "../index.js";
import { Logger } from "../logger.js";
import { ActivityMetrics, MetricsCommon } from "../metrics/constants.js";
import { Unit } from "../metrics/unit.js";
import { timed } from "../metrics/utils.js";
import type { EventClient } from "../index.js";
import { ActivityProvider } from "../providers/activity-provider.js";
import { ActivityNotFoundError } from "../../error.js";
import { extendsError } from "../../util.js";

export interface CreateActivityWorkerProps {
  activityRuntimeClient: ActivityRuntimeClient;
  workflowClient: WorkflowClient;
  timerClient: TimerClient;
  metricsClient: MetricsClient;
  logger: Logger;
  eventClient: EventClient;
  activityProvider: ActivityProvider;
  serviceClient?: RuntimeServiceClient;
  logAgent: LogAgent;
}

export interface ActivityWorkerRequest {
  scheduledTime: string;
  workflowName: string;
  executionId: string;
  command: ScheduleActivityCommand;
  retry: number;
}

export interface ActivityWorker {
  (
    request: ActivityWorkerRequest,
    baseTime: Date,
    /**
     * Allows for a computed end time, for case like the test environment when the end time should be controlled.
     */
    getEndTime?: (startTime: Date) => Date
  ): Promise<void>;
}

/**
 * Creates a generic function for handling activity worker requests
 * that can be used in runtime implementations. This implementation is
 * decoupled from a runtime's specifics by the clients. A runtime must
 * inject its own client implementations designed for that platform.
 */
export function createActivityWorker({
  activityRuntimeClient,
  workflowClient,
  timerClient,
  metricsClient,
  logger,
  activityProvider,
  serviceClient,
  logAgent,
}: CreateActivityWorkerProps): ActivityWorker {
  // make the service client available to all activity code
  if (serviceClient) {
    registerServiceClient(serviceClient);
  }

  return metricsClient.metricScope(
    (metrics) =>
      async (
        request: ActivityWorkerRequest,
        baseTime: Date,
        getEndTime = () => new Date()
      ) => {
        logger.addPersistentLogAttributes({
          workflowName: request.workflowName,
          executionId: request.executionId,
        });
        const activityHandle = `${request.command.seq} for execution ${request.executionId} on retry ${request.retry}`;
        metrics.resetDimensions(false);
        metrics.setNamespace(MetricsCommon.EventualNamespace);
        metrics.putDimensions({
          ActivityName: request.command.name,
          WorkflowName: request.workflowName,
        });
        // the time from the workflow emitting the activity scheduled command
        // to the request being seen.
        const start = baseTime;
        const recordAge =
          start.getTime() - new Date(request.scheduledTime).getTime();
        metrics.putMetric(
          ActivityMetrics.ActivityRequestAge,
          recordAge,
          Unit.Milliseconds
        );
        if (
          !(await timed(metrics, ActivityMetrics.ClaimDuration, () =>
            activityRuntimeClient.claimActivity(
              request.executionId,
              request.command.seq,
              request.retry
            )
          ))
        ) {
          metrics.putMetric(ActivityMetrics.ClaimRejected, 1, Unit.Count);
          logger.info(`Activity ${activityHandle} already claimed.`);
          return;
        }
        if (request.command.heartbeatSeconds) {
          await timerClient.startTimer({
            activitySeq: request.command.seq,
            type: TimerRequestType.ActivityHeartbeatMonitor,
            executionId: request.executionId,
            heartbeatSeconds: request.command.heartbeatSeconds,
            schedule: Schedule.relative(request.command.heartbeatSeconds),
          });
        }
        setActivityContext({
          activityToken: createActivityToken(
            request.executionId,
            request.command.seq
          ),
          executionId: request.executionId,
          scheduledTime: request.scheduledTime,
          workflowName: request.workflowName,
        });
        metrics.putMetric(ActivityMetrics.ClaimRejected, 0, Unit.Count);

        logger.info(`Processing ${activityHandle}.`);

        const activity = activityProvider.getActivityHandler(
          request.command.name
        );
        try {
          if (!activity) {
            metrics.putMetric(ActivityMetrics.NotFoundError, 1, Unit.Count);
            throw new ActivityNotFoundError(
              request.command.name,
              activityProvider.getActivityIds()
            );
          }

          const result = await logAgent.logContextScope(
            {
              type: LogContextType.Activity,
              activityName: request.command.name,
              executionId: request.executionId,
              seq: request.command.seq,
            },
            async () => {
              return await timed(
                metrics,
                ActivityMetrics.OperationDuration,
                () => activity(...request.command.args)
              );
            }
          );

          if (isAsyncResult(result)) {
            metrics.setProperty(ActivityMetrics.HasResult, 0);
            metrics.setProperty(ActivityMetrics.AsyncResult, 1);

            // TODO: Send heartbeat on sync activity completion.

            /**
             * The activity has declared that it is async, other than logging, there is nothing left to do here.
             * The activity should call {@link WorkflowClient.sendActivitySuccess} or {@link WorkflowClient.sendActivityFailure} when it is done.
             */
            return logAgent.flush();
          } else if (result) {
            metrics.setProperty(ActivityMetrics.HasResult, 1);
            metrics.setProperty(ActivityMetrics.AsyncResult, 0);
            metrics.putMetric(
              ActivityMetrics.ResultBytes,
              JSON.stringify(result).length,
              Unit.Bytes
            );
          } else {
            metrics.setProperty(ActivityMetrics.HasResult, 0);
            metrics.setProperty(ActivityMetrics.AsyncResult, 0);
          }

          logger.info(
            `Activity ${activityHandle} succeeded, reporting back to execution.`
          );

          const endTime = getEndTime(start);
          const event = createEvent<ActivitySucceeded>(
            {
              type: WorkflowEventType.ActivitySucceeded,
              seq: request.command.seq,
              result,
            },
            endTime
          );

          await finishActivity(
            event,
            recordAge + (endTime.getTime() - start.getTime())
          );
        } catch (err) {
          const [error, message] = extendsError(err)
            ? [err.name, err.message]
            : ["Error", JSON.stringify(err)];

          logger.info(
            `Activity ${activityHandle} failed, reporting failure back to execution: ${error}: ${message}`
          );

          const endTime = getEndTime(start);
          const event = createEvent<ActivityFailed>(
            {
              type: WorkflowEventType.ActivityFailed,
              seq: request.command.seq,
              error,
              message,
            },
            endTime
          );

          await finishActivity(
            event,
            recordAge + (endTime.getTime() - start.getTime())
          );
        } finally {
          clearActivityContext();
        }

        function logActivityCompleteMetrics(failed: boolean, duration: number) {
          metrics.putMetric(
            ActivityMetrics.ActivityFailed,
            failed ? 1 : 0,
            Unit.Count
          );
          metrics.putMetric(
            ActivityMetrics.ActivitySucceeded,
            failed ? 0 : 1,
            Unit.Count
          );
          // The total time from the activity being scheduled until it's result is send to the workflow.
          metrics.putMetric(ActivityMetrics.TotalDuration, duration);
        }

        async function finishActivity(
          event: ActivitySucceeded | ActivityFailed,
          duration: number
        ) {
          const logFlush = timed(
            metrics,
            ActivityMetrics.ActivityLogWriteDuration,
            () => logAgent.flush()
          );
          await timed(metrics, ActivityMetrics.SubmitWorkflowTaskDuration, () =>
            workflowClient.submitWorkflowTask(request.executionId, event)
          );
          await logFlush;

          logActivityCompleteMetrics(isWorkflowFailed(event), duration);
        }
      }
  );
}
