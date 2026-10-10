import {
  type CreationMessage,
  type HostMessage,
  type Json,
  type ResultCode,
  readHostMessage,
  wrap,
} from '@allthespaces/bridge-protocol';

type Handler = (msg: HostMessage) => void;
type WithoutId<M> = M extends { id: number } ? Omit<M, 'id'> : never;
type Request = Extract<CreationMessage, { id: number }>;

/** The app said no to a request: `code` says why (see `ResultCode`), `details` may say more. */
export class BridgeError extends Error {
  constructor(
    message: string,
    readonly code?: ResultCode,
    readonly details?: Json,
  ) {
    super(message);
  }
}

/** How long a request waits for the app's answer before giving up (as `upstream`). */
export const REQUEST_TIMEOUT_MS = 20_000;

/** The creation's side of the bridge: messages to and from the host page. */
export class Bridge {
  private readonly handlers = new Set<Handler>();
  private readonly pending = new Map<
    number,
    { resolve: (d: Json | undefined) => void; reject: (e: Error) => void }
  >();
  private nextId = 1;

  constructor(private host: Pick<Window, 'postMessage'> = window.parent) {
    window.addEventListener('message', (e) => {
      // Only the page we live in may talk to us.
      if (e.source !== this.host || this.host === window) return;
      this.deliver(e.data);
    });
  }

  /** Talk to a stand-in host instead (standalone mode, while developing). */
  useHost(host: Pick<Window, 'postMessage'>) {
    this.host = host;
  }

  /** Handles a message from the host. */
  deliver(data: unknown) {
    const msg = readHostMessage(data);
    if (!msg) return;
    if (msg.type === 'ping') {
      this.post({ type: 'pong', n: msg.n });
      return;
    }
    if (msg.type === 'result') {
      const p = this.pending.get(msg.re);
      this.pending.delete(msg.re);
      if (msg.ok) p?.resolve(msg.data);
      else p?.reject(new BridgeError(msg.error, msg.code, msg.details));
      return;
    }
    for (const h of this.handlers) h(msg);
  }

  post(msg: CreationMessage) {
    this.host.postMessage(wrap(msg), '*');
  }

  /**
   * Sends a request and waits for the host's answer: at most `REQUEST_TIMEOUT_MS`, after which
   * it fails with `code: 'upstream'` (an older app that doesn't know the request never answers).
   */
  request(msg: WithoutId<Request>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Json | undefined> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new BridgeError("The app didn't answer in time.", 'upstream'));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (d) => {
          clearTimeout(timer);
          resolve(d);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.post({ ...msg, id } as CreationMessage);
    });
  }

  on(handler: Handler) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
}
