import type {
  ChildExecution,
  ExecutionHandle,
  ExecutionID,
} from "./execution.js";
import { createWorkflowCall } from "./internal/calls/workflow-call.js";
import { isChain } from "./internal/chain.js";
import type { Program } from "./internal/eventual.js";
import { isEventual } from "./internal/eventual.js";
import { isOrchestratorWorker } from "./internal/flags.js";
import { getServiceClient, workflows } from "./internal/global.js";
import { isDurationSchedule, isTimeSchedule } from "./internal/schedule.js";
import {
  HistoryStateEvent,
  isTimerCompleted,
  isTimerScheduled,
  TimerCompleted,
  TimerScheduled,
  WorkflowEventType,
} from "./internal/workflow-events.js";
import type { DurationSchedule } from "./schedule.js";
import { Schedule } from "./schedule.js";
import type { StartExecutionRequest } from "./service-client.js";

export interface WorkflowHandler<Input = any, Output = any> {
  (input: Input, context: WorkflowContext): Promise<Output> | Program<any>;
}

/**
 * Workflow options available when invoked by another workflow.
 */
export interface ChildWorkflowOptions {
  timeout?: Promise<any> | Schedule;
}

/**
 * Options which determine how an execution operates.
 *
 * Overrides those provided by the workflow definition.
 */
export interface WorkflowExecutionOptions {
  /**
   * Number of seconds before or a time to time the workflow out at.
   *
   * @default - workflow will never timeout.
   */
  timeout?: Schedule;
}

/**
 * Options which determine how a workflow operates.
 *
 * Can be provided at workflow definition time and/or overridden by the caller of {@link WorkflowClient.startWorkflow}.
 */
export interface WorkflowDefinitionOptions {
  /**
   * Number of seconds before execution times out.
   *
   * @default - workflow will never timeout.
   */
  timeout?: DurationSchedule;
}

export type WorkflowOutput<W extends Workflow> = W extends Workflow<
  any,
  infer Out
>
  ? Out
  : never;

export type WorkflowInput<W extends Workflow> = W extends Workflow<
  infer In,
  any
>
  ? In
  : undefined;

export type WorkflowArguments<Input = any> = [Input] extends [undefined]
  ? [input?: Input, options?: ChildWorkflowOptions]
  : [input: Input, options?: ChildWorkflowOptions];

/**
 * A {@link Workflow} is a long-running process that orchestrates calls
 * to other services in a durable and observable way.
 */
export interface Workflow<in Input = any, Output = any> {
  /**
   * Globally unique ID of this {@link Workflow}.
   */
  name: string;

  options?: WorkflowDefinitionOptions;

  /**
   * Invokes the {@link Workflow} from within another workflow.
   *
   * This can only be called from within another workflow because it's not possible
   * to wait for completion synchronously - it relies on the event-driven environment
   * of a workflow execution.
   *
   * To start a workflow from another environment, use {@link start}.
   */
  (...args: WorkflowArguments<Input>): Promise<Output> & ChildExecution;

  /**
   * Starts a workflow execution
   */
  startExecution(
    request: Omit<StartExecutionRequest<Workflow<Input, Output>>, "workflow">
  ): Promise<ExecutionHandle<Workflow<Input, Output>>>;
}

/**
 * Creates and registers a long-running workflow.
 *
 * Example:
 * ```ts
 * import { activity, workflow } from "@eventual/core";
 *
 * export default workflow("my-workflow", async ({ name }: { name: string }) => {
 *   const result = await hello(name);
 *   console.log(result);
 *   return `you said ${result}`;
 * });
 *
 * const hello = activity("hello", async (name: string) => {
 *   return `hello ${name}`;
 * });
 *
 * Logging using `console.info` (or similar) in a workflow will write logs to the
 * execution's log stream in the service's workflow.
 *
 * To see these logs run `eventual get logs -e <execution>` or find the log group using
 * `eventual show service`.
 * ```
 * @param name a globally unique ID for this workflow.
 * @param definition the workflow definition.
 */
