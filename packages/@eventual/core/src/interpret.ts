import {
  Eventual,
  isEventual,
  CommandCall,
  isCommandCall,
  EventualCallCollector,
} from "./eventual.js";
import { isAwaitAll } from "./await-all.js";
import { isActivityCall } from "./calls/activity-call.js";
import {
  DeterminismError,
  SynchronousOperationError,
  Timeout,
} from "./error.js";
import {
  CompletedEvent,
  SignalReceived,
  FailedEvent,
  HistoryEvent,
  isActivityScheduled,
  isChildWorkflowScheduled,
  isCompletedEvent,
  isSignalReceived,
  isFailedEvent,
  isScheduledEvent,
  isSleepCompleted,
  isSleepScheduled,
  isExpectSignalStarted,
  isExpectSignalTimedOut,
  ScheduledEvent,
  isSignalSent,
  isConditionStarted,
  isConditionTimedOut,
  isWorkflowTimedOut,
  isActivityTimedOut,
  isEventsPublished,
} from "./workflow-events.js";
import {
  Result,
  isResolved,
  isFailed,
  isPending,
  Resolved,
  Failed,
  isResolvedOrFailed,
} from "./result.js";
import { createChain, isChain, Chain } from "./chain.js";
import { assertNever, or } from "./util.js";
import { Command, CommandType } from "./command.js";
import { isSleepForCall, isSleepUntilCall } from "./calls/sleep-call.js";
import {
  isExpectSignalCall,
  ExpectSignalCall,
} from "./calls/expect-signal-call.js";
import {
  isRegisterSignalHandlerCall,
  RegisterSignalHandlerCall,
} from "./calls/signal-handler-call.js";
import { isSendSignalCall } from "./calls/send-signal-call.js";
import { isWorkflowCall } from "./calls/workflow-call.js";
import { clearEventualCollector, setEventualCollector } from "./global.js";
import { isConditionCall } from "./calls/condition-call.js";
import { isAwaitAllSettled } from "./await-all-settled.js";
import { isAwaitAny } from "./await-any.js";
import { isRace } from "./race.js";
import { isPublishEventsCall } from "./calls/publish-events-call.js";

export interface WorkflowResult<T = any> {
  /**
   * The Result if this chain has terminated.
   */
  result?: Result<T>;
  /**
   * Any Commands that need to be scheduled.
   *
   * This can still be non-empty even if the chain has terminated because of dangling promises.
   */
  commands: Command[];
}

export type Program<Return = any> = Generator<Eventual, Return, any>;

/**
 * Interprets a workflow program
 */
