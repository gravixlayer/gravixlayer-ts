/** Timing helpers shared by the polling loops in the SDK. */

/**
 * Wait for `ms`, resolving early and rejecting if the caller aborts.
 *
 * Polling loops use this instead of a bare `setTimeout` so that cancelling a
 * request cancels the wait too, rather than leaving a timer holding the
 * process open until it fires.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      reject(signal?.reason);
    }

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
