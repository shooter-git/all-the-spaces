import { signToken } from '@ats/shared';

/** Talks to the supervisor: each call carries a one-minute ticket for exactly that action. */
export interface Supervisor {
  call<T = Record<string, unknown>>(
    act: string,
    claims: Record<string, unknown>,
    body?: Record<string, unknown>,
  ): Promise<T>;
  raw(
    act: string,
    claims: Record<string, unknown>,
    body?: Record<string, unknown>,
  ): Promise<Buffer | null>;
  /** A WebSocket URL for one terminal. */
  terminalUrl(claims: Record<string, unknown>, cols: number, rows: number): string;
}

export class SupervisorError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export function createSupervisor(url: string, secret: string): Supervisor {
  const post = (act: string, claims: Record<string, unknown>, body: Record<string, unknown> = {}) =>
    fetch(`${url}/v1/${act}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ticket: signToken('supervisor', { act, ...claims }, secret, 60),
        ...body,
      }),
      signal: AbortSignal.timeout(10 * 60_000),
    });
  return {
    async call(act, claims, body) {
      const once = async (extra: Record<string, unknown> = {}) => {
        const res = await post(act, claims, { ...body, ...extra });
        const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok)
          throw new SupervisorError(String(json.error ?? `Supervisor: ${res.status}`), res.status);
        return json;
      };
      // Work that takes a while is waited on in calls of under a minute each (see the
      // supervisor's `held`): Node's fetch gives up on a reply that takes five.
      let json = await once();
      while (json.pending === true) json = await once({ wait: true });
      return json as never;
    },
    async raw(act, claims, body) {
      const res = await post(act, claims, body);
      if (res.status === 404) return null;
      if (!res.ok) throw new SupervisorError(`Supervisor: ${res.status}`, res.status);
      return Buffer.from(await res.arrayBuffer());
    },
    terminalUrl(claims, cols, rows) {
      const ticket = signToken('supervisor', { act: 'terminal', ...claims }, secret, 60);
      return `${url.replace(/^http/, 'ws')}/v1/terminal?ticket=${encodeURIComponent(ticket)}&cols=${cols}&rows=${rows}`;
    },
  };
}