export function interpret<Return>(
  program: Program<Return>,
  history: HistoryEvent[]
): WorkflowResult<Awaited<Return>> {
  const callTable: Record<number, CommandCall> = {};
  /**
   * A map of signalIds to calls and handlers that are listening for this signal.
   */
  const signalSubscriptions: Record<
    string,
    (ExpectSignalCall | RegisterSignalHandlerCall)[]
  > = {};
  const mainChain = createChain(program);
  const activeChains = new Set([mainChain]);

  let seq = 0;
  function nextSeq() {
    return seq++;
  }

  let emittedEvents = iterator(history, isScheduledEvent);
  let resultEvents = iterator(
    history,
    or(isCompletedEvent, isFailedEvent, isSignalReceived, isWorkflowTimedOut)
  );

  /**
   * Try to advance machine
   * While we have calls and emitted events, drain the queues.
   * When we run out of emitted events or calls, try to apply the next result event
   * advance run again
   * any calls at the event of all result commands and advances, return
   */
  let calls: CommandCall[] = [];
  let newCalls: Iterator<CommandCall, CommandCall>;
  // iterate until we are no longer finding commands, no longer have completion events to apply
  // or the workflow has a terminal status.
  while (
    (!mainChain.result || isPending(mainChain.result)) &&
    ((newCalls = iterator(advance() ?? [])).hasNext() || resultEvents.hasNext())
  ) {
    // if there are result events (completed or failed), apply it before the next run
    if (!newCalls.hasNext() && resultEvents.hasNext()) {
      const resultEvent = resultEvents.next()!;

      // it is possible that committing events
      newCalls = iterator(
        collectActivitiesScope(() => {
          if (isSignalReceived(resultEvent)) {
            commitSignal(resultEvent);
          } else if (isWorkflowTimedOut(resultEvent)) {
            // will stop the workflow execution as the workflow has failed.
            mainChain.result = Result.failed(new Timeout("Workflow timed out"));
            return;
          } else {
            commitCompletionEvent(resultEvent);
          }
        })
      );
    }

    // Match and filter found commands against the given scheduled events.
    // scheduled events must be in order or not present.
    while (newCalls.hasNext() && emittedEvents.hasNext()) {
      const call = newCalls.next()!;
      const event = emittedEvents.next()!;

      if (!isCorresponding(event, call)) {
        throw new DeterminismError(
          `Workflow returned ${JSON.stringify(call)}, but ${JSON.stringify(
            event
          )} was expected at ${event?.seq}`
        );
      }
    }

    // any calls not matched against historical schedule events will be returned to the caller.
    calls.push(...newCalls.drain());
  }

  // if the history shows events have been scheduled, but we did not find them when running the workflow,
  // something is wrong, fail
  if (emittedEvents.hasNext()) {
    throw new DeterminismError(
      "Workflow did not return expected commands: " +
        JSON.stringify(emittedEvents.drain())
    );
  }

  const result = tryResolveResult(mainChain);

  return {
    result,
    commands: calls.flatMap(callToCommand),
  };

  function callToCommand(call: CommandCall): Command[] | Command {
    if (isActivityCall(call)) {
      return {
        // TODO: add sleep
        kind: CommandType.StartActivity,
        args: call.args,
        name: call.name,
        timeoutSeconds: call.timeoutSeconds,
        seq: call.seq!,
      };
    } else if (isSleepUntilCall(call)) {
      return {
        kind: CommandType.SleepUntil,
        seq: call.seq!,
        untilTime: call.isoDate,
      };
    } else if (isSleepForCall(call)) {
      return {
        kind: CommandType.SleepFor,
        seq: call.seq!,
        durationSeconds: call.durationSeconds,
      };
    } else if (isWorkflowCall(call)) {
      return {
        kind: CommandType.StartWorkflow,
        seq: call.seq!,
        input: call.input,
        name: call.name,
        opts: call.opts,
      };
    } else if (isExpectSignalCall(call)) {
      return {
        kind: CommandType.ExpectSignal,
        signalId: call.signalId,
        seq: call.seq!,
        timeoutSeconds: call.timeoutSeconds,
      };
    } else if (isSendSignalCall(call)) {
      return {
        kind: CommandType.SendSignal,
        signalId: call.signalId,
        target: call.target,
        seq: call.seq!,
        payload: call.payload,
      };
    } else if (isConditionCall(call)) {
      return {
        kind: CommandType.StartCondition,
        seq: call.seq!,
        timeoutSeconds: call.timeoutSeconds,
      };
    } else if (isRegisterSignalHandlerCall(call)) {
      return [];
    } else if (isPublishEventsCall(call)) {
      return {
        kind: CommandType.PublishEvents,
        seq: call.seq!,
        events: call.events,
      };
    }

    return assertNever(call);
  }

  function advance(): CommandCall[] | undefined {
    let madeProgress: boolean;

    return collectActivitiesScope(() => {
      do {
        madeProgress = false;
        for (const chain of activeChains) {
          madeProgress = madeProgress || tryAdvanceChain(chain);
        }
      } while (madeProgress);
    });
  }

  function collectActivitiesScope(func: () => void): CommandCall[] {
    let calls: CommandCall[] = [];

    const collector: EventualCallCollector = {
      /**
       * The returned activity is available to the workflow and may be yielded later if it was not already.
       */
      pushEventual(activity) {
        if (isCommandCall(activity)) {
          if (isExpectSignalCall(activity)) {
            subscribeToSignal(activity.signalId, activity);
          } else if (isConditionCall(activity)) {
            // if the condition is resolvable, don't add it to the calls.
            const result = tryResolveResult(activity);
            if (result) {
              return activity;
            }
          } else if (isRegisterSignalHandlerCall(activity)) {
            subscribeToSignal(activity.signalId, activity);
            // signal handler does not emit a call/command. It is only internal.
            return activity;
          }
          activity.seq = nextSeq();
          callTable[activity.seq!] = activity;
          calls.push(activity);
          return activity;
        } else if (isChain(activity)) {
          activeChains.add(activity);
          tryAdvanceChain(activity);
          return activity;
        } else if (
          isAwaitAll(activity) ||
          isAwaitAllSettled(activity) ||
          isAwaitAny(activity) ||
          isRace(activity)
        ) {
          return activity;
        }
        return assertNever(activity);
      },
    };

    try {
      setEventualCollector(collector);

      func();
    } finally {
      clearEventualCollector();
    }

    return calls;
  }

  function subscribeToSignal(
    signalId: string,
    sub: ExpectSignalCall | RegisterSignalHandlerCall
  ) {
    if (!(signalId in signalSubscriptions)) {
      signalSubscriptions[signalId] = [];
    }
    signalSubscriptions[signalId]!.push(sub);
  }

  /**
   * Try and advance chain if it can be resumed up with a new value.
   *
   * Returns an array of Commands if the chain progressed, otherwise `undefined`:
   * 1. If an empty array of Commands is returned, it indicates that the chain woke up
   *    but did not emit any new Commands.
   * 2. An `undefined` return value indicates that the chain did not advance
   */
  function tryAdvanceChain(chain: Chain): boolean {
    if (chain.awaiting === undefined) {
      // this is the first time the chain is running, so wake it with an undefined input
      advanceChain(chain, undefined);
      return true;
    }
    const result = tryResolveResult(chain.awaiting);
    if (result === undefined) {
      return false;
    } else if (isResolved(result) || isFailed(result)) {
      advanceChain(chain, result);
      return true;
    } else if (isAwaitAll(result.activity)) {
      const results = [];
      for (const activity of result.activity.activities) {
        const result = activity.result;
        if (result === undefined) {
          // something went wrong, we should always have a Pending Result for an Activity
          // TODO: this may be an internal IllegalStateException, not a DeterminismError
          //       -> this state should not be possible to get into, even when writing non-deterministic code
          throw new DeterminismError();
        } else if (isPending(result)) {
          // chain cannot wake up because we're waiting on all tasks
          return false;
        } else if (isFailed(result)) {
          // one of the inner activities has failed, the chain should throw
          advanceChain(chain, result);
          return true;
        } else {
          results.push(result.value);
        }
      }
      advanceChain(chain, Result.resolved(results));
      return true;
    } else {
      return false;
    }

    /**
     * Resumes a {@link Chain} with a new value and return any newly spawned {@link CommandCall}s.
     */
    function advanceChain(
      chain: Chain,
      result: Resolved | Failed | undefined
    ): void {
      try {
        const iterResult =
          result === undefined || isResolved(result)
            ? chain.next(result?.value)
            : chain.throw(result.error);
        if (iterResult.done) {
          activeChains.delete(chain);
          if (isEventual(iterResult.value)) {
            chain.result = Result.pending(iterResult.value);
          } else if (isGenerator(iterResult.value)) {
            const childChain = createChain(iterResult.value);
            activeChains.add(childChain);
            chain.result = Result.pending(childChain);
          } else {
            chain.result = Result.resolved(iterResult.value);
          }
        } else if (
          !isChain(iterResult.value) &&
          isGenerator(iterResult.value)
        ) {
          const childChain = createChain(iterResult.value);
          activeChains.add(childChain);
          chain.awaiting = childChain;
        } else {
          chain.awaiting = iterResult.value;
        }
      } catch (err) {
        console.error(chain, err);
        activeChains.delete(chain);
        chain.result = Result.failed(err);
      }
    }
  }

  function tryResolveResult(activity: Eventual): Result | undefined {
    // check if a result has been stored on the activity before computing
    if (isResolved(activity.result) || isFailed(activity.result)) {
      return activity.result;
    } else if (isPending(activity.result)) {
      // if an activity is marked as pending another activity, defer to the pending activities's result
      return tryResolveResult(activity.result.activity);
    }
    return (activity.result = resolveResult(
      activity as Eventual<any> & { result: undefined }
    ));

    /**
     * When the result has not been cached in the activity, try to compute it.
     */
    function resolveResult(activity: Eventual & { result: undefined }) {
      if (isConditionCall(activity)) {
        // try to evaluate the condition's result.
        const predicateResult = activity.predicate();
        if (isGenerator(predicateResult)) {
          return Result.failed(
            new SynchronousOperationError(
              "Condition Predicates must be synchronous"
            )
          );
        } else if (predicateResult) {
          return Result.resolved(true);
        }
      } else if (isChain(activity) || isCommandCall(activity)) {
        // chain and most commands will be resolved elsewhere (ex: commitCompletionEvent or commitSignal)
        return undefined;
      } else if (isAwaitAll(activity)) {
        // try to resolve all of the nested activities
        const results = activity.activities.map(tryResolveResult);
        // if all results are resolved, return their values as a map
        if (results.every(isResolved)) {
          return Result.resolved(results.map((r) => r.value));
        }
        // if any failed, return the first one, otherwise continue
        return results.find(isFailed);
      } else if (isAwaitAny(activity)) {
        // try to resolve all of the nested activities
        const results = activity.activities.map(tryResolveResult);
        // if all are failed, return their errors as an AggregateError
        if (results.every(isFailed)) {
          return Result.failed(new AggregateError(results.map((e) => e.error)));
        }
        // if any are fulfilled, return it, otherwise continue
        return results.find(isResolved);
      } else if (isAwaitAllSettled(activity)) {
        // try to resolve all of the nested activities
        const results = activity.activities.map(tryResolveResult);
        // if all are resolved or failed, return the Promise Result API
        if (results.every(isResolvedOrFailed)) {
          return Result.resolved(
            results.map(
              (r): PromiseFulfilledResult<any> | PromiseRejectedResult =>
                isResolved(r)
                  ? { status: "fulfilled", value: r.value }
                  : { status: "rejected", reason: r.error }
            )
          );
        }
      } else if (isRace(activity)) {
        // try to resolve all of the nested activities
        const results = activity.activities.map(tryResolveResult);
        // if any of the results are complete, return the first one, otherwise continue
        return results.find(isResolvedOrFailed);
      } else {
        return assertNever(activity);
      }
      // no result was found, continue
      return undefined;
    }
  }

  /**
   * Add result to ExpectSignal and call any event handlers.
   */
  function commitSignal(signal: SignalReceived) {
    const subscriptions = signalSubscriptions[signal.signalId];

    subscriptions?.forEach((sub) => {
      if (isExpectSignalCall(sub)) {
        if (!sub.result) {
          sub.result = Result.resolved(signal.payload);
        }
      } else if (isRegisterSignalHandlerCall(sub)) {
        if (!sub.result) {
          // call the handler
          // the transformer may wrap the handler function as a chain, it will be registered internally
          const output = sub.handler(signal.payload);
          // if the handler returns generator instead, start a new chain
          if (isGenerator(output)) {
            activeChains.add(createChain(output));
          }
        }
      }
    });
  }

  function commitCompletionEvent(event: CompletedEvent | FailedEvent) {
    const call = callTable[event.seq];
    if (call === undefined) {
      throw new DeterminismError(`Call for seq ${event.seq} was not emitted.`);
    }
    if (call.result && !isPending(call.result)) {
      return;
    }
    call.result = isCompletedEvent(event)
      ? Result.resolved(event.result)
      : isSleepCompleted(event)
      ? Result.resolved(undefined)
      : isExpectSignalTimedOut(event)
      ? Result.failed(new Timeout("Expect Signal Timed Out"))
      : isConditionTimedOut(event)
      ? // a timed out condition returns false
        Result.resolved(false)
      : isActivityTimedOut(event)
      ? Result.failed(new Timeout("Activity Timed Out"))
      : Result.failed(event.error);
  }
}

