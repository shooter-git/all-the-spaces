import type { ConnectorStatus, Json, UpstreamError } from '@allthespaces/bridge-protocol';
import { type Bridge, BridgeError } from './bridge.ts';

export type { ConnectorStatus, UpstreamError };

/** A connector call the app or the service refused. `code` says why; `upstream`, what the service said. */
export class ConnectorError extends BridgeError {
  /** The service's own answer, cleaned up by the app (when it got that far). */
  readonly upstream: UpstreamError | null;
  constructor(err: BridgeError) {
    super(err.message, err.code, err.details);
    const d = err.details;
    this.upstream =
      d && typeof d === 'object' && !Array.isArray(d) && typeof d.status === 'number'
        ? (d as unknown as UpstreamError)
        : null;
  }
}

export interface CallOptions {
  /** Filled into the operation's path (`:bookId`), the rest go in its query string. */
  params?: { [key: string]: Json };
  /** The JSON body, for operations that take one. */
  body?: Json;
  /**
   * Required for operations that change things: one key per change the person makes (8 to 80
   * letters, digits, `_` or `-`), reused when you retry that same change, so it's done once.
   */
  idempotencyKey?: string;
}

/**
 * Services the server's owner installed (docs/connectors.md), which a creation may call as the
 * person playing: list each one and the operations it uses in `ats.json` `connectors`. The app
 * makes every call, with the person's own linked account, after an Architect approved it.
 */
export class PortalConnectors {
  constructor(private readonly bridge: Bridge) {}

  /**
   * Calls an operation. Resolves with the service's answer (`status`, and its JSON `data`);
   * rejects with a `ConnectorError` whose `code` is `not-linked` (offer `link()`), `clash`
   * (changed meanwhile: read again), `rejected`, `denied`, `upstream` (try later), `too-big`,
   * `not-approved` or `trial`.
   */
  async call<T extends Json = Json>(
    connector: string,
    op: string,
    options: CallOptions = {},
  ): Promise<{ status: number; data: T }> {
    try {
      return (await this.bridge.request({
        type: 'connector:call',
        connector,
        op,
        ...(options.params !== undefined ? { params: options.params } : {}),
        ...(options.body !== undefined ? { body: options.body } : {}),
        ...(options.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {}),
      })) as { status: number; data: T };
    } catch (err) {
      throw err instanceof BridgeError ? new ConnectorError(err) : err;
    }
  }

  /** Whether the person has linked their account (and whether the server has the connector). */
  async status(connector: string): Promise<ConnectorStatus> {
    return (await this.bridge.request({
      type: 'connector:status',
      connector,
    })) as unknown as ConnectorStatus;
  }

  /**
   * Asks the app to offer linking the person's account. The app shows its own card over yours;
   * if they go ahead, they leave for the service and come back to the space, and open your
   * creation again (check `status()` when you start). Resolves once the card is showing.
   */
  async link(connector: string): Promise<void> {
    try {
      await this.bridge.request({ type: 'connector:link', connector });
    } catch (err) {
      throw err instanceof BridgeError ? new ConnectorError(err) : err;
    }
  }

  /** A fresh idempotency key for one change the person makes. */
  newKey(): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
}
