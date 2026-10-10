import type { AddressInfo } from 'node:net';
import { connect, createServer as createTcpServer, type Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allows, createProxy, isPrivateAddress, openPass, openWorkspace } from '../src/proxy.ts';

describe('the allow-list', () => {
  it('matches exact hosts and whole domains, nothing looser', () => {
    const list = ['api.anthropic.com', '*.npmjs.org'];
    expect(allows(list, 'api.anthropic.com')).toBe(true);
    expect(allows(list, 'API.Anthropic.com.')).toBe(true);
    expect(allows(list, 'evil-api.anthropic.com')).toBe(false);
    expect(allows(list, 'anthropic.com')).toBe(false);
    expect(allows(list, 'registry.npmjs.org')).toBe(true);
    expect(allows(list, 'npmjs.org')).toBe(false);
    expect(allows(list, 'registry.npmjs.org.evil.com')).toBe(false);
    expect(allows(list, '10.0.0.1')).toBe(false);
    expect(allows(list, 'api.anthropic.com@evil.com')).toBe(false);
  });

  it('knows which addresses are private', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.20.0.5',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '::1',
      'fd00::1',
      '::ffff:10.0.0.1',
      '0.0.0.0',
      '192.0.0.8',
      '192.0.0.170',
      '64:ff9b::a9fe:a9fe', // 169.254.169.254 through NAT64
      '64:ff9b::a00:1',
      '64:ff9b:1::a00:1',
    ])
      expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['1.1.1.1', '160.79.104.10', '2606:4700::1111', '192.0.1.1', '192.1.0.1'])
      expect(isPrivateAddress(ip), ip).toBe(false);
  });
});

