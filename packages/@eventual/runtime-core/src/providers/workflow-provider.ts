import { Workflow, workflows } from "@eventual/core";

export interface WorkflowProvider {
  lookupWorkflow(workflowName: string): Workflow | undefined;
}

/**
 * Returns workflows from the global {@link workflows()}.
 *
 * Note: the service entry point is required to access {@link workflows()}.
 */
export class GlobalWorkflowProvider implements WorkflowProvider {
  public lookupWorkflow(workflowName: string): Workflow | undefined {
    return workflows().get(workflowName);
  }
}