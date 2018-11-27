/* @flow */
import type {
  Task$Types, Task$Handler, Task$Ref, Task$RefMap,
} from './types';

import {
  NOOP,
  EXECUTE_RESULT,
  TASK_CANCELLED,
  STATIC_EMPTY_ARRAY,
} from './constants';

import createDeferQueue from './defer';

function createTaskRef<+ID: any>(
  type: Task$Types,
  id: ID,
  handler: Task$Handler,
  jobDescriptor?: [Function, Array<any>],
): Task$Ref {
  handler.cancel(id);
  let promise: void | Promise<Task$Ref>;
  let promiseActions;
  let lastResult;
  let job;

  const getNextPromise = () => {
    if (promise) return promise;
    promise = new Promise((resolve, reject) => {
      promiseActions = [resolve, reject];
    });
    return promise;
  };

  const ref: Task$Ref = {
    get result() {
      if (ref.status.complete) {
        return lastResult;
      }
      return undefined;
    },
    get promise() {
      if (type === 'every') {
        throw new Error(
          `[ERROR] | task-handler | "ref.promise()" may only be used with non-iterative tasks such as after, defer, and job, but tried with "${type}" task with ID: "${id}"`,
        );
      }
      return async function promisedResult(): Promise<Task$Ref> {
        if (promise) {
          return promise;
        }
        try {
          if (ref.status.complete) {
            return ref;
          }
          getNextPromise();
          await promise;
          return ref;
        } catch (e) {
          ref.status.error = true;
          lastResult = e;
          throw e;
        } finally {
          promiseActions = undefined;
          promise = undefined;
        }
      };
    },
    get promises() {
      if (type !== 'every') {
        throw new Error(
          `[ERROR] | task-handler | "ref.promises()" may only be used with iterative tasks such as every and everyNow, but tried with "${type}" task with ID: "${id}"`,
        );
      }
      return async function* promiseIterator(): AsyncGenerator<
        Task$Ref,
        Task$Ref,
        *,
        > {
        try {
          while (true) {
            if (ref.status.complete) {
              break;
            }
            if (!promise) {
              getNextPromise();
            }
            // eslint-disable-next-line no-await-in-loop
            await promise;
            yield ref;
            promiseActions = undefined;
            promise = undefined;
          }
          return ref;
        } finally {
          promiseActions = undefined;
          promise = undefined;
        }
      };
    },
    status: {
      complete: false,
      error: false,
      cancelled: false,
    },
    // $FlowIgnore
    [TASK_CANCELLED](promises) {
      if (ref.status.complete) {
        return;
      }
      lastResult = TASK_CANCELLED;
      ref.status.cancelled = true;
      ref.status.complete = true;
      if (promiseActions) {
        promiseActions[0](ref);
      }
      if (job) {
        /* istanbul ignore else */
        if (typeof job.cancelled === 'function') {
          promises.push(job.cancelled());
        } else if (process.env.NODE_ENV !== 'production') {
          console.warn(
            `[WARN] | task-handler | Async Job "${id}" was cancelled but provided no "cancelled" handler.`,
          );
        }
      }
    },
    // $FlowIgnore
    [EXECUTE_RESULT](err, result) {
      if (!ref.status.complete) {
        lastResult = result;
        if (ref.type !== 'every') {
          ref.status.complete = true;
        }
        if (promiseActions) {
          if (err) {
            const error: { taskRef?: Task$Ref } & Error = typeof err === 'object' ? err : new Error(err);
            error.taskRef = ref;
            return promiseActions[1](error);
          }
          return promiseActions[0](ref);
        }
      }
    },
    id,
    type,
    task: handler,
    resolve(result) {
      // $FlowIgnore
      return ref[EXECUTE_RESULT](undefined, result);
    },
    reject(err) {
      // $FlowIgnore
      return ref[EXECUTE_RESULT](err);
    },
    cancel() {
      lastResult = TASK_CANCELLED;
      ref.status.cancelled = true;
      handler.cancel(id);
    },
  };

  if (jobDescriptor) {
    job = jobDescriptor[0].apply(ref, jobDescriptor[1]);
    ref.promise().catch(NOOP);
    job.start.call(ref, ref);
  }

  return Object.freeze(ref);
}

export default function createTaskHandler(): Task$Handler {
  const refs: Task$RefMap = new Map();
  let queue;

  function getQueue() {
    if (queue) {
      return queue;
    }
    queue = createDeferQueue(refs);
    return queue;
  }

  function cancelID(id: any, promises: Array<any>): void {
    // Required for Flow to resolve
    const descriptor = refs.get(id);
    if (!descriptor) return;
    const [ref, canceller] = descriptor;
    canceller();
    refs.delete(id);
    // $FlowIgnore
    ref[TASK_CANCELLED](promises);
  }

  function execute<R: Task$Ref, +A: Array<any>, +F:(...args: A) => any>(
    ref: R,
    fn: void | F,
    args: A) {
    try {
      const result = typeof fn === 'function' ? fn(...args) : undefined;
      // $FlowIgnore
      ref[EXECUTE_RESULT](undefined, result);
    } catch (e) {
      // $FlowIgnore
      ref[EXECUTE_RESULT](e);
    }
  }

  const handler = Object.freeze({
    get size(): number {
      return refs.size;
    },
    after<+ID: any, +A: Array<any>, +F: (...args: A) => any>(
      id: ID,
      delay: number,
      fn?: F,
      ...args: A
    ): Task$Ref {
      const ref = createTaskRef('after', id, handler);
      const timeoutID = setTimeout(execute, delay, ref, fn, args);
      refs.set(id, [ref, () => clearTimeout(timeoutID)]);
      return ref;
    },
    defer<+ID: any, +A: Array<any>, +F: (...args: A) => any>(
      id: ID,
      fn?: F,
      ...args: A
    ): Task$Ref {
      const ref = createTaskRef('defer', id, handler);
      const cancelDefer = getQueue().add(ref, () => execute(ref, fn, args));
      refs.set(id, [ref, () => cancelDefer()]);
      return ref;
    },
    every<+ID: any, +A: Array<any>, +F: (...args: A) => any>(
      id: ID,
      interval: number,
      fn?: F,
      ...args: A
    ): Task$Ref {
      const ref = createTaskRef('every', id, handler);
      const timerID = setInterval(execute, interval, ref, fn, args);
      refs.set(id, [ref, () => clearInterval(timerID)]);
      return ref;
    },
    everyNow<+ID: any, +A: Array<any>>(
      id: ID,
      interval: number,
      fn?: (...args: A) => any,
      ...args: A
    ): Task$Ref {
      const ref = createTaskRef('every', id, handler);
      const timerID = setInterval(execute, interval, ref, fn, args);
      const cancelDefer = getQueue().add(id, () => execute(ref, fn, args));
      refs.set(id, [
        ref,
        () => {
          clearInterval(timerID);
          cancelDefer();
        },
      ]);
      return ref;
    },
    job<+ID: any, +A: Array<any>>(
      id: ID,
      getJob: (...args: A) => any,
      ...args: A
    ): Task$Ref {
      const ref = createTaskRef('job', id, handler, [
        getJob,
        args || STATIC_EMPTY_ARRAY,
      ]);
      refs.set(id, [ref, NOOP]);
      return ref;
    },
    cancel(...ids: Array<any>) {
      const promises = [];
      ids.forEach(id => cancelID(id, promises));
      return {
        promise() {
          return Promise.all(promises);
        },
      };
    },
    clear() {
      return handler.cancel(...Array.from(refs.keys()));
    },
  });

  return handler;
}