describe('the proxy', () => {
  const logs: Record<string, unknown>[] = [];
  let proxyPort = 0;
  let targetPort = 0;
  const target = createTcpServer((s) => s.pipe(s)); // an echo server stands in for a website
  // A made-up public-looking name that resolves to this machine.
  const resolve = async () => '127.0.0.1';
  const strict = createProxy({ allow: ['site.test.example'], log: (e) => logs.push(e), resolve });

  beforeAll(async () => {
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
    targetPort = (target.address() as AddressInfo).port;
    await new Promise<void>((r) => strict.listen(0, '127.0.0.1', r));
    proxyPort = (strict.address() as AddressInfo).port;
  });
  afterAll(() => {
    target.close();
    strict.close();
  });

  const tunnel = (port: number, to: string) =>
    new Promise<{ status: string; socket: Socket }>((resolve) => {
      const s = connect(port, '127.0.0.1', () =>
        s.write(`CONNECT ${to} HTTP/1.1\r\nHost: ${to}\r\n\r\n`),
      );
      s.once('data', (d) => resolve({ status: d.toString().split('\r\n')[0] ?? '', socket: s }));
    });

  it('refuses hosts that are not on the list, other ports, and bare container names', async () => {
    const a = await tunnel(proxyPort, 'example.com:443');
    expect(a.status).toContain('403');
    a.socket.destroy();
    const b = await tunnel(proxyPort, `site.test.example:${targetPort}`);
    expect(b.status).toContain('403');
    b.socket.destroy();
    const c = await tunnel(proxyPort, 'postgres:443');
    expect(c.status).toContain('403');
    c.socket.destroy();
    expect(logs.map((l) => l.why)).toEqual(['not-allowed', 'port', 'not-allowed']);
  });

  it('refuses allowed names that point at private addresses', async () => {
    const p = createProxy({
      allow: ['site.test.example'],
      ports: [targetPort],
      log: (e) => logs.push(e),
      resolve,
    });
    await new Promise<void>((r) => p.listen(0, '127.0.0.1', r));
    const t = await tunnel((p.address() as AddressInfo).port, `site.test.example:${targetPort}`);
    expect(t.status).toContain('403');
    expect(logs.at(-1)).toMatchObject({
      host: 'site.test.example',
      allowed: false,
      why: 'private-address',
    });
    t.socket.destroy();
    p.close();
  });

  it('refuses a name if any of its addresses is private, not just the first', async () => {
    const p = createProxy({
      allow: ['site.test.example'],
      ports: [targetPort],
      log: (e) => logs.push(e),
      resolve: async () => ['1.1.1.1', '10.0.0.7'],
    });
    await new Promise<void>((r) => p.listen(0, '127.0.0.1', r));
    const t = await tunnel((p.address() as AddressInfo).port, `site.test.example:${targetPort}`);
    expect(t.status).toContain('403');
    expect(logs.at(-1)).toMatchObject({ host: 'site.test.example', why: 'private-address' });
    t.socket.destroy();
    p.close();
  });

  it('tunnels to an allowed host without looking inside', async () => {
    const p = createProxy({
      allow: ['site.test.example'],
      allowPrivate: true,
      ports: [targetPort],
      log: (e) => logs.push(e),
      resolve,
    });
    await new Promise<void>((r) => p.listen(0, '127.0.0.1', r));
    const t = await tunnel((p.address() as AddressInfo).port, `site.test.example:${targetPort}`);
    expect(t.status).toBe('HTTP/1.1 200 Connection established');
    const echoed = await new Promise<string>((resolve) => {
      t.socket.once('data', (d) => resolve(d.toString()));
      t.socket.write('opaque bytes');
    });
    expect(echoed).toBe('opaque bytes');
    expect(JSON.stringify(logs)).not.toContain('opaque');
    t.socket.destroy();
    p.close();
  });

  it('survives clients that hang up abruptly', async () => {
    for (let i = 0; i < 5; i++) {
      const s = connect(proxyPort, '127.0.0.1', () => {
        s.write('CONNECT example.com:443 HTTP/1.1\r\n\r\n');
        s.resetAndDestroy();
      });
      s.on('error', () => {});
    }
    await new Promise((r) => setTimeout(r, 200));
    const a = await tunnel(proxyPort, 'example.com:443');
    expect(a.status).toContain('403');
    a.socket.destroy();
  });

  it('refuses plain HTTP', async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/`, { headers: {} }).catch(() => null);
    expect(res?.status).toBe(403);
  });
});

describe('open internet', () => {
  const logs: Record<string, unknown>[] = [];
  const secret = 'a-secret-shared-with-the-supervisor-only';
  const target = createTcpServer((s) => s.pipe(s));
  let targetPort = 0;
  let proxyPort = 0;
  const resolve = async (host: string) =>
    host === 'intranet.test.example' ? '10.0.0.5' : '127.0.0.1';
  let proxy: ReturnType<typeof createProxy>;

  beforeAll(async () => {
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
    targetPort = (target.address() as AddressInfo).port;
    // allowPrivate only lets this test's echo server (on 127.0.0.1) stand in for a website.
    proxy = createProxy({
      allow: [],
      secret,
      ports: [targetPort],
      log: (e) => logs.push(e),
      resolve,
      allowPrivate: true,
    });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    proxyPort = (proxy.address() as AddressInfo).port;
  });
  afterAll(() => {
    target.close();
    proxy.close();
  });

  const tunnel = (to: string, auth?: string) =>
    new Promise<{ status: string; socket: Socket }>((done) => {
      const s = connect(proxyPort, '127.0.0.1', () =>
        s.write(
          `CONNECT ${to} HTTP/1.1\r\nHost: ${to}\r\n${auth ? `Proxy-Authorization: Basic ${Buffer.from(auth).toString('base64')}\r\n` : ''}\r\n`,
        ),
      );
      s.once('data', (d) => done({ status: d.toString().split('\r\n')[0] ?? '', socket: s }));
    });

  it('lets a workspace with a valid pass reach any public host name', async () => {
    const ws = '1d9ec39b-b8e2-4f2f-940c-65dc4ba63eb3';
    const t = await tunnel(
      `anything.test.example:${targetPort}`,
      `ws-${ws}:${openPass(secret, ws)}`,
    );
    expect(t.status).toBe('HTTP/1.1 200 Connection established');
    expect(logs.at(-1)).toMatchObject({ host: 'anything.test.example', allowed: true, open: true });
    t.socket.destroy();
  });

  it('refuses without a pass, with a wrong one, or one for another workspace', async () => {
    for (const auth of [
      undefined,
      'ws-abc:wrong',
      `ws-abc:${openPass(secret, 'other')}`,
      `ws-abc:${openPass('another-secret-entirely-xxxxxxxx', 'abc')}`,
    ]) {
      const t = await tunnel(`anything.test.example:${targetPort}`, auth);
      expect(t.status).toContain('403');
      t.socket.destroy();
    }
  });

  it('never reaches bare names or a pass-holder past the allowed ports', async () => {
    const pass = `ws-abc:${openPass(secret, 'abc')}`;
    for (const to of [`postgres:${targetPort}`, 'anything.test.example:22']) {
      const t = await tunnel(to, pass);
      expect(t.status).toContain('403');
      t.socket.destroy();
    }
  });

  it('never reaches a private address, even with a pass', async () => {
    const strict = createProxy({
      allow: [],
      secret,
      ports: [targetPort],
      log: (e) => logs.push(e),
      resolve,
    });
    await new Promise<void>((r) => strict.listen(0, '127.0.0.1', r));
    const s = connect((strict.address() as AddressInfo).port, '127.0.0.1');
    const status = await new Promise<string>((done) => {
      s.on('connect', () =>
        s.write(
          `CONNECT intranet.test.example:${targetPort} HTTP/1.1\r\nProxy-Authorization: Basic ${Buffer.from(`ws-abc:${openPass(secret, 'abc')}`).toString('base64')}\r\n\r\n`,
        ),
      );
      s.once('data', (d) => done(d.toString().split('\r\n')[0] ?? ''));
    });
    expect(status).toContain('403');
    expect(logs.at(-1)).toMatchObject({ allowed: false, why: 'private-address' });
    s.destroy();
    strict.close();
  });

  it('has no pass to give without a secret', () => {
    expect(
      openWorkspace(`Basic ${Buffer.from(`ws-abc:${openPass(secret, 'abc')}`).toString('base64')}`),
    ).toBeNull();
  });
});

describe('the deny-list', () => {
  it('wins over the allow-list and over a pass for the whole internet', async () => {
    const secret = 'a-secret-shared-with-the-supervisor-only';
    const logs: Record<string, unknown>[] = [];
    const p = createProxy({
      allow: ['mcp-proxy.anthropic.com'],
      deny: ['mcp-proxy.anthropic.com'],
      secret,
      log: (e) => logs.push(e),
      resolve: async () => '1.1.1.1',
    });
    await new Promise<void>((r) => p.listen(0, '127.0.0.1', r));
    const s = connect((p.address() as AddressInfo).port, '127.0.0.1');
    const status = await new Promise<string>((done) => {
      s.on('connect', () =>
        s.write(
          `CONNECT mcp-proxy.anthropic.com:443 HTTP/1.1\r\nProxy-Authorization: Basic ${Buffer.from(`ws-abc:${openPass(secret, 'abc')}`).toString('base64')}\r\n\r\n`,
        ),
      );
      s.once('data', (d) => done(d.toString().split('\r\n')[0] ?? ''));
    });
    expect(status).toContain('403');
    expect(logs.at(-1)).toMatchObject({
      host: 'mcp-proxy.anthropic.com',
      allowed: false,
      why: 'never',
    });
    s.destroy();
    p.close();
  });
});
