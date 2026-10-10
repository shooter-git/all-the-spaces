import { lookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { isInternalAddress } from '../bucket-address.ts';

/**
 * One request from the server to a connector's service, and nothing more: no redirects followed,
 * no cookies, no proxy from the environment, a deadline, and an answer read only up to a cap.
 *
 * The connection goes to an address chosen once, before connecting: the owner's `resolveTo` for
 * the connector's own host, or else what the name resolves to, which must be a public address
 * unless the owner allowed private ones. The name is still what's checked against the
 * certificate and sent as Host, so a name that resolves differently a moment later (DNS
 * rebinding) can't send the request anywhere else.
 */
export interface Pinning {
  /** The connector's own host (from its base URL), and the `host:port` to connect to instead. */
  resolveTo?: { host: string; target: string } | undefined;
  allowPrivateAddress: boolean;
}

export class HttpError extends Error {
  readonly kind: 'blocked' | 'timeout' | 'network' | 'too-big';
  constructor(message: string, kind: HttpError['kind']) {
    super(message);
    this.kind = kind;
  }
}

export interface HttpAnswer {
  status: number;
  contentType: string;
  body: Buffer;
  /** Every header (repository hosts read Location and ETag; connectors don't pass them on). */
  headers: IncomingHttpHeaders;
}

/** What the server calls itself to a connector's service. */
export const userAgent = (release: string) =>
  `ATS-connector/${release.replace(/[^\w.+-]/g, '').slice(0, 40) || 'development'}`;

async function connectTo(url: URL, pin: Pinning): Promise<{ host: string; port: number }> {
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (pin.resolveTo && url.hostname === pin.resolveTo.host) {
    const m = /^(.*):(\d+)$/.exec(pin.resolveTo.target);
    return { host: (m?.[1] ?? '').replace(/^\[|\]$/g, ''), port: Number(m?.[2]) };
  }
  const name = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(name)
    ? [name]
    : await lookup(name, { all: true, verbatim: true }).then(
        (found) => found.map((a) => a.address),
        () => [] as string[],
      );
  if (!addresses.length) throw new HttpError(`${name} could not be found`, 'network');
  // Every address it has must be public: a name that also points inside isn't trusted at all.
  if (!pin.allowPrivateAddress && addresses.some(isInternalAddress))
    throw new HttpError(`${name} is on a private network`, 'blocked');
  return { host: addresses[0] as string, port };
}

/** Sends a request and reads the answer (at most `maxBytes` of it). */
export async function send(
  target: string,
  opts: {
    method: string;
    headers: Record<string, string>;
    body?: string | undefined;
    timeoutMs: number;
    maxBytes: number;
    pin: Pinning;
  },
): Promise<HttpAnswer> {
  const url = new URL(target);
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new HttpError('Only http(s) addresses', 'blocked');
  const deadline = AbortSignal.timeout(opts.timeoutMs);
  const to = await connectTo(url, opts.pin);
  const secure = url.protocol === 'https:';
  const name = url.hostname.replace(/^\[|\]$/g, '');
  return new Promise<HttpAnswer>((resolve, reject) => {
    const req = (secure ? httpsRequest : httpRequest)(
      {
        host: to.host,
        port: to.port,
        method: opts.method,
        path: `${url.pathname}${url.search}`,
        headers: {
          ...opts.headers,
          host: url.host,
          ...(opts.body !== undefined ? { 'content-length': Buffer.byteLength(opts.body) } : {}),
        },
        // The certificate must be for the name, wherever the connection goes.
        ...(secure && !isIP(name) ? { servername: name } : {}),
        // A connection of its own each time: nothing is shared or kept between people.
        agent: false,
        signal: deadline,
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > opts.maxBytes) {
            res.destroy();
            req.destroy();
            reject(new HttpError('The answer was too big', 'too-big'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            contentType: String(res.headers['content-type'] ?? ''),
            body: Buffer.concat(chunks),
            headers: res.headers,
          }),
        );
        res.on('error', (err) =>
          reject(
            deadline.aborted
              ? new HttpError('No answer in time', 'timeout')
              : new HttpError(err.message, 'network'),
          ),
        );
      },
    );
    req.on('error', (err) =>
      reject(
        deadline.aborted
          ? new HttpError('No answer in time', 'timeout')
          : err instanceof HttpError
            ? err
            : new HttpError(err.message, 'network'),
      ),
    );
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

/** Whether a content type is JSON (`application/json`, or `application/<x>+json`). */
export const isJson = (contentType: string) =>
  /^application\/(?:[\w.-]+\+)?json(?:\s*;|$)/i.test(contentType.trim());

/** The pinning for a connector, from its definition. */
export function pinningFor(def: {
  baseUrl: string;
  resolveTo?: string | undefined;
  allowPrivateAddress: boolean;
}): Pinning {
  return {
    allowPrivateAddress: def.allowPrivateAddress,
    ...(def.resolveTo
      ? { resolveTo: { host: new URL(def.baseUrl).hostname, target: def.resolveTo } }
      : {}),
  };
}
