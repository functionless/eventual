import { Bucket, GetBucketObjectResponse } from "../bucket.js";
import type { EventEnvelope } from "../event.js";
import type { WorkflowExecutionContext } from "../workflow.js";
import type { BucketMethod } from "./bucket-hook.js";
import type {
  BucketOperation,
  EntityOperation,
  SearchOperation,
} from "./calls.js";
import { or } from "./util.js";

export interface BaseEvent {
  type: WorkflowEventType;
  id: string;
  timestamp: string;
}

/**
 * Common fields for events that {@link Eventual} actives with in order semantics.
 */
export interface HistoryEventBase extends Omit<BaseEvent, "id"> {
  seq: number;
}

/**
 * Workflow Event Types
 *
 * The numeric ID is also used to determine display order.
 *
 * 0-9 reserved
 * 10 - Workflow started
 * 15 - Workflow run stated
 * 16 > 19 - Padding
 * 20 > 39 (current max: 28) - Scheduled Events
 * 50 > 79 (current max: 61) - Completed Events
 * 80 - Workflow Run Completed
 * 81 > 89 - Padding
 * 90 - Workflow Timed Out
 * 91 - Workflow Succeeded
 * 92 - Workflow Failed
 */
export enum WorkflowEventType {
  BucketRequest = 28,
  BucketRequestFailed = 60,
  BucketRequestSucceeded = 61,
  ChildWorkflowSucceeded = 50,
  ChildWorkflowFailed = 51,
  ChildWorkflowScheduled = 20,
  EntityRequest = 21,
  EntityRequestFailed = 52,
  EntityRequestSucceeded = 53,
  EventsEmitted = 22,
  TransactionRequest = 23,
  TransactionRequestFailed = 54,
  TransactionRequestSucceeded = 55,
  SignalReceived = 24,
  SignalSent = 25,
  TaskSucceeded = 46,
  TaskFailed = 57,
  TaskHeartbeatTimedOut = 58,
  TaskScheduled = 26,
  TimerCompleted = 59,
  TimerScheduled = 27,
  WorkflowSucceeded = 95,
  WorkflowFailed = 96,
  WorkflowStarted = 10,
  WorkflowRunCompleted = 80,
  WorkflowRunStarted = 15,
  WorkflowTimedOut = 90,
  SearchRequestSucceeded = 62,
  SearchRequestFailed = 63,
  SearchRequest = 29,
}

/**
 * Events generated by the engine that represent the in-order state of the workflow.
 */
export type WorkflowEvent =
  | HistoryEvent
  | WorkflowRunCompleted
  | WorkflowSucceeded
  | WorkflowFailed
  | WorkflowStarted;

/**
 * Events generated by the workflow to maintain deterministic executions.
 */
export type ScheduledEvent =
  | BucketRequest
  | ChildWorkflowScheduled
  | SearchRequest
  | EntityRequest
  | EventsEmitted
  | SignalSent
  | TaskScheduled
  | TimerScheduled
  | TransactionRequest;

export const isScheduledEvent = /* @__PURE__ */ or(
  isBucketRequest,
  isChildWorkflowScheduled,
  isEventsEmitted,
  isEntityRequest,
  isSignalSent,
  isTaskScheduled,
  isTimerScheduled,
  isTransactionRequest
);

/**
 * Events generated outside of the interpreter which progress the workflow.
 */
export type CompletionEvent =
  | BucketRequestSucceeded
  | BucketRequestFailed
  | ChildWorkflowFailed
  | ChildWorkflowSucceeded
  | EntityRequestFailed
  | EntityRequestSucceeded
  | SignalReceived
  | SearchRequestSucceeded
  | SearchRequestFailed
  | TaskFailed
  | TaskHeartbeatTimedOut
  | TaskSucceeded
  | TimerCompleted
  | TransactionRequestSucceeded
  | TransactionRequestFailed
  | WorkflowTimedOut
  | WorkflowRunStarted;

/**
 * All events which can be input into the workflow.
 */
export type WorkflowInputEvent = CompletionEvent | WorkflowStarted;

