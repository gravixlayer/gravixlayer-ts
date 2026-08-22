/**
 * Errors, timeouts, cancellation, and retries.
 *
 * Every failure the SDK raises derives from `GravixLayerError`, with a subclass
 * per category so you can react to the ones you can do something about and let
 * the rest propagate. Transient failures are retried for you.
 *
 * Run:
 *   export GRAVIXLAYER_API_KEY="your-api-key"
 *   npx tsx examples/runtimes/20-error-handling.ts
 */

import {
  GravixLayer,
  GravixLayerAbortError,
  GravixLayerAuthenticationError,
  GravixLayerError,
  GravixLayerInvalidArgumentError,
  GravixLayerRateLimitError,
  GravixLayerTimeoutError,
} from 'gravixlayer';

// Retries apply to connection failures and to 429, 502, 503, and 504, with
// exponential backoff and jitter. Everything else fails immediately.
const client = new GravixLayer({
  timeout: 30_000,
  maxRetries: 3,
});

// 1. Arguments are checked before anything leaves the process, so a mistake
//    costs no round trip.
try {
  await client.runtimes.retrieve('not-a-uuid');
} catch (error) {
  if (error instanceof GravixLayerInvalidArgumentError) {
    console.log(`Invalid    : ${error.message}`);
  }
}

// 2. A bad key is reported as an authentication error, not a generic failure.
try {
  const misconfigured = new GravixLayer({ apiKey: 'not-a-real-key' });
  await misconfigured.warmup();
} catch (error) {
  if (error instanceof GravixLayerAuthenticationError) {
    console.log(`Auth       : ${error.message} (status ${error.status})`);
  }
}

// 3. Cancellation. An abort signal reaches the underlying request, so long
//    operations stop as soon as you ask them to.
const controller = new AbortController();
setTimeout(() => controller.abort(), 50);

try {
  await client.runtimes.list({ signal: controller.signal });
} catch (error) {
  if (error instanceof GravixLayerAbortError) {
    console.log(`Cancelled  : ${error.message}`);
  }
}

// 4. A per-call timeout overrides the client's, which is useful for one slow
//    operation among many fast ones.
try {
  await client.runtimes.list({ timeout: 1 });
} catch (error) {
  if (error instanceof GravixLayerTimeoutError) {
    console.log(`Timed out  : ${error.message}`);
  }
}

// 5. In real code, handle what you can and let the rest bubble up. Errors
//    carry the status, the response body, and the request id when the API
//    returned one, which is what support will ask for.
const TEMPLATE = process.env['GRAVIXLAYER_TEMPLATE'] ?? 'base-small';

try {
  const runtime = await client.runtimes.create({ template: TEMPLATE });
  console.log(`\nCreated    : ${runtime.runtimeId}`);
  await runtime.kill();
  console.log('Terminated.');
} catch (error) {
  if (error instanceof GravixLayerRateLimitError) {
    // The SDK already retried; getting here means the limit persisted.
    console.error(`Rate limited. Retry after ${error.retryAfterSeconds ?? 'unknown'}s.`);
  } else if (error instanceof GravixLayerError) {
    console.error(`Request failed: ${error.message}`);
    console.error(`  status     : ${error.status ?? 'n/a'}`);
    console.error(`  request id : ${error.requestId ?? 'n/a'}`);
  } else {
    throw error;
  }
}
