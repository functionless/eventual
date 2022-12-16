import { createWorkflowClient } from "../../../clients/index.js";
import { withErrorMiddleware } from "../middleware.js";
import { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { Execution } from "@eventual/core";

const workflowClient = createWorkflowClient({
  // TODO: further decouple the clients
  activityTableName: "NOT_NEEDED",
  workflowQueueUrl: "NOT_NEEDED",
});

async function list() {
  return workflowClient.getExecutions();
}

export const handler: APIGatewayProxyHandlerV2<Execution[]> =
  withErrorMiddleware(list);
