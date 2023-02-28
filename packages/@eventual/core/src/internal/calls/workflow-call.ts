import { ChildExecution } from "../../execution.js";
import { SignalTargetType } from "../signal.js";
import { Workflow, WorkflowExecutionOptions } from "../../workflow.js";
import {
  createEventual,
  Eventual,
  EventualBase,
  EventualKind,
  isEventualOfKind,
} from "../eventual.js";
import { registerEventual } from "../global.js";
import { Result } from "../result.js";
import { createSendSignalCall } from "./send-signal-call.js";

export function isWorkflowCall<T>(a: Eventual<T>): a is WorkflowCall<T> {
  return isEventualOfKind(EventualKind.WorkflowCall, a);
}

/**
 * An {@link Eventual} representing an awaited call to a {@link Workflow}.
 */
export interface WorkflowCall<T = any>
  extends EventualBase<EventualKind.WorkflowCall, Result<T>>,
    ChildExecution {
  name: string;
  input?: any;
  seq?: number;
  opts?: WorkflowExecutionOptions;
  /**
   * An Eventual/Promise that determines when a child workflow should timeout.
   *
   * This timeout is separate from the timeout passed to the workflow (opts.timeout), which can only be a relative duration.
   *
   * TODO: support cancellation of child workflow.
   */
  timeout: Eventual<any>;
}

export function createWorkflowCall(
  name: string,
  input?: any,
  opts?: WorkflowExecutionOptions,
  timeout?: Eventual<any>
): WorkflowCall {
  const call = registerEventual(
    createEventual<WorkflowCall>(EventualKind.WorkflowCall, {
      input,
      name,
      opts,
      timeout,
    } as WorkflowCall)
  );

  // create a reference to the child workflow started at a sequence in this execution.
  // this reference will be resolved by the runtime.
  call.sendSignal = function (signal, payload?) {
    const signalId = typeof signal === "string" ? signal : signal.id;
    return createSendSignalCall(
      {
        type: SignalTargetType.ChildExecution,
        seq: call.seq!,
        workflowName: call.name,
      },
      signalId,
      payload
    ) as unknown as any;
  };

  return call;
}
