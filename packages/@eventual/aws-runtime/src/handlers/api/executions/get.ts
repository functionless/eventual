import { createExecutionStore } from "../../../clients/create.js";
import { withErrorMiddleware } from "../middleware.js";
import { APIGatewayProxyEventV2, APIGatewayProxyHandlerV2 } from "aws-lambda";
import { decodeExecutionId, Execution } from "@eventual/core";

const executionStore = createExecutionStore();

async function get(event: APIGatewayProxyEventV2) {
  const executionId = event.pathParameters?.executionId;
  if (!executionId) {
    return { statusCode: 400, body: `Missing executionId` };
  }

  const decodedExecutionId = decodeExecutionId(executionId);
  const execution = await executionStore.get(decodedExecutionId);
  if (execution) {
    return execution;
  }
  return {
    statusCode: 404,
    body: `Execution ${decodedExecutionId} not found.`,
  };
}

export const handler: APIGatewayProxyHandlerV2<Execution> =
  withErrorMiddleware(get);
