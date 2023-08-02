import type { EntityTransactItem } from "@eventual/core";
import {
  BucketRequest,
  EntityOperation,
  isBucketRequest,
  isChildWorkflowScheduled,
  isEntityOperationOfType,
  isEntityRequest,
  isSignalReceived,
  isSignalSent,
  isTaskScheduled,
  isTransactionRequest,
  WorkflowEvent,
  WorkflowEventType,
} from "@eventual/core/internal";
import chalk from "chalk";
import { formatTime } from "./time.js";

export function displayEvent(event: WorkflowEvent) {
  const lines: string[] = [
    `${chalk.green(formatTime(event.timestamp))}\t${chalk.blue(
      WorkflowEventType[event.type]
    )}${"seq" in event ? `(${event.seq})` : ""}`,
    ...(isChildWorkflowScheduled(event) || isTaskScheduled(event)
      ? [`Task Name: ${JSON.stringify(event.name)}`]
      : []),
    ...(isTransactionRequest(event)
      ? [`Transaction Name: ${event.transactionName}`]
      : []),
    ...("signalId" in event ? [`Signal Id: ${event.signalId}`] : []),
    ...((isChildWorkflowScheduled(event) || isTransactionRequest(event)) &&
    event.input
      ? [`Payload: ${JSON.stringify(event.input)}`]
      : []),
    ...((isSignalReceived(event) || isSignalSent(event)) && event.payload
      ? [`Payload: ${JSON.stringify(event.payload)}`]
      : []),
    ...(isEntityRequest(event) ? displayEntityCommand(event.operation) : []),
    ...(isBucketRequest(event) ? displayBucketRequest(event) : []),
    ...("result" in event ? [`Result: ${JSON.stringify(event.result)}`] : []),
    ...("output" in event ? [`Output: ${JSON.stringify(event.output)}`] : []),
    ...("error" in event
      ? [`${chalk.red(event.error)}: ${event.message}`]
      : []),
  ];

  return lines.join("\n");
}

function displayEntityCommand(operation: EntityOperation) {
  const output: string[] = [`Operation: ${operation.operation}`];
  if (operation.operation === "transact") {
    output.push(`Transaction Items:`);
    output.push(
      ...operation.items.flatMap((item, i) => [
        `${i}:`,
        ...displayEntityTransactItem(item).map((v) => `\t${v}`),
      ])
    );
  } else {
    output.push(`Ent: ${operation.entityName}`);
    if (
      isEntityOperationOfType("delete", operation) ||
      isEntityOperationOfType("get", operation) ||
      isEntityOperationOfType("getWithMetadata", operation)
    ) {
      const [key] = operation.params;
      output.push(`Key: ${JSON.stringify(key)}`);
    }
    if (isEntityOperationOfType("put", operation)) {
      const [value] = operation.params;
      output.push(`Entity: ${JSON.stringify(value)}`);
    }
    if (
      isEntityOperationOfType("put", operation) ||
      isEntityOperationOfType("delete", operation)
    ) {
      const [, options] = operation.params;
      if (options?.expectedVersion) {
        output.push(`Expected Version: ${options.expectedVersion}`);
      }
    }
    if (
      isEntityOperationOfType("query", operation) ||
      isEntityOperationOfType("queryIndex", operation)
    ) {
      if (isEntityOperationOfType("queryIndex", operation)) {
        output.push(`Index: ${operation.indexName}`);
      }
      const [key] = operation.params;
      output.push(`Key: ${JSON.stringify(key)}`);
    }
  }
  return output;
}

function displayEntityTransactItem(item: EntityTransactItem): string[] {
  const entityName =
    typeof item.entity === "string" ? item.entity : item.entity.name;
  if (item.operation === "put") {
    return displayEntityCommand({
      operation: "put",
      entityName,
      params: [item.value, item.options],
    });
  } else if (item.operation === "delete") {
    return displayEntityCommand({
      operation: "delete",
      entityName,
      params: [item.key, item.options],
    });
  } else {
    const output = [
      `Operation: ${item.operation}`,
      `Key: ${JSON.stringify(item.key)}`,
    ];
    if (item.version !== undefined) {
      output.push(`Version: ${item.version}`);
    }
    return output;
  }
}

function displayBucketRequest(request: BucketRequest) {
  const output: string[] = [`Operation: ${request.operation.operation}`];
  output.push(`Bucket: ${request.operation.bucketName}`);
  if (request.operation.operation === "put") {
    output.push(`Key: ${request.operation.key}`);
    output.push(
      `Data (encoded: ${request.operation.isBase64Encoded}): ${JSON.stringify(
        request.operation.data
      )}`
    );
  } else {
    const [key] = request.operation.params;
    output.push(`Key: ${key}`);
  }
  return output;
}
