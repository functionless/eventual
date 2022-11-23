import { ExecutionContext } from "./context.js";

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

export enum WorkflowEventType {
  ActivityCompleted = "ActivityCompleted",
  ActivityFailed = "ActivityFailed",
  ActivityScheduled = "ActivityScheduled",
  SleepScheduled = "SleepScheduled",
  SleepCompleted = "SleepCompleted",
  WorkflowTaskCompleted = "TaskCompleted",
  WorkflowTaskStarted = "TaskStarted",
  WorkflowCompleted = "WorkflowCompleted",
  WorkflowFailed = "WorkflowFailed",
  WorkflowStarted = "WorkflowStarted",
}

export type ScheduledEvent = SleepScheduled | ActivityScheduled;
export type CompletedEvent = SleepCompleted | ActivityCompleted;
export type FailedEvent = ActivityFailed;

/**
 * Events used by the workflow to replay an execution.
 */
export type HistoryEvent = ScheduledEvent | CompletedEvent | FailedEvent;

/**
 * Events that we save into history.
 */
export type HistoryStateEvent = HistoryEvent | WorkflowStarted;

/**
 * Events generated by the engine that represent the in-order state of the workflow.
 */
export type WorkflowEvent =
  | ActivityCompleted
  | ActivityFailed
  | ActivityScheduled
  | SleepScheduled
  | SleepCompleted
  | WorkflowTaskCompleted
  | WorkflowTaskStarted
  | WorkflowCompleted
  | WorkflowFailed
  | WorkflowStarted;

export interface WorkflowStarted extends BaseEvent {
  type: WorkflowEventType.WorkflowStarted;
  input?: any;
  context: Omit<ExecutionContext, "id" | "startTime">;
}

export function isWorkflowStarted(
  event: WorkflowEvent
): event is WorkflowStarted {
  return event.type === WorkflowEventType.WorkflowStarted;
}

export interface WorkflowTaskStarted extends BaseEvent {
  type: WorkflowEventType.WorkflowTaskStarted;
}

export function isTaskStarted(
  event: WorkflowEvent
): event is WorkflowTaskStarted {
  return event.type === WorkflowEventType.WorkflowTaskStarted;
}

export interface ActivityScheduled extends HistoryEventBase {
  type: WorkflowEventType.ActivityScheduled;
  name: string;
}

export function isActivityScheduled(
  event: WorkflowEvent
): event is ActivityScheduled {
  return event.type === WorkflowEventType.ActivityScheduled;
}

export interface ActivityCompleted extends HistoryEventBase {
  type: WorkflowEventType.ActivityCompleted;
  // the time from being scheduled until the activity completes.
  duration: number;
  result: any;
}

export function isActivityCompleted(
  event: WorkflowEvent
): event is ActivityCompleted {
  return event.type === WorkflowEventType.ActivityCompleted;
}

export interface ActivityFailed extends HistoryEventBase {
  type: WorkflowEventType.ActivityFailed;
  error: string;
  // the time from being scheduled until the activity completes.
  duration: number;
  message: string;
}

export function isActivityFailed(
  event: WorkflowEvent
): event is ActivityFailed {
  return event.type === WorkflowEventType.ActivityFailed;
}

export interface SleepScheduled extends HistoryEventBase {
  type: WorkflowEventType.SleepScheduled;
  untilTime: string;
}

export function isSleepScheduled(
  event: WorkflowEvent
): event is SleepScheduled {
  return event.type === WorkflowEventType.SleepScheduled;
}

export interface SleepCompleted extends HistoryEventBase {
  type: WorkflowEventType.SleepCompleted;
}

export function isSleepCompleted(
  event: WorkflowEvent
): event is SleepCompleted {
  return event.type === WorkflowEventType.SleepCompleted;
}

export function isScheduledEvent(
  event: WorkflowEvent
): event is ScheduledEvent {
  return isActivityScheduled(event) || isSleepScheduled(event);
}

export function isCompletedEvent(
  event: WorkflowEvent
): event is CompletedEvent {
  return isActivityCompleted(event) || isSleepCompleted(event);
}

export function isFailedEvent(event: WorkflowEvent): event is FailedEvent {
  return isActivityFailed(event);
}

export function isHistoryEvent(event: WorkflowEvent): event is HistoryEvent {
  return (
    isScheduledEvent(event) || isFailedEvent(event) || isCompletedEvent(event)
  );
}

export interface WorkflowTaskCompleted extends BaseEvent {
  type: WorkflowEventType.WorkflowTaskCompleted;
}

export function isTaskCompleted(
  event: WorkflowEvent
): event is WorkflowTaskCompleted {
  return event.type === WorkflowEventType.WorkflowTaskCompleted;
}

export interface WorkflowCompleted extends BaseEvent {
  type: WorkflowEventType.WorkflowCompleted;
  output: any;
}

export function isWorkflowCompleted(
  event: WorkflowEvent
): event is WorkflowCompleted {
  return event.type === WorkflowEventType.WorkflowCompleted;
}

export interface WorkflowFailed extends BaseEvent {
  type: WorkflowEventType.WorkflowFailed;
  error: string;
  message: string;
}

export function isWorkflowFailed(
  event: WorkflowEvent
): event is WorkflowFailed {
  return event.type === WorkflowEventType.WorkflowFailed;
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
  if (isHistoryEvent(event)) {
    return `${event.seq}_${event.type}`;
  } else {
    return event.id;
  }
}

/**
 * Merges new task events with existing history events.
 *
 * We assume that history events are unique.
 *
 * Task events are taken only of their ID ({@link getEventId}) is unique across all other events.
 */
export function filterEvents<T extends WorkflowEvent>(
  historyEvents: T[],
  taskEvents: T[]
): T[] {
  const ids = new Set(historyEvents.map(getEventId));

  return [
    ...historyEvents,
    ...taskEvents.filter((event) => {
      const id = getEventId(event);
      if (ids.has(id)) {
        return false;
      }
      ids.add(id);
      return true;
    }),
  ];
}
