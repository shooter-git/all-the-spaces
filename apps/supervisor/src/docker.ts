/**
 * A small client for the Docker Engine API over its Unix socket: only the calls the supervisor
 * needs. Kept deliberately thin so the one privileged service stays easy to read.
 */
import { request as httpRequest, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

export class DockerError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export interface Docker {
  json<T>(method: string, path: string, body?: unknown): Promise<T>;
  raw(
    method: string,
    path: string,
    body?: Buffer | NodeJS.ReadableStream,
    type?: string,
  ): Promise<IncomingMessage>;
  /** Starts an exec and returns its raw stream (with a TTY) or multiplexed stream (without). */
  hijack(path: string, body: unknown): Promise<Duplex>;
}

export function docker(socketPath = '/var/run/docker.sock'): Docker {
  const base = '/v1.44';
  const raw: Docker['raw'] = (method, path, body, type) =>
    new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          socketPath,
          method,
          path: `${base}${path}`,
          headers: body ? { 'content-type': type ?? 'application/json' } : {},
        },
        resolve,
      );
      req.on('error', reject);
      if (body instanceof Buffer) req.end(body);
      else if (body) (body as NodeJS.ReadableStream).pipe(req);
      else req.end();
    });
  const json: Docker['json'] = async <T>(method: string, path: string, body?: unknown) => {
    const res = await raw(
      method,
      path,
      body === undefined ? undefined : Buffer.from(JSON.stringify(body)),
    );
    const chunks: Buffer[] = [];
    for await (const c of res) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    const status = res.statusCode ?? 500;
    if (status >= 400) {
      let message = text;
      try {
        message = JSON.parse(text).message ?? text;
      } catch {}
      throw new DockerError(message.trim(), status);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  };
  const hijack: Docker['hijack'] = (path, body) =>
    new Promise((resolve, reject) => {
      const payload = Buffer.from(JSON.stringify(body));
      const req = httpRequest({
        socketPath,
        method: 'POST',
        path: `${base}${path}`,
        headers: {
          'content-type': 'application/json',
          'content-length': payload.length,
          connection: 'Upgrade',
          upgrade: 'tcp',
        },
      });
      req.on('upgrade', (_res, socket) => resolve(socket));
      req.on('response', (res) =>
        reject(new DockerError(`exec start: ${res.statusCode}`, res.statusCode ?? 500)),
      );
      req.on('error', reject);
      req.end(payload);
    });
  return { json, raw, hijack };
}

/**
 * Splits Docker's multiplexed exec output (no TTY) into stdout and stderr.
 * Frames: [stream, 0, 0, 0, size (4 bytes big-endian)] then the payload.
 */
export async function demux(stream: AsyncIterable<Buffer>, limit = 64 * 1024 * 1024) {
  let buf = Buffer.alloc(0);
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 8) {
      const size = buf.readUInt32BE(4);
      if (buf.length < 8 + size) break;
      const payload = buf.subarray(8, 8 + size);
      total += size;
      if (total > limit) throw new Error('Too much output');
      (buf[0] === 2 ? err : out).push(payload);
      buf = buf.subarray(8 + size);
    }
  }
  return { stdout: Buffer.concat(out), stderr: Buffer.concat(err) };
}
