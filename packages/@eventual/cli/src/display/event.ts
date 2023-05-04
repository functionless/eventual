import type { EntityConditionalOperation } from "@eventual/core";
import { normalizeCompositeKey } from "@eventual/core-runtime";
import {
  BucketRequest,
  EntityOperation,
  isBucketRequest,
  isChildWorkflowScheduled,
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

function displayEntityCommand(
  operation: EntityOperation | EntityConditionalOperation
) {
  const output: string[] = [`Operation: ${operation.operation}`];
  if (operation.operation === "transact") {
    output.push(`Transaction Items:`);
    output.push(
      ...operation.items.flatMap((item, i) => [
        `${i}:`,
        ...displayEntityCommand({
          ...item.operation,
          name:
            typeof item.entity === "string" ? item.entity : item.entity.name,
        }).map((v) => `\t${v}`),
      ])
    );
  } else {
    output.push(`Ent: ${operation.name}`);
    if ("key" in operation) {
      const { key, namespace } = normalizeCompositeKey(operation.key);
      if (namespace) {
        output.push(`Namespace: ${namespace}`);
      }
      output.push(`Key: ${key}`);
      if (operation.operation === "set") {
        output.push(`Entity: ${JSON.stringify(operation.value)}`);
        if (operation.options?.expectedVersion) {
          output.push(`Expected Version: ${operation.options.expectedVersion}`);
        }
      }
    } else {
      if (operation.request.namespace) {
        output.push(`Namespace: ${operation.request.prefix}`);
      }
      if (operation.request.prefix) {
        output.push(`Prefix: ${operation.request.prefix}`);
      }
    }
  }
  return output;
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
