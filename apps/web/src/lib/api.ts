export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The server's machine-readable reason, when it gives one (e.g. `stale`). */
    readonly code?: string,
    /** The whole answer, for the few callers that need more than the message (connector calls). */
    readonly body?: unknown,
  ) {
    super(message);
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Calls the API. A request that never got an answer (the network blinked: on a computer running
 * Docker, Chrome cancels everything in flight whenever a container starts or stops) is tried
 * again, twice, if it's safe to repeat: every GET, and anything marked `retry`.
 */
export async function api<T>(
  path: string,
  init: RequestInit & { json?: unknown; retry?: boolean } = {},
): Promise<T> {
  const { json, headers, retry, ...rest } = init;
  const method = rest.method ?? (json === undefined ? 'GET' : 'POST');
  const again = retry ?? method === 'GET';
  const send = () =>
    fetch(path, {
      credentials: 'include',
      ...rest,
      method,
      headers: {
        ...(json === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    });
  let res: Response | undefined;
  for (let tries = 0; !res; tries++) {
    try {
      res = await send();
    } catch {
      if (!again || tries >= 2 || rest.signal?.aborted) {
        throw new ApiError('The connection dropped. Check you’re online and try again.', 0);
      }
      await wait(500 * (tries + 1));
    }
  }
  const body = (await res.json().catch(() => ({}))) as {
    error?: string;
    message?: string;
    code?: string;
  };
  if (!res.ok) {
    throw new ApiError(
      body.error ?? body.message ?? 'Something went wrong. Please try again.',
      res.status,
      body.code,
      body,
    );
  }
  return body as T;
}

export type { Me } from '@ats/api-types';
