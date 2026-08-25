/** Timing helpers shared by the polling loops and request deadlines in the SDK. */

/**
 * Extra time the HTTP request waits after a guest command's own deadline.
 *
 * The server kills the process at `timeoutSeconds`; the client has to outlast
 * that plus the round trip that carries the result, otherwise a command that
 * ran to completion looks like a transport timeout.
 */
export const GUEST_DEADLINE_MARGIN_MS = 30_000;

/**
 * HTTP timeout for an operation that already has a guest-side deadline.
 *
 * An explicit per-request `timeout` always wins. When only the guest deadline
 * is set, the transport waits that long plus {@link GUEST_DEADLINE_MARGIN_MS}.
 * `undefined` means "use the client default".
 */
export function timeoutForGuestDeadline(
  timeoutSeconds: number | undefined,
  explicitTimeout: number | undefined,
): number | undefined {
  if (explicitTimeout !== undefined) return explicitTimeout;
  if (timeoutSeconds === undefined) return undefined;
  return timeoutSeconds * 1000 + GUEST_DEADLINE_MARGIN_MS;
}

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