export const isCompletionEvent = /* @__PURE__ */ or(
  isBucketRequestFailed,
  isBucketRequestSucceeded,
  isChildWorkflowFailed,
  isChildWorkflowSucceeded,
  isEntityRequestFailed,
  isEntityRequestSucceeded,
  isSignalReceived,
  isTaskSucceeded,
  isTaskFailed,
  isTaskHeartbeatTimedOut,
  isTimerCompleted,
  isTransactionRequestFailed,
  isTransactionRequestSucceeded,
  isWorkflowTimedOut,
  isWorkflowRunStarted
);

/**
 * Events used by the workflow to replay an execution.
 */
export type HistoryEvent = CompletionEvent | ScheduledEvent;

export function isHistoryEvent(event: WorkflowEvent): event is HistoryEvent {
  return isCompletionEvent(event) || isScheduledEvent(event);
}

/**
 * Events that we save into history.
 */
export type HistoryStateEvent =
  | HistoryEvent
  | WorkflowStarted
  | WorkflowSucceeded
  | WorkflowFailed;

export function isHistoryStateEvent(
  event: WorkflowEvent
): event is HistoryStateEvent {
  return (
    isHistoryEvent(event) ||
    isWorkflowStarted(event) ||
    isWorkflowSucceeded(event) ||
    isWorkflowFailed(event)
  );
}

export interface WorkflowStarted extends BaseEvent {
  type: WorkflowEventType.WorkflowStarted;
  /**
   * Name of the workflow to execute.
   */
  workflowName: string;
  /**
   * Input payload for the workflow function.
   */
  input?: any;
  /**
   * Optional ISO timestamp after which the workflow should timeout.
   */
  timeoutTime?: string;
  context: Omit<WorkflowExecutionContext, "id" | "startTime">;
}
export interface WorkflowRunStarted extends BaseEvent {
  type: WorkflowEventType.WorkflowRunStarted;
}

export interface TaskScheduled extends HistoryEventBase {
  type: WorkflowEventType.TaskScheduled;
  name: string;
}

export interface TaskSucceeded extends HistoryEventBase {
  type: WorkflowEventType.TaskSucceeded;
  result: any;
}

export interface TaskFailed extends HistoryEventBase {
  type: WorkflowEventType.TaskFailed;
  error: string;
  message?: string;
}

export interface TaskHeartbeatTimedOut extends HistoryEventBase {
  type: WorkflowEventType.TaskHeartbeatTimedOut;
}

export interface WorkflowRunCompleted extends BaseEvent {
  type: WorkflowEventType.WorkflowRunCompleted;
}

export interface WorkflowSucceeded extends BaseEvent {
  type: WorkflowEventType.WorkflowSucceeded;
  output: any;
}

export interface WorkflowFailed extends BaseEvent {
  type: WorkflowEventType.WorkflowFailed;
  error: string;
  message: string;
}

export interface ChildWorkflowScheduled extends HistoryEventBase {
  type: WorkflowEventType.ChildWorkflowScheduled;
  name: string;
  input?: any;
}

export interface ChildWorkflowSucceeded extends HistoryEventBase {
  type: WorkflowEventType.ChildWorkflowSucceeded;
  result: any;
}

export interface ChildWorkflowFailed extends HistoryEventBase {
  type: WorkflowEventType.ChildWorkflowFailed;
  error: string;
  message: string;
}

export function isWorkflowStarted(
  event: WorkflowEvent
): event is WorkflowStarted {
  return event.type === WorkflowEventType.WorkflowStarted;
}

export function isWorkflowRunStarted(
  event: WorkflowEvent
): event is WorkflowRunStarted {
  return event.type === WorkflowEventType.WorkflowRunStarted;
}

export function isTaskScheduled(event: WorkflowEvent): event is TaskScheduled {
  return event.type === WorkflowEventType.TaskScheduled;
}

export function isTaskSucceeded(event: WorkflowEvent): event is TaskSucceeded {
  return event.type === WorkflowEventType.TaskSucceeded;
}

export function isTaskFailed(event: WorkflowEvent): event is TaskFailed {
  return event.type === WorkflowEventType.TaskFailed;
}

export function isTaskHeartbeatTimedOut(
  event: WorkflowEvent
): event is TaskHeartbeatTimedOut {
  return event.type === WorkflowEventType.TaskHeartbeatTimedOut;
}

