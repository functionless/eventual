import type { EntityStreamContext, EntityStreamItem } from "@eventual/core";
import { ServiceType, getEventualResource } from "@eventual/core/internal";
import { getLazy, promiseAllSettledPartitioned } from "../utils.js";
import { createEventualWorker, type WorkerIntrinsicDeps } from "./worker.js";

export interface EntityStreamWorker {
  (
    entityName: string,
    streamName: string,
    items: EntityStreamItem<any>[]
  ): Promise<{
    failedItemIds: string[];
  }>;
}

type EntityStreamWorkerDependencies = WorkerIntrinsicDeps;

export function createEntityStreamWorker(
  dependencies: EntityStreamWorkerDependencies
): EntityStreamWorker {
  return createEventualWorker(
    { serviceType: ServiceType.EntityStreamWorker, ...dependencies },
    async (entityName, streamName, items) => {
      const streamHandler = getEventualResource(
        "Entity",
        entityName
      )?.streams.find((s) => s.name === streamName);

      if (!streamHandler) {
        throw new Error(`Stream handler ${streamName} does not exist`);
      }

      const context: EntityStreamContext = {
        stream: { entityName, streamName },
        service: {
          serviceName: getLazy(dependencies.serviceName),
          serviceUrl: getLazy(dependencies.serviceUrl),
        },
      };

      if (streamHandler.kind === "EntityBatchStream") {
        const result = await streamHandler.handler(items, context);

        return { failedItemIds: result?.failedItemIds ?? [] };
      } else {
        const results = await promiseAllSettledPartitioned(
          items,
          async (item) => {
            return await streamHandler.handler(item, context);
          }
        );

        return {
          failedItemIds: [
            ...results.rejected.map(([e]) => e.id),
            ...results.fulfilled
              .filter(([, r]) => r === false)
              .map(([e]) => e.id),
          ],
        };
      }
    }
  );
}
