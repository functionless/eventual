import {
  DynamoDBClient,
  QueryCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import {
  GetObjectCommand,
  GetObjectCommandOutput,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  LambdaClient,
  InvokeCommand,
  InvocationType,
} from "@aws-sdk/client-lambda";
import {
  ExecutionStatus,
  HistoryStateEvent,
  CompleteExecution,
  FailedExecution,
  Execution,
  SleepUntilCommand,
  SleepForCommand,
  SleepScheduled,
  isSleepUntilCommand,
  WorkflowEventType,
  ScheduleActivityCommand,
  ActivityScheduled,
  SleepCompleted,
} from "@eventual/core";
import {
  createExecutionFromResult,
  ExecutionRecord,
  WorkflowClient,
} from "./workflow-client.js";
import { ActivityWorkerRequest } from "../activity.js";
import { createEvent } from "./execution-history-client.js";
import { TimerRequestType } from "../handlers/types.js";
import { TimerClient } from "./timer-client.js";

export interface WorkflowRuntimeClientProps {
  readonly lambda: LambdaClient;
  readonly activityWorkerFunctionName: string;
  readonly dynamo: DynamoDBClient;
  readonly s3: S3Client;
  readonly executionHistoryBucket: string;
  readonly tableName: string;
  readonly workflowClient: WorkflowClient;
  readonly timerClient: TimerClient;
}

export interface CompleteExecutionRequest {
  executionId: string;
  result?: any;
  readonly timerClient: TimerClient;
}

export class WorkflowRuntimeClient {
  constructor(private props: WorkflowRuntimeClientProps) {}

  async getHistory(executionId: string): Promise<HistoryStateEvent[]> {
    try {
      console.log("history key", formatExecutionHistoryKey(executionId));
      console.log("bucket", this.props.executionHistoryBucket);
      // get current history from s3
      const historyObject = await this.props.s3.send(
        new GetObjectCommand({
          Key: formatExecutionHistoryKey(executionId),
          Bucket: this.props.executionHistoryBucket,
        })
      );

      return await historyEntryToEvents(historyObject);
    } catch (err) {
      if (err instanceof NoSuchKey) {
        return [];
      }
      throw err;
    }
  }

  // TODO: etag
  async updateHistory(
    executionId: string,
    events: HistoryStateEvent[]
  ): Promise<{ bytes: number }> {
    const content = events.map((e) => JSON.stringify(e)).join("\n");
    // get current history from s3
    await this.props.s3.send(
      new PutObjectCommand({
        Key: formatExecutionHistoryKey(executionId),
        Bucket: this.props.executionHistoryBucket,
        Body: content,
      })
    );
    return { bytes: content.length };
  }

  async completeExecution({
    executionId,
    result,
  }: CompleteExecutionRequest): Promise<CompleteExecution> {
    const executionResult = await this.props.dynamo.send(
      new UpdateItemCommand({
        Key: {
          pk: { S: ExecutionRecord.PRIMARY_KEY },
          sk: { S: ExecutionRecord.sortKey(executionId) },
        },
        TableName: this.props.tableName,
        UpdateExpression: result
          ? "SET #status=:complete, #result=:result, endTime=if_not_exists(endTime,:endTime)"
          : "SET #status=:complete, endTime=if_not_exists(endTime,:endTime)",
        ExpressionAttributeNames: {
          "#status": "status",
          ...(result ? { "#result": "result" } : {}),
        },
        ExpressionAttributeValues: {
          ":complete": { S: ExecutionStatus.COMPLETE },
          ":endTime": { S: new Date().toISOString() },
          ...(result ? { ":result": { S: JSON.stringify(result) } } : {}),
        },
        ReturnValues: "ALL_NEW",
      })
    );

    const record = executionResult.Attributes as unknown as ExecutionRecord;
    if (record.parentExecutionId) {
      await this.reportCompletionToParent(
        record.parentExecutionId.S,
        record.seq.N,
        result
      );
    }

    return createExecutionFromResult(record) as CompleteExecution;
  }

  async failExecution(
    executionId: string,
    error: string,
    message: string
  ): Promise<FailedExecution> {
    const executionResult = await this.props.dynamo.send(
      new UpdateItemCommand({
        Key: {
          pk: { S: ExecutionRecord.PRIMARY_KEY },
          sk: { S: ExecutionRecord.sortKey(executionId) },
        },
        TableName: this.props.tableName,
        UpdateExpression:
          "SET #status=:failed, #error=:error, #message=:message, endTime=if_not_exists(endTime,:endTime)",
        ExpressionAttributeNames: {
          "#status": "status",
          "#error": "error",
          "#message": "message",
        },
        ExpressionAttributeValues: {
          ":failed": { S: ExecutionStatus.FAILED },
          ":endTime": { S: new Date().toISOString() },
          ":error": { S: error },
          ":message": { S: message },
        },
        ReturnValues: "ALL_NEW",
      })
    );

    const record = executionResult.Attributes as unknown as ExecutionRecord;
    if (record.parentExecutionId) {
      await this.reportCompletionToParent(
        record.parentExecutionId.S,
        record.seq.N,
        error,
        message
      );
    }

    return createExecutionFromResult(record) as FailedExecution;
  }

  private async reportCompletionToParent(
    parentExecutionId: string,
    seq: string,
    ...args: [result: any] | [error: string, message: string]
  ) {
    await this.props.workflowClient.submitWorkflowTask(parentExecutionId, {
      seq: parseInt(seq, 10),
      timestamp: new Date().toISOString(),
      ...(args.length === 1
        ? {
            type: WorkflowEventType.ChildWorkflowCompleted,
            result: args[0],
          }
        : {
            type: WorkflowEventType.ChildWorkflowFailed,
            error: args[0],
            message: args[1],
          }),
    });
  }

  async getExecutions(): Promise<Execution[]> {
    const executions = await this.props.dynamo.send(
      new QueryCommand({
        TableName: this.props.tableName,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: {
          ":pk": { S: ExecutionRecord.PRIMARY_KEY },
        },
      })
    );
    return executions.Items!.map((execution) =>
      createExecutionFromResult(execution as ExecutionRecord)
    );
  }

  async scheduleActivity(
    workflowName: string,
    executionId: string,
    command: ScheduleActivityCommand
  ) {
    const request: ActivityWorkerRequest = {
      scheduledTime: new Date().toISOString(),
      workflowName,
      executionId,
      command,
      retry: 0,
    };

    await this.props.lambda.send(
      new InvokeCommand({
        FunctionName: this.props.activityWorkerFunctionName,
        Payload: Buffer.from(JSON.stringify(request)),
        InvocationType: InvocationType.Event,
      })
    );

    return createEvent<ActivityScheduled>({
      type: WorkflowEventType.ActivityScheduled,
      seq: command.seq,
      name: command.name,
    });
  }

  async scheduleSleep(
    executionId: string,
    command: SleepUntilCommand | SleepForCommand,
    baseTime: Date
  ): Promise<SleepScheduled> {
    // TODO validate
    const untilTime = isSleepUntilCommand(command)
      ? new Date(command.untilTime)
      : new Date(baseTime.getTime() + command.durationSeconds * 1000);
    const untilTimeIso = untilTime.toISOString();

    const sleepCompletedEvent: SleepCompleted = {
      type: WorkflowEventType.SleepCompleted,
      seq: command.seq,
      timestamp: untilTimeIso,
    };

    await this.props.timerClient.startTimer({
      type: TimerRequestType.ForwardEvent,
      event: sleepCompletedEvent,
      untilTime: untilTimeIso,
      executionId,
    });

    return createEvent<SleepScheduled>({
      type: WorkflowEventType.SleepScheduled,
      seq: command.seq,
      untilTime: untilTime.toISOString(),
    });
  }
}

async function historyEntryToEvents(
  objectOutput: GetObjectCommandOutput
): Promise<HistoryStateEvent[]> {
  if (objectOutput.Body) {
    return (await objectOutput.Body.transformToString())
      .split("\n")
      .map((l) => JSON.parse(l)) as HistoryStateEvent[];
  }
  return [];
}

function formatExecutionHistoryKey(executionId: string) {
  return `executionHistory/${executionId}`;
}
