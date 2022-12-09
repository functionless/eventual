import { createActivityCall } from "./calls/activity-call.js";
import { callableActivities } from "./global.js";
import { isOrchestratorWorker } from "./runtime/flags.js";

export interface ActivityOptions {
  /**
   * How long the workflow will wait for the activity to complete or fail.
   *
   * @default - workflow will run forever.
   */
  timeoutSeconds?: number;
}

export interface ActivityFunction<F extends (...args: any[]) => any> {
  (...args: Parameters<F>): Promise<Awaited<ReturnType<F>>>;
}

/**
 * Registers a function as an Activity.
 *
 * @param activityID a string that uniquely identifies the Activity within a single workflow context.
 * @param handler the function that handles the activity
 */
export function activity<F extends (...args: any[]) => any>(
  activityID: string,
  handler: F
): ActivityFunction<F>;
export function activity<F extends (...args: any[]) => any>(
  activityID: string,
  options: ActivityOptions,
  handler: F
): ActivityFunction<F>;
export function activity<F extends (...args: any[]) => any>(
  activityID: string,
  ...args: [opts: ActivityOptions, handler: F] | [handler: F]
): ActivityFunction<F> {
  const [opts, handler] = args.length === 1 ? [undefined, args[0]] : args;
  if (isOrchestratorWorker()) {
    // if we're in the orchestrator, return a command to invoke the activity in the worker function
    return ((...args: Parameters<ActivityFunction<F>>) => {
      return createActivityCall(activityID, args, opts?.timeoutSeconds) as any;
    }) as ActivityFunction<F>;
  } else {
    // otherwise we must be in an activity, event or api handler
    // register the handler to be looked up during execution.
    callableActivities()[activityID] = handler;
    // calling the activity from outside the orchestrator just calls the handler
    return ((...args) => handler(...args)) as ActivityFunction<F>;
  }
}

/**
 * Retrieve an activity function that has been registered in a workflow.
 */
export function getCallableActivity(activityId: string): Function | undefined {
  return callableActivities()[activityId];
}

export function getCallableActivityNames() {
  return Object.keys(callableActivities());
}