function isCorresponding(event: ScheduledEvent, call: CommandCall) {
  if (event.seq !== call.seq) {
    return false;
  } else if (isActivityScheduled(event)) {
    return isActivityCall(call) && call.name === event.name;
  } else if (isChildWorkflowScheduled(event)) {
    return isWorkflowCall(call) && call.name === event.name;
  } else if (isSleepScheduled(event)) {
    return isSleepUntilCall(call) || isSleepForCall(call);
  } else if (isExpectSignalStarted(event)) {
    return isExpectSignalCall(call) && event.signalId == call.signalId;
  } else if (isSignalSent(event)) {
    return isSendSignalCall(call) && event.signalId === call.signalId;
  } else if (isConditionStarted(event)) {
    return isConditionCall(call);
  } else if (isEventsPublished(event)) {
    return isPublishEventsCall(call);
  }
  return assertNever(event);
}

function isGenerator(a: any): a is Program {
  return (
    a &&
    typeof a === "object" &&
    typeof a.next === "function" &&
    typeof a.return === "function" &&
    typeof a.throw === "function"
  );
}

interface Iterator<I, T extends I> {
  hasNext(): boolean;
  next(): T | undefined;
  drain(): T[];
}

function iterator<I, T extends I>(
  elms: I[],
  predicate?: (elm: I) => elm is T
): Iterator<I, T> {
  let cursor = 0;
  return {
    hasNext: () => {
      seek();
      return cursor < elms.length;
    },
    next: (): T => {
      seek();
      return elms[cursor++] as T;
    },
    drain: (): T[] => {
      return predicate
        ? elms.slice(cursor).filter(predicate)
        : (elms.slice(cursor) as T[]);
    },
  };

  function seek() {
    if (predicate) {
      while (cursor < elms.length) {
        if (predicate(elms[cursor]!)) {
          return;
        }
        cursor++;
      }
    }
  }
}
