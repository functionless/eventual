import { ulid } from "ulidx";
import { inspect } from "util";
import { ExecutionAlreadyExists } from "../../error.js";
import {
  ExecutionStatus,
  FailedExecution,
  InProgressExecution,
  SucceededExecution,
} from "../../execution.js";
import { computeScheduleDate } from "../../schedule.js";
import {
  StartExecutionRequest,
  StartExecutionResponse,
} from "../../service-client.js";
import { hashCode } from "../../util.js";
import {
  createEvent,
  WorkflowEventType,
  WorkflowStarted,
} from "../../workflow-events.js";
import { lookupWorkflow, Workflow, WorkflowOptions } from "../../workflow.js";
import { formatExecutionId } from "../execution-id.js";
import {
  ExecutionStore,
  FailExecutionRequest,
  SucceedExecutionRequest,
} from "../stores/execution-store.js";
import { ExecutionQueueClient } from "./execution-queue-client.js";
import { LogsClient } from "./logs-client.js";

export class WorkflowClient {
  constructor(
    private executionStore: ExecutionStore,
    private logsClient: LogsClient,
    private executionQueueClient: ExecutionQueueClient,
    protected baseTime: () => Date = () => new Date()
  ) {}

  /**
   * Start a workflow execution
   *
   * NOTE: the service entry point is required to access {@link workflows()}.
   *
   * @param name Suffix of execution id
   * @param input Workflow parameters
   */
  public async startExecution<W extends Workflow = Workflow>({
    executionName = ulid(),
    workflow,
    input,
    timeout,
    ...request
  }:
    | StartExecutionRequest<W>
    | StartChildExecutionRequest<W>): Promise<StartExecutionResponse> {
    if (typeof workflow === "string" && !lookupWorkflow(workflow)) {
      throw new Error(`Workflow ${workflow} does not exist in the service.`);
    }

    const workflowName =
      typeof workflow === "string" ? workflow : workflow.workflowName;
    const executionId = formatExecutionId(workflowName, executionName);
    const inputHash =
      input !== undefined
        ? hashCode(JSON.stringify(input)).toString(16)
        : undefined;
    console.debug("execution input:", input);
    console.debug("execution input hash:", inputHash);

    const execution: InProgressExecution = {
      id: executionId,
      startTime: this.baseTime().toISOString(),
      workflowName,
      status: ExecutionStatus.IN_PROGRESS,
      inputHash,
      parent:
        "parentExecutionId" in request
          ? { executionId: request.parentExecutionId, seq: request.seq }
          : undefined,
    };

    try {
      try {
        // try to create first as it may throw ExecutionAlreadyExists
        await this.executionStore.create(execution);
      } catch (err) {
        if (err instanceof ExecutionAlreadyExists) {
          const execution = await this.executionStore.get(executionId);
          if (execution?.inputHash === inputHash) {
            return { executionId, alreadyRunning: true };
          } else {
            throw new Error(
              `Execution name ${executionName} already exists for workflow ${workflowName} with different inputs.`
            );
          }
        }
        // rethrow to the top catch
        throw err;
      }

      // create the log
      await this.logsClient.initializeExecutionLog(executionId);

      const workflowStartedEvent = createEvent<WorkflowStarted>(
        {
          type: WorkflowEventType.WorkflowStarted,
          input,
          workflowName,
          // generate the time for the workflow to timeout based on when it was started.
          // the timer will be started by the orchestrator so the client does not need to have access to the timer client.
          timeoutTime: timeout
            ? computeScheduleDate(timeout, this.baseTime()).toISOString()
            : undefined,
          context: {
            name: executionName,
            parentId: execution.parent
              ? execution.parent.executionId
              : undefined,
          },
        },
        this.baseTime()
      );

      await Promise.all([
        // send the first event
        this.executionQueueClient.submitExecutionEvents(
          executionId,
          workflowStartedEvent
        ),
        // send the first log message and warm up the log stream
        this.logsClient.putExecutionLogs(executionId, {
          time: this.baseTime().getTime(),
          message: "Workflow Started",
        }),
      ]);

      return { executionId, alreadyRunning: false };
    } catch (err) {
      console.log(err);
      throw new Error(
        "Something went wrong starting a workflow: " + inspect(err)
      );
    }
  }

  public async succeedExecution(
    request: SucceedExecutionRequest
  ): Promise<SucceededExecution> {
    const execution = await this.executionStore.update(request);
    if (execution.parent) {
      await this.reportCompletionToParent(
        execution.parent.executionId,
        execution.parent.seq,
        request.result
      );
    }

    return execution as SucceededExecution;
  }

  public async failExecution(
    request: FailExecutionRequest
  ): Promise<FailedExecution> {
    const execution = await this.executionStore.update(request);
    if (execution.parent) {
      await this.reportCompletionToParent(
        execution.parent.executionId,
        execution.parent.seq,
        request.error,
        request.message
      );
    }

    return execution as FailedExecution;
  }

  private async reportCompletionToParent(
    parentExecutionId: string,
    seq: number,
    ...args: [result: any] | [error: string, message: string]
  ) {
    await this.executionQueueClient.submitExecutionEvents(parentExecutionId, {
      seq,
      timestamp: new Date().toISOString(),
      ...(args.length === 1
        ? {
            type: WorkflowEventType.ChildWorkflowSucceeded,
            result: args[0],
          }
        : {
            type: WorkflowEventType.ChildWorkflowFailed,
            error: args[0],
            message: args[1],
          }),
    });
  }
}

export interface StartChildExecutionRequest<W extends Workflow = Workflow>
  extends StartExecutionRequest<W>,
    WorkflowOptions {
  parentExecutionId: string;
  /**
   * Sequence ID of this execution if this is a child workflow
   */
  seq: number;
}
