/**
 * Publishing a guest port to a public HTTPS URL.
 *
 * A server listening inside a runtime is not reachable from the internet until
 * its port is published. Publishing returns a URL, and by default a token that
 * must accompany every request to it.
 */

import {
  errorFromStatus,
  formatErrorMessage,
  GravixLayerAbortError,
  GravixLayerConnectionError,
  GravixLayerError,
  GravixLayerTimeoutError,
} from '../../core/errors.js';
import { asRecord, parseList } from '../../core/parse.js';
import type { FetchLike, RequestOptions } from '../../core/transport.js';
import { SERVICES } from '../../core/url.js';
import { assertPort, assertRuntimeId } from '../../core/validate.js';
import { parseRuntimeWebService, type RuntimeWebService } from '../../types/runtime.js';
import { APIResource } from '../resource.js';

/** Header carrying the access token for a private published service. */
const SERVICE_TOKEN_HEADER = 'X-Gravix-Web-Service-Token';

/** How long a published URL lasts by default, in seconds. */
const DEFAULT_EXPIRY_SECONDS = 3600;

/** Default timeout for requests sent to a published service, in milliseconds. */
const DEFAULT_SERVICE_TIMEOUT_MS = 60_000;

/** Options for {@link RuntimeService.publish}. */
export interface PublishOptions extends RequestOptions {
  /** Seconds until the URL stops working. Defaults to one hour. */
  expiresInSeconds?: number;
  /** Serve without a token, making the URL reachable by anyone who has it. */
  isPublic?: boolean;
  /** Issue a new token, invalidating the previous one. */
  rotateToken?: boolean;
}

/** Publish and revoke public URLs for ports inside a runtime. */
export class RuntimeService extends APIResource {
  /**
   * Publish a guest port and return its URL.
   *
   * @example
   * ```ts
   * const service = await client.runtime.service.publish(runtimeId, 8000);
   * console.log(service.url);
   * ```
   */
  async publish(
    runtimeId: string,
    port: number,
    options: PublishOptions = {},
  ): Promise<RuntimeWebService> {
    assertRuntimeId(runtimeId);
    assertPort(port);

    const requestOptions: RequestOptions = {};
    if (options.signal) requestOptions.signal = options.signal;
    if (options.timeout !== undefined) requestOptions.timeout = options.timeout;
    if (options.maxRetries !== undefined) requestOptions.maxRetries = options.maxRetries;
    if (options.headers) requestOptions.headers = options.headers;

    return parseRuntimeWebService(
      asRecord(
        await this.http.request({
          method: 'POST',
          path: `runtime/${runtimeId}/services`,
          service: SERVICES.agents,
          body: {
            port,
            expires_in_seconds: options.expiresInSeconds ?? DEFAULT_EXPIRY_SECONDS,
            is_public: options.isPublic ?? false,
            rotate_token: options.rotateToken ?? false,
          },
          options: requestOptions,
        }),
      ),
    );
  }

  /**
   * Publish a port and return a client bound to its URL.
   *
   * The returned handle attaches the access token automatically, so you can
   * call the service without assembling headers yourself.
   */
  async connect(
    runtimeId: string,
    port: number,
    options: PublishOptions = {},
  ): Promise<ServiceHandle> {
    return new ServiceHandle(await this.publish(runtimeId, port, options), this.http.fetch);
  }

  /** List the runtime's published services. */
  async list(runtimeId: string, options: RequestOptions = {}): Promise<RuntimeWebService[]> {
    assertRuntimeId(runtimeId);

    const data = asRecord(
      await this.http.request({
        method: 'GET',
        path: `runtime/${runtimeId}/services`,
        service: SERVICES.agents,
        options,
      }),
    );
    return parseList(data, 'services', parseRuntimeWebService);
  }

  /** Stop publishing a port. The URL stops resolving immediately. */
  async revoke(runtimeId: string, port: number, options: RequestOptions = {}): Promise<void> {
    assertRuntimeId(runtimeId);
    assertPort(port);

    await this.http.requestVoid({
      method: 'DELETE',
      path: `runtime/${runtimeId}/services/${port}`,
      service: SERVICES.agents,
      options,
    });
  }
}

/** Per-request options for calls made through a {@link ServiceHandle}. */
export interface ServiceRequestInit extends Omit<RequestInit, 'signal'> {
  signal?: AbortSignal;
  /** Timeout in milliseconds. Defaults to 60 seconds. */
  timeout?: number;
}

/**
 * An HTTP client bound to one published service.
 *
 * Requests go straight to the service's public URL, not through the control
 * plane, and carry the access token when the service is private.
 *
 * @example
 * ```ts
 * const api = await client.runtime.service.connect(runtimeId, 8000);
 * const response = await api.get('/health');
 * console.log(await response.json());
 * ```
 */
export class ServiceHandle {
  constructor(
    readonly service: RuntimeWebService,
    /** The client's `fetch`, so a custom one still applies to these calls. */
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
  ) {}

  /** The service's base URL. */
  get url(): string {
    return this.service.serviceUrl;
  }

  /**
   * Send a request to a path on the service.
   *
   * The response is returned as-is, including error statuses, because a
   * service speaks its own protocol. Transport failures are reported with the
   * SDK's error types.
   */
  async request(method: string, path = '/', init: ServiceRequestInit = {}): Promise<Response> {
    const { timeout = DEFAULT_SERVICE_TIMEOUT_MS, signal, headers, ...rest } = init;

    const merged = new Headers(headers);
    if (this.service.token && !this.service.isPublic) {
      merged.set(SERVICE_TOKEN_HEADER, this.service.token);
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer =
      timeout > 0
        ? setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, timeout)
        : undefined;
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    // A trailing slash on the base keeps `URL` from discarding its last path
    // segment when the service is published under a prefix.
    const base = this.url.endsWith('/') ? this.url : `${this.url}/`;

    try {
      return await this.fetchImpl(new URL(path.replace(/^\/+/, ''), base).toString(), {
        ...rest,
        method,
        headers: merged,
        signal: controller.signal,
      });
    } catch (error) {
      if (signal?.aborted) {
        throw new GravixLayerAbortError('Request aborted.', { cause: signal.reason });
      }
      if (timedOut) {
        throw new GravixLayerTimeoutError(`Request timed out after ${timeout}ms.`, {
          cause: error,
        });
      }
      throw new GravixLayerConnectionError(error instanceof Error ? error.message : String(error), {
        cause: error,
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /** Send a GET request. */
  get(path = '/', init: ServiceRequestInit = {}): Promise<Response> {
    return this.request('GET', path, init);
  }

  /** Send a POST request. */
  post(path = '/', init: ServiceRequestInit = {}): Promise<Response> {
    return this.request('POST', path, init);
  }

  /** Send a PUT request. */
  put(path = '/', init: ServiceRequestInit = {}): Promise<Response> {
    return this.request('PUT', path, init);
  }

  /** Send a PATCH request. */
  patch(path = '/', init: ServiceRequestInit = {}): Promise<Response> {
    return this.request('PATCH', path, init);
  }

  /** Send a DELETE request. */
  delete(path = '/', init: ServiceRequestInit = {}): Promise<Response> {
    return this.request('DELETE', path, init);
  }

  /**
   * Send a JSON body and parse the JSON response.
   *
   * Unlike the raw verbs, this treats an error status as a failure and throws
   * the matching SDK error, since there is no parsed body to hand back.
   */
  async postJson<T = unknown>(
    path: string,
    body: unknown,
    init: ServiceRequestInit = {},
  ): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('content-type', 'application/json');

    const response = await this.request('POST', path, {
      ...init,
      headers,
      body: JSON.stringify(body),
    });

    const text = await response.text();
    if (!response.ok) {
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : undefined;
      } catch {
        parsed = undefined;
      }
      throw errorFromStatus(
        response.status,
        formatErrorMessage(text, parsed) || 'The service returned an error.',
        { body: parsed ?? text },
      );
    }

    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new GravixLayerError('The service returned a malformed JSON response.', {
        status: response.status,
        body: text,
        cause,
      });
    }
  }
}