export interface EntityRequest extends HistoryEventBase {
  type: WorkflowEventType.EntityRequest;
  operation: EntityOperation;
}

export interface EntityRequestSucceeded extends HistoryEventBase {
  type: WorkflowEventType.EntityRequestSucceeded;
  name?: string;
  operation: EntityOperation["operation"];
  result: any;
}

export interface EntityRequestFailed extends HistoryEventBase {
  type: WorkflowEventType.EntityRequestFailed;
  operation: EntityOperation["operation"];
  name?: string;
  error: string;
  message: string;
}

export function isEntityRequest(event: WorkflowEvent): event is EntityRequest {
  return event.type === WorkflowEventType.EntityRequest;
}

export function isEntityRequestSucceeded(
  event: WorkflowEvent
): event is EntityRequestSucceeded {
  return event.type === WorkflowEventType.EntityRequestSucceeded;
}

export function isEntityRequestFailed(
  event: WorkflowEvent
): event is EntityRequestFailed {
  return event.type === WorkflowEventType.EntityRequestFailed;
}

export interface TransactionRequest extends HistoryEventBase {
  type: WorkflowEventType.TransactionRequest;
  input: any;
  transactionName: string;
}

export interface TransactionRequestSucceeded extends HistoryEventBase {
  type: WorkflowEventType.TransactionRequestSucceeded;
  result: any;
}

export interface TransactionRequestFailed extends HistoryEventBase {
  type: WorkflowEventType.TransactionRequestFailed;
  error: string;
  message: string;
}

export function isTransactionRequest(
  event: WorkflowEvent
): event is TransactionRequest {
  return event.type === WorkflowEventType.TransactionRequest;
}

export function isTransactionRequestSucceeded(
  event: WorkflowEvent
): event is TransactionRequestSucceeded {
  return event.type === WorkflowEventType.TransactionRequestSucceeded;
}

export function isTransactionRequestFailed(
  event: WorkflowEvent
): event is TransactionRequestFailed {
  return event.type === WorkflowEventType.TransactionRequestFailed;
}

export interface BucketRequest extends HistoryEventBase {
  type: WorkflowEventType.BucketRequest;
  operation:
    | BucketOperation<Exclude<BucketMethod, "put">>
    | {
        bucketName: string;
        operation: "put";
        key: string;
        data: string;
        isBase64Encoded: boolean;
      };
}

export interface BucketGetObjectSerializedResult
  extends Omit<GetBucketObjectResponse, "body" | "getBodyString"> {
  body: string;
  base64Encoded: boolean;
}

export type BucketOperationResult<Op extends BucketMethod = BucketMethod> =
  Op extends "get"
    ? undefined | BucketGetObjectSerializedResult
    : Awaited<ReturnType<Bucket[Op]>>;

export type BucketRequestSucceeded<Op extends BucketMethod = BucketMethod> =
  HistoryEventBase & {
    type: WorkflowEventType.BucketRequestSucceeded;
    name?: string;
    operation: Op;
    result: BucketOperationResult<Op>;
  };

export function isBucketRequestSucceededOperationType<Op extends BucketMethod>(
  op: Op,
  event: BucketRequestSucceeded
): event is BucketRequestSucceeded<Op> {
  return event.operation === op;
}

export interface BucketRequestFailed extends HistoryEventBase {
  type: WorkflowEventType.BucketRequestFailed;
  operation: BucketOperation["operation"];
  name?: string;
  error: string;
  message: string;
}

export function isBucketRequest(event: WorkflowEvent): event is BucketRequest {
  return event.type === WorkflowEventType.BucketRequest;
}

export function isBucketRequestSucceeded(
  event: WorkflowEvent
): event is BucketRequestSucceeded {
  return event.type === WorkflowEventType.BucketRequestSucceeded;
}

export function isBucketRequestFailed(
  event: WorkflowEvent
): event is BucketRequestFailed {
  return event.type === WorkflowEventType.BucketRequestFailed;
}

export interface TimerScheduled extends HistoryEventBase {
  type: WorkflowEventType.TimerScheduled;
  untilTime: string;
}

export function isTimerScheduled(
  event: WorkflowEvent
): event is TimerScheduled {
  return event.type === WorkflowEventType.TimerScheduled;
}

