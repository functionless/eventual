import { createWorkflowClient } from "@eventual/aws-runtime";

const workflowClient = createWorkflowClient({
  activityTableName: "NOT_NEEDED",
});

export async function handle(input: { name: string; executions: number }) {
  await Promise.all(
    Array.from(Array(input.executions)).map(async (_, i) => {
      workflowClient.startWorkflow({
        workflowName: "bench",
        executionName: `${input.name}-${i}`,
      });
    })
  );
}