/** Shared base for every API resource. */

import type { Transport } from '../core/transport.js';

/**
 * The slice of the client a resource depends on.
 *
 * Declaring it as an interface keeps resources decoupled from the concrete
 * client class, which avoids an import cycle and makes them simple to test.
 */
export interface ClientContext {
  /** The configured HTTP engine. */
  readonly transport: Transport;
  /** Default cloud applied when a call does not specify one. */
  readonly cloud: string;
  /** Default region applied when a call does not specify one. */
  readonly region: string;
}

/** Base class providing every resource with its client context. */
export abstract class APIResource {
  constructor(protected readonly client: ClientContext) {}

  /** Convenience accessor for the transport. */
  protected get http(): Transport {
    return this.client.transport;
  }

  /** The client's default cloud. */
  protected get cloud(): string {
    return this.client.cloud;
  }

  /** The client's default region. */
  protected get region(): string {
    return this.client.region;
  }
}