export function workflow<Input = any, Output = any>(
  name: string,
  definition: WorkflowHandler<Input, Output>
): Workflow<Input, Output>;
export function workflow<Input = any, Output = any>(
  name: string,
  opts: WorkflowDefinitionOptions,
  definition: WorkflowHandler<Input, Output>
): Workflow<Input, Output>;
export function workflow<Input = any, Output = any>(
  name: string,
  ...args:
    | [
        opts: WorkflowDefinitionOptions,
        definition: WorkflowHandler<Input, Output>
      ]
    | [definition: WorkflowHandler<Input, Output>]
): Workflow<Input, Output> {
  const [opts, definition] = args.length === 1 ? [undefined, args[0]] : args;
  if (workflows().has(name)) {
    throw new Error(`workflow with name '${name}' already exists`);
  }

  const workflow: Workflow<Input, Output> = ((
    input?: any,
    options?: ChildWorkflowOptions
  ) => {
    if (!isOrchestratorWorker()) {
      throw new Error(
        "Direct workflow invocation is only valid in a workflow, use workflow.startExecution instead."
      );
    }

    // a timeout can either by from definition or a eventual/promise or both.
    // take the invocation time configuration first.
    const timeout = options?.timeout ?? opts?.timeout;
    if (
      timeout &&
      !(
        isEventual(timeout) ||
        isTimeSchedule(timeout) ||
        isDurationSchedule(timeout)
      )
    ) {
      throw new Error("Timeout promise must be an Eventual or a Schedule.");
    }

    return createWorkflowCall(
      name,
      input,
      // if the timeout is a time or a duration, from any source, send the timeout to the child execution
      // to time itself out.
      {
        timeout:
          isDurationSchedule(timeout) || isTimeSchedule(timeout)
            ? timeout
            : undefined,
      },
      // if an eventual/promise is given, even if it is a duration or a time, timeout based on the
      // promise resolution.
      // TODO: support reporting cancellation to children when the parent times out?
      isEventual(timeout) ? timeout : undefined
    );
  }) as any;

  Object.defineProperty(workflow, "name", { value: name, writable: false });

  workflow.startExecution = async function (input) {
    const serviceClient = getServiceClient();
    return await serviceClient.startExecution<Workflow<Input, Output>>({
      workflow: name,
      executionName: input.executionName,
      input: input.input,
      timeout: input.timeout,
      ...opts,
    });
  };

  // @ts-ignore
  workflow.definition = isChain(definition)
    ? definition
    : function* (input: Input, context: WorkflowContext): any {
        return yield definition(input, context);
      }; // This type is added in the core-runtime package declaration.

  workflows().set(name, workflow);
  return workflow;
}

/**
 * Generates synthetic events, for example, {@link TimerCompleted} events when the time has passed, but a real completed event has not come in yet.
 */
export function generateSyntheticEvents(
  events: HistoryStateEvent[],
  baseTime: Date
): TimerCompleted[] {
  const unresolvedTimers: Record<number, TimerScheduled> = {};

  const timerEvents = events.filter(
    (event): event is TimerScheduled | TimerCompleted =>
      isTimerScheduled(event) || isTimerCompleted(event)
  );

  for (const event of timerEvents) {
    if (isTimerScheduled(event)) {
      unresolvedTimers[event.seq] = event;
    } else {
      delete unresolvedTimers[event.seq];
    }
  }

  const syntheticTimerComplete: TimerCompleted[] = Object.values(
    unresolvedTimers
  )
    .filter(
      (event) => new Date(event.untilTime).getTime() <= baseTime.getTime()
    )
    .map(
      (e) =>
        ({
          type: WorkflowEventType.TimerCompleted,
          seq: e.seq,
          timestamp: baseTime.toISOString(),
        } satisfies TimerCompleted)
    );

  return syntheticTimerComplete;
}

/**
 * Context values related to the current execution of the workflow.
 */
export interface WorkflowExecutionContext {
  /**
   * Computed, Unique ID of the execution.
   */
  id: ExecutionID;
  /**
   * Unique name of the execution, optionally provided in the startWorkflow call.
   */
  name: string;
  /**
   * ID of the parent execution if this is a child workflow
   */
  parentId?: ExecutionID;
  /**
   * The ISO 8601 UTC time the execution started.
   */
  startTime: string;
}

/**
 * Context values related to the workflow definition.
 */
export interface WorkflowDefinitionContext {
  /**
   * The name of the workflow.
   */
  name: string;
}

/**
 * Context values provided to each workflow execution.
 */
export interface WorkflowContext {
  /**
   * Context values related to the current execution of the workflow.
   */
  workflow: WorkflowDefinitionContext;
  /**
   * Context values related to the workflow definition.
   */
  execution: WorkflowExecutionContext;
}