export interface TimerCompleted extends HistoryEventBase {
  type: WorkflowEventType.TimerCompleted;
  result?: undefined;
}

export function isWorkflowRunCompleted(
  event: WorkflowEvent
): event is WorkflowRunCompleted {
  return event.type === WorkflowEventType.WorkflowRunCompleted;
}

export function isWorkflowSucceeded(
  event: WorkflowEvent
): event is WorkflowSucceeded {
  return event.type === WorkflowEventType.WorkflowSucceeded;
}

export function isWorkflowFailed(
  event: WorkflowEvent
): event is WorkflowFailed {
  return event.type === WorkflowEventType.WorkflowFailed;
}

export function isChildWorkflowScheduled(
  event: WorkflowEvent
): event is ChildWorkflowScheduled {
  return event.type === WorkflowEventType.ChildWorkflowScheduled;
}
export function isChildWorkflowSucceeded(
  event: WorkflowEvent
): event is ChildWorkflowSucceeded {
  return event.type === WorkflowEventType.ChildWorkflowSucceeded;
}
export function isChildWorkflowFailed(
  event: WorkflowEvent
): event is ChildWorkflowFailed {
  return event.type === WorkflowEventType.ChildWorkflowFailed;
}

export function isTimerCompleted(
  event: WorkflowEvent
): event is TimerCompleted {
  return event.type === WorkflowEventType.TimerCompleted;
}

export const isWorkflowCompletedEvent = or(
  isWorkflowFailed,
  isWorkflowSucceeded
);

export interface SignalReceived<Payload = any> extends BaseEvent {
  type: WorkflowEventType.SignalReceived;
  signalId: string;
  payload?: Payload;
}

export function isSignalReceived(
  event: WorkflowEvent
): event is SignalReceived {
  return event.type === WorkflowEventType.SignalReceived;
}

export interface SignalSent extends HistoryEventBase {
  type: WorkflowEventType.SignalSent;
  payload?: any;
  signalId: string;
  executionId: string;
}

export function isSignalSent(event: WorkflowEvent): event is SignalSent {
  return event.type === WorkflowEventType.SignalSent;
}

export interface EventsEmitted extends HistoryEventBase {
  type: WorkflowEventType.EventsEmitted;
  events: EventEnvelope[];
}

export function isEventsEmitted(event: WorkflowEvent): event is EventsEmitted {
  return event.type === WorkflowEventType.EventsEmitted;
}

export interface SearchRequest extends HistoryEventBase {
  type: WorkflowEventType.SearchRequest;
  operation: SearchOperation;
  request: any;
}

export interface SearchRequestSucceeded extends HistoryEventBase {
  type: WorkflowEventType.SearchRequestSucceeded;
  operation: SearchOperation;
  body: any;
}

export interface SearchRequestFailed extends HistoryEventBase {
  type: WorkflowEventType.SearchRequestFailed;
  operation: SearchOperation;
  error: string;
  message: string;
}

export function isSearchRequestStarted(
  event: WorkflowEvent
): event is SearchRequest {
  return event.type === WorkflowEventType.SearchRequest;
}

export function isSearchRequestSucceeded(
  event: WorkflowEvent
): event is SearchRequestSucceeded {
  return event.type === WorkflowEventType.SearchRequestSucceeded;
}

export function isSearchRequestFailed(
  event: WorkflowEvent
): event is SearchRequestFailed {
  return event.type === WorkflowEventType.SearchRequestFailed;
}

export interface WorkflowTimedOut extends BaseEvent {
  type: WorkflowEventType.WorkflowTimedOut;
}

export function isWorkflowTimedOut(
  event: WorkflowEvent
): event is WorkflowTimedOut {
  return event.type === WorkflowEventType.WorkflowTimedOut;
}

export function assertEventType<T extends WorkflowEvent>(
  event: any,
  type: T["type"]
): asserts event is T {
  if (!event || event.type !== type) {
    throw new Error(`Expected event of type ${type}`);
  }
}

/**
 * Compute the ID of an event.
 *
 * Some events have a computed ID to save space.
 */
export function getEventId(event: WorkflowEvent): string {
  if (isHistoryEvent(event) && "seq" in event) {
    return `${event.seq}_${event.type}`;
  } else {
    return event.id;
  }
}
