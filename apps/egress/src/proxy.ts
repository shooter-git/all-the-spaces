/**
 * The egress proxy: the only way out of an Architect's sandbox.
 *
 * - HTTPS only, as an HTTP CONNECT tunnel to port 443 of an allow-listed host name.
 * - It never looks inside the tunnel: no TLS interception, no certificates, no tokens. It sees
 *   host names, nothing else.
 * - Host names with any private, loopback, link-local or other special-purpose address are
 *   refused, so the allow-list can't be used to reach the platform's own services.
 * - Every decision is logged as one line of JSON (time, source, host, allowed or not), which the
 *   Studio uses to explain what was blocked. Nothing else is logged.
 * - A workspace whose group allows the whole internet shows a pass (signed with a secret this
 *   proxy shares with the supervisor) as its proxy password: it may reach any public host name
 *   over HTTPS. Never a private address or a host on the deny-list, and still nothing is looked
 *   inside.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { isIP, connect as netConnect, type Socket } from 'node:net';

export interface ProxyOptions {
  /** Host names allowed, exact (`api.example.com`) or a whole domain (`*.example.com`). */
  allow: string[];
  /** Allow tunnels to private addresses (tests only). */
  allowPrivate?: boolean;
  /** Ports that may be reached (default: 443). */
  ports?: number[];
  log?: (entry: Record<string, unknown>) => void;
  /** Open tunnels at most, per source address. */
  maxPerSource?: number;
  /** How host names are resolved (tests): every address the name has. */
  resolve?: (host: string) => Promise<string | string[]>;
  /** Checks the passes for open internet (no secret: nobody has one). */
  secret?: string;
  /** Hosts never reached, whatever the allow-list or a pass says (same patterns as `allow`). */
  deny?: string[];
}

/** A workspace's pass for open internet: its proxy password (the user name is `ws-<id>`). */
export function openPass(secret: string, workspace: string): string {
  return createHmac('sha256', secret).update(`open:${workspace}`).digest('hex');
}

/** The workspace whose valid pass came with this request, if any. */
export function openWorkspace(header: string | string[] | undefined, secret?: string) {
  if (!secret || typeof header !== 'string' || !/^basic /i.test(header)) return null;
  const [user = '', pass = ''] = Buffer.from(header.slice(6).trim(), 'base64')
    .toString('utf8')
    .split(/:(.*)/s);
  const m = /^ws-([\w-]{1,64})$/.exec(user);
  if (!m?.[1]) return null;
  const want = Buffer.from(openPass(secret, m[1]));
  const got = Buffer.from(pass);
  return got.length === want.length && timingSafeEqual(got, want) ? m[1] : null;
}

/** A dotted DNS name: single labels (container names on internal networks) never match. */
const HOST =
  /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function allows(allow: string[], host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (!HOST.test(h)) return false;
  return allow.some((rule) => {
    const r = rule.trim().toLowerCase();
    if (!r) return false;
    if (r.startsWith('*.')) return h.endsWith(r.slice(1)) && h.length > r.length - 1;
    return h === r;
  });
}

/** Addresses a tunnel must never reach: this machine, private networks, cloud metadata. */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a = 0, b = 0, c = 0] = ip.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && c === 0) || // IETF protocol assignments
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
  // NAT64 (well-known and local-use prefixes): an IPv4 address in disguise, possibly a private one.
  if (v.startsWith('64:ff9b:')) return true;
  return (
    v === '::' ||
    v === '::1' ||
    v.startsWith('fc') ||
    v.startsWith('fd') ||
    v.startsWith('fe8') ||
    v.startsWith('fe9') ||
    v.startsWith('fea') ||
    v.startsWith('feb') ||
    v.startsWith('ff')
  );
}

export function createProxy(opts: ProxyOptions): Server {
  const ports = new Set(opts.ports ?? [443]);
  const log = opts.log ?? ((e) => console.log(JSON.stringify(e)));
  const open = new Map<string, number>();
  const server = createServer((req, res) => {
    req.socket.on('error', () => req.socket.destroy());
    // Plain HTTP (unencrypted, or asking the proxy to fetch something) is never allowed.
    log({
      at: new Date().toISOString(),
      from: req.socket.remoteAddress,
      host: hostOf(req.url),
      allowed: false,
      why: 'not-https',
    });
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('Only HTTPS to allowed hosts is possible from here.\n');
  });

  // A client hanging up abruptly must never take the proxy down for everyone else.
  server.on('clientError', (_err, socket) => socket.destroy());
  server.on('connect', async (req: IncomingMessage, client: Socket, head: Buffer) => {
    client.on('error', () => client.destroy());
    const from = client.remoteAddress ?? '?';
    const [host = '', portText = ''] = (req.url ?? '').split(/:(?=\d+$)/);
    const port = Number(portText);
    const deny = (why: string, status = 403) => {
      log({ at: new Date().toISOString(), from, host, port, allowed: false, why });
      client.end(
        `HTTP/1.1 ${status} Forbidden\r\ncontent-type: text/plain\r\n\r\n${host} is not on the allow-list.\r\n`,
      );
    };
    if (!ports.has(port)) return deny('port');
    if (allows(opts.deny ?? [], host)) return deny('never');
    const passHolder = openWorkspace(req.headers['proxy-authorization'], opts.secret);
    const anyHost = passHolder !== null && HOST.test(host.toLowerCase().replace(/\.$/, ''));
    if (!allows(opts.allow, host) && !anyHost) return deny('not-allowed');
    if ((open.get(from) ?? 0) >= (opts.maxPerSource ?? 256)) return deny('too-many', 429);
    let addresses: string[];
    try {
      addresses = opts.resolve
        ? [await opts.resolve(host)].flat()
        : (await lookup(host, { all: true })).map((a) => a.address);
    } catch {
      return deny('no-such-host', 502);
    }
    const address = addresses[0];
    if (!address) return deny('no-such-host', 502);
    // Every address the name has, not just the one used: a name that mixes in a private address
    // is refused outright.
    if (!opts.allowPrivate && addresses.some(isPrivateAddress)) return deny('private-address');

    open.set(from, (open.get(from) ?? 0) + 1);
    const upstream = netConnect({ host: address, port });
    const done = () => {
      open.set(from, Math.max(0, (open.get(from) ?? 1) - 1));
    };
    upstream.once('connect', () => {
      log({
        at: new Date().toISOString(),
        from,
        host,
        port,
        allowed: true,
        ...(passHolder ? { open: true } : {}),
      });
      client.write('HTTP/1.1 200 Connection established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    // Idle tunnels close after 10 minutes.
    for (const s of [client, upstream]) s.setTimeout(10 * 60_000, () => s.destroy());
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
    upstream.once('close', () => {
      client.destroy();
    });
    client.once('close', () => {
      upstream.destroy();
      done();
    });
  });
  return server;
}

function hostOf(url: string | undefined) {
  try {
    return new URL(url ?? '').hostname;
  } catch {
    return '';
  }
}
