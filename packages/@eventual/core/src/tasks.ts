import { HistoryStateEvent, WorkflowEvent } from "./workflow-events.js";

/**
 * A task which delivers new {@link WorkflowEvent}s to a workflow execution.
 *
 * May cause the workflow execution to progress, generating more commands and events.
 */
export interface WorkflowTask {
  executionId: string;
  events: HistoryStateEvent[];
}

export function isWorkflowTask(obj: any): obj is WorkflowTask {
  return "events" in obj && "executionId" in obj;
}
