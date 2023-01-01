// the user's entry point will register activities as a side effect.
import "@eventual/entry/injected";

import {
  ActivityWorkerRequest,
  createActivityWorker,
  GlobalActivityProvider,
} from "@eventual/core";
import middy from "@middy/core";
import {
  createActivityRuntimeClient,
  createEventClient,
  createServiceClient,
  createTimerClient,
  createWorkflowClient,
  createWorkflowRuntimeClient,
} from "../clients/create.js";
import { AWSMetricsClient } from "../clients/metrics-client.js";
import { logger, loggerMiddlewares } from "../logger.js";

export default middy<ActivityWorkerRequest>((request) =>
  createActivityWorker({
    activityRuntimeClient: createActivityRuntimeClient(),
    eventClient: createEventClient(),
    workflowClient: createWorkflowClient(),
    timerClient: createTimerClient(),
    metricsClient: AWSMetricsClient,
    logger,
    activityProvider: new GlobalActivityProvider(),
    serviceClient: createServiceClient(
      createWorkflowRuntimeClient({
        executionHistoryBucket: "NOT_NEEDED",
        activityWorkerFunctionName: "NOT_NEEDED",
        tableName: "NOT_NEEDED",
      })
    ),
  })(request, new Date())
).use(loggerMiddlewares);
