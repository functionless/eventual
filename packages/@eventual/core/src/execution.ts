import { WorkflowClient } from "./runtime/clients/workflow-client.js";
import { Signal, SendSignalProps, SignalPayload } from "./signals.js";
import { Workflow, WorkflowOutput } from "./workflow.js";

export enum ExecutionStatus {
  IN_PROGRESS = "IN_PROGRESS",
  COMPLETE = "COMPLETE",
  FAILED = "FAILED",
}

interface ExecutionBase {
  id: string;
  status: ExecutionStatus;
  startTime: string;
  workflowName: string;
  parent?: {
    /**
     * Seq number when this execution is the child of another workflow.
     */
    seq: number;
    /**
     * Id of the parent workflow, while present.
     */
    executionId: string;
  };
}

export type Execution<Result = any> =
  | InProgressExecution
  | CompleteExecution<Result>
  | FailedExecution;

export interface InProgressExecution extends ExecutionBase {
  status: ExecutionStatus.IN_PROGRESS;
}

export interface CompleteExecution<Result = any> extends ExecutionBase {
  status: ExecutionStatus.COMPLETE;
  endTime: string;
  result?: Result;
}

export interface FailedExecution extends ExecutionBase {
  status: ExecutionStatus.FAILED;
  endTime: string;
  error: string;
  message: string;
}

export function isFailedExecution(
  execution: Execution
): execution is FailedExecution {
  return execution.status === ExecutionStatus.FAILED;
}

export function isCompleteExecution(
  execution: Execution
): execution is CompleteExecution {
  return execution.status === ExecutionStatus.COMPLETE;
}

/**
 * A reference to a running execution.
 */
export class ExecutionHandle<W extends Workflow<any, any>> {
  constructor(
    public executionId: string,
    private workflowClient: WorkflowClient
  ) {}

  /**
   * @return the {@link Execution} with the status, result, error, and other data based on the current status.
   */
  public async getStatus(): Promise<Execution<WorkflowOutput<W>>> {
    return (await this.workflowClient.getExecution(
      this.executionId
    )) as Execution<WorkflowOutput<W>>;
  }

  /**
   * Send a {@link signal} to this execution.
   */
  public async signal<Payload = any>(
    signal: string | Signal<Payload>,
    payload: Payload
  ): Promise<void> {
    return this.workflowClient.sendSignal({
      executionId: this.executionId,
      signal: typeof signal === "string" ? signal : signal.id,
      payload,
    });
  }
}

/**
 * A reference to an execution started by another workflow.
 */
export interface ChildExecution {
  /**
   * Allows a {@link workflow} to send a signal to the workflow {@link Execution}.
   *
   * ```ts
   * const mySignal = signal<string>("MySignal");
   * const childWf = workflow(...);
   * workflow("wf", async () => {
   *    const child = childWf();
   *    child.signal(mySignal);
   *    await child;
   * })
   * ```
   *
   * @param id an optional, execution unique ID, will be used to de-dupe the signal at the target execution.
   */
  signal<S extends Signal<any>>(
    signal: S,
    ...args: SendSignalProps<SignalPayload<S>>
  ): Promise<void>;
}
