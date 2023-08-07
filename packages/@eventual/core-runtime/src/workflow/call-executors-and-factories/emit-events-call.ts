import {
  Result,
  WorkflowCallHistoryType,
  type EmitEventsCall,
} from "@eventual/core/internal";
import type { EventualFactory } from "../call-eventual-factory.js";
import type { EventualDefinition } from "../eventual-definition.js";

/**
 * Create a event for the {@link EmitEventsCall} and return undefined.
 *
 * Emit Events uses the {@link SimpleWorkflowExecutorAdaptor}.
 */
export class EmitEventsCallEventualFactory
  implements EventualFactory<EmitEventsCall>
{
  public createEventualDefinition(
    call: EmitEventsCall
  ): EventualDefinition<void> {
    return {
      createCallEvent: (seq) => ({
        type: WorkflowCallHistoryType.EventsEmitted,
        events: call.events,
        seq,
      }),
      result: Result.resolved(undefined),
    };
  }
}
