import {
  workflows,
  clearEventualCollector,
  getServiceClient,
} from "./global.js";
import type { Program } from "./interpret.js";
import type { Context, WorkflowContext } from "./context.js";
import { DeterminismError } from "./error.js";
import {
  filterEvents,
  HistoryStateEvent,
  isHistoryEvent,
  isSleepCompleted,
  isSleepScheduled,
  isWorkflowStarted,
  SleepCompleted,
  SleepScheduled,
  WorkflowEventType,
} from "./workflow-events.js";
import { interpret, WorkflowResult } from "./interpret.js";
import { createWorkflowCall } from "./calls/workflow-call.js";
import { AwaitedEventual } from "./eventual.js";
import { isOrchestratorWorker } from "./runtime/flags.js";
import { isChain } from "./chain.js";
import { ChildExecution, ExecutionHandle } from "./execution.js";
import { StartExecutionRequest } from "./service-client.js";

export type WorkflowHandler<Input = any, Output = any> = (
  input: Input,
  context: Context
) => Promise<Output> | Program<Output>;

/**
 * Options which determine how a workflow operates.
 *
 * Can be provided at workflow definition time and/or overridden by the caller of {@link WorkflowClient.startWorkflow}.
 */
export interface WorkflowOptions {
  /**
   * Number of seconds before execution times out.
   *
   * @default - workflow will never timeout.
   */
  timeoutSeconds?: number;
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

/**
 * A {@link Workflow} is a long-running process that orchestrates calls
 * to other services in a durable and observable way.
 */
export interface Workflow<in Input = any, Output = any> {
  /**
   * Globally unique ID of this {@link Workflow}.
   */
  workflowName: string;

  options?: WorkflowOptions;

  /**
   * Invokes the {@link Workflow} from within another workflow.
   *
   * This can only be called from within another workflow because it's not possible
   * to wait for completion synchronously - it relies on the event-driven environment
   * of a workflow execution.
   *
   * To start a workflow from another environment, use {@link start}.
   */
  (input: Input): Promise<Output> & ChildExecution;

  /**
   * Starts a workflow execution
   */
  startExecution(
    request: Omit<StartExecutionRequest<Workflow<Input, Output>>, "workflow">
  ): Promise<ExecutionHandle<Workflow<Input, Output>>>;

  /**
   * @internal - this is the internal DSL representation that produces a {@link Program} instead of a Promise.
   */
  definition: (
    input: Input,
    context: Context
  ) => Program<AwaitedEventual<Output>>;
}

export function lookupWorkflow(name: string): Workflow | undefined {
  return workflows().get(name);
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
  opts: WorkflowOptions,
  definition: WorkflowHandler<Input, Output>
): Workflow<Input, Output>;
export function workflow<Input = any, Output = any>(
  name: string,
  ...args:
    | [opts: WorkflowOptions, definition: WorkflowHandler<Input, Output>]
    | [definition: WorkflowHandler<Input, Output>]
): Workflow<Input, Output> {
  const [opts, definition] = args.length === 1 ? [undefined, args[0]] : args;
  if (workflows().has(name)) {
    throw new Error(`workflow with name '${name}' already exists`);
  }

  const workflow: Workflow<Input, Output> = ((input?: any) => {
    if (!isOrchestratorWorker()) {
      throw new Error(
        "Direct workflow invocation is only valid in a workflow, use workflow.startExecution instead."
      );
    }

    return createWorkflowCall(name, input, opts);
  }) as any;

  workflow.workflowName = name;

  workflow.startExecution = async function (input) {
    const serviceClient = getServiceClient();
    return await serviceClient.startExecution<Workflow<Input, Output>>({
      workflow: name,
      executionName: input.executionName,
      input: input.input,
      timeoutSeconds: input.timeoutSeconds,
      ...opts,
    });
  };

  workflow.definition = (
    isChain(definition)
      ? definition
      : function* (input, context): any {
          return yield definition(input, context);
        }
  ) as Workflow<Input, Output>["definition"]; // safe to cast because we rely on transformer (it is always the generator API)
  workflows().set(name, workflow);
  return workflow;
}

export interface ProgressWorkflowResult extends WorkflowResult {
  history: HistoryStateEvent[];
}

/**
 * Advance a workflow using previous history, new events, and a program.
 */
export function progressWorkflow(
  program: Workflow,
  historyEvents: HistoryStateEvent[],
  taskEvents: HistoryStateEvent[],
  workflowContext: WorkflowContext,
  executionId: string,
  baseTime: Date = new Date()
): ProgressWorkflowResult {
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
    workflow: workflowContext,
    execution: {
      ...startEvent.context,
      id: executionId,
      startTime: startEvent.timestamp,
    },
  };

  // execute workflow
  const interpretEvents = allEvents.filter(isHistoryEvent);

  console.debug("history events", JSON.stringify(historyEvents));
  console.debug("task events", JSON.stringify(taskEvents));
  console.debug("synthetic events", JSON.stringify(syntheticEvents));
  console.debug("interpret events", JSON.stringify(interpretEvents));

  try {
    return {
      ...interpret(
        program.definition(startEvent.input, context),
        interpretEvents
      ),
      history: allEvents,
    };
  } catch (err) {
    // temporary fix when the interpreter fails, but the activities are not cleared.
    clearEventualCollector();
    throw err;
  }
}

/**
 * Generates synthetic events, for example, {@link SleepCompleted} events when the time has passed, but a real completed event has not come in yet.
 */
export function generateSyntheticEvents(
  events: HistoryStateEvent[],
  baseTime: Date
): SleepCompleted[] {
  const unresolvedSleep: Record<number, SleepScheduled> = {};

  const sleepEvents = events.filter(
    (event): event is SleepScheduled | SleepCompleted =>
      isSleepScheduled(event) || isSleepCompleted(event)
  );

  for (const event of sleepEvents) {
    if (isSleepScheduled(event)) {
      unresolvedSleep[event.seq] = event;
    } else {
      delete unresolvedSleep[event.seq];
    }
  }

  const syntheticSleepComplete: SleepCompleted[] = Object.values(
    unresolvedSleep
  )
    .filter(
      (event) => new Date(event.untilTime).getTime() <= baseTime.getTime()
    )
    .map(
      (e) =>
        ({
          type: WorkflowEventType.SleepCompleted,
          seq: e.seq,
          timestamp: baseTime.toISOString(),
        } satisfies SleepCompleted)
    );

  return syntheticSleepComplete;
}
