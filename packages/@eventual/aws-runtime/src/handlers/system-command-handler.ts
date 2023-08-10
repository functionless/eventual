import serviceSpec from "@eventual/injected/spec";

import type { AnyCommand } from "@eventual/core";
import {
  createEmitEventsCommand,
  createExecuteTransactionCommand,
  createGetExecutionCommand,
  createListExecutionHistoryCommand,
  createListExecutionsCommand,
  createListWorkflowHistoryCommand,
  createListWorkflowsCommand,
  createSendSignalCommand,
  createStartExecutionCommand,
  createUpdateTaskCommand,
  ServiceSpecWorkflowProvider,
} from "@eventual/core-runtime";
import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import {
  createBucketStore,
  createEventClient,
  createExecutionHistoryStateStore,
  createExecutionHistoryStore,
  createExecutionQueueClient,
  createExecutionStore,
  createQueueClient,
  createTaskClient,
  createTransactionClient,
  createWorkflowClient,
} from "../create.js";
import { serviceName } from "../env.js";
import { createApiGCommandWorker } from "./apig-command-worker.js";

function systemCommandWorker(
  ..._commands: AnyCommand[]
): APIGatewayProxyHandlerV2<Response> {
  return createApiGCommandWorker({
    bucketStore: createBucketStore(),
    queueClient: createQueueClient(),
    entityStore: undefined,
    openSearchClient: undefined,
    serviceSpec,
    serviceName,
  });
}

const workflowProvider = new ServiceSpecWorkflowProvider(serviceSpec);
const workflowClient = createWorkflowClient({
  workflowProvider,
});
const executionStore = createExecutionStore();

export default systemCommandWorker(
  createListExecutionHistoryCommand({
    executionHistoryStore: createExecutionHistoryStore(),
  }),
  createListWorkflowHistoryCommand({
    executionHistoryStateStore: createExecutionHistoryStateStore(),
  }),
  createGetExecutionCommand({ executionStore }),
  createListExecutionsCommand({
    executionStore,
  }),
  createListWorkflowsCommand({
    workflowProvider,
  }),
  createEmitEventsCommand({
    eventClient: createEventClient(),
  }),
  createSendSignalCommand({
    executionQueueClient: createExecutionQueueClient(),
  }),
  createStartExecutionCommand({
    workflowClient,
  }),
  createUpdateTaskCommand({ taskClient: createTaskClient() }),
  createExecuteTransactionCommand({
    transactionClient: createTransactionClient(),
  })
);
