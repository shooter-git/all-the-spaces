/**
 * The supervisor's HTTP API, against a fake set of sandboxes: only a ticket signed for exactly
 * the action asked for gets anything done, and the log never holds what was sent.
 */
import type { AddressInfo } from 'node:net';
import { signToken } from '@ats/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { Log } from '../src/log.ts';
import type { Sandboxes } from '../src/sandboxes.ts';
import { createSupervisorServer } from '../src/server.ts';

const SECRET = 'x'.repeat(64);

describe("the supervisor's API", () => {
  const calls: { method: string; args: unknown[] }[] = [];
  /** Answers every method by recording it; a few give the answers the tests need. */
  const answers: Record<string, (...args: unknown[]) => unknown> = {
    sandboxStatus: () => ({ running: true }),
    readFile: (_ws, path) => (path === 'plan.json' ? Buffer.from('{"rooms":[]}') : null),
    startStep: () => ({ ok: true }),
    waitStep: () => ({ done: false }),
  };
  const sandboxes = new Proxy({} as Sandboxes, {
    get: (_, method: string) => {
      if (method === 'names')
        return { sandbox: (ws: string) => `sandbox-${ws}`, connect: (a: string) => `connect-${a}` };
      return async (...args: unknown[]) => {
        calls.push({ method, args });
        const answer = answers[method];
        return answer ? answer(...args) : { ok: true };
      };
    },
  });
  const logged: Record<string, unknown>[] = [];
  const server = createSupervisorServer(sandboxes, {
    secret: SECRET,
    egressContainer: 'egress',
    log: { info: (entry: Record<string, unknown>) => logged.push(entry) } as unknown as Log,
  });
  let base = '';

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const ticket = (claims: Record<string, unknown>, secret = SECRET, ttl = 60) =>
    signToken('supervisor', claims, secret, ttl);
  const post = (act: string, body: Record<string, unknown>) =>
    fetch(`${base}/v1/${act}`, { method: 'POST', body: JSON.stringify(body) });

  it('does what a ticket signed for that action and workspace asks', async () => {
    calls.length = 0;
    const res = await post('sandbox.status', {
      ticket: ticket({ act: 'sandbox.status', ws: 'w1' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ running: true });
    expect(calls).toEqual([{ method: 'sandboxStatus', args: ['w1'] }]);
  });

  it('refuses a missing ticket, one for another action, a forged one and an expired one', async () => {
    calls.length = 0;
    const refused = [
      {},
      { ticket: ticket({ act: 'sandbox.status', ws: 'w1' }) },
      { ticket: ticket({ act: 'sandbox.stop', ws: 'w1' }, 'y'.repeat(64)) },
      { ticket: ticket({ act: 'sandbox.stop', ws: 'w1' }, SECRET, -1) },
    ];
    for (const body of refused) {
      const res = await post('sandbox.stop', body);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Not allowed' });
    }
    expect(calls).toEqual([]);
  });

  it('knows only POSTs to its own actions', async () => {
    expect((await fetch(`${base}/v1/sandbox.status`)).status).toBe(404);
    expect((await post('../etc', {})).status).toBe(404);
    const unknown = await post('sandbox.explode', {
      ticket: ticket({ act: 'sandbox.explode', ws: 'w1' }),
    });
    expect(unknown.status).toBe(403);
  });

  it('says what is missing from a ticket, and when a file is not there', async () => {
    const noWs = await post('sandbox.stop', { ticket: ticket({ act: 'sandbox.stop' }) });
    expect(noWs.status).toBe(500);
    expect(await noWs.json()).toEqual({ error: 'Missing ws' });
    const missing = await post('workspace.read', {
      ticket: ticket({ act: 'workspace.read', ws: 'w1' }),
      path: 'nothing.txt',
    });
    expect(missing.status).toBe(404);
  });

  it('sends files as bytes', async () => {
    const res = await post('workspace.read', {
      ticket: ticket({ act: 'workspace.read', ws: 'w1' }),
      path: 'plan.json',
    });
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(await res.text()).toBe('{"rooms":[]}');
  });

  it('runs and waits on only the two fixed job steps', async () => {
    calls.length = 0;
    const call = (act: string, step: string) =>
      post(act, { ticket: ticket({ act, ws: 'job-1' }), step });
    expect((await call('job.run', 'rm -rf /')).status).toBe(500);
    expect((await call('job.wait', 'rm -rf /')).status).toBe(500);
    expect((await call('job.run', 'prepare')).status).toBe(200);
    expect((await call('job.wait', 'prepare')).status).toBe(200);
    expect((await call('job.run', 'finish')).status).toBe(200);
    expect(calls).toEqual([
      { method: 'startStep', args: ['job-1', 'prepare'] },
      { method: 'waitStep', args: ['job-1', 'prepare'] },
      { method: 'startStep', args: ['job-1', 'finish'] },
    ]);
  });

  it('waits on a long check started once, however often it is asked about', async () => {
    calls.length = 0;
    const call = (body: Record<string, unknown> = {}) =>
      post('sandbox.check', { ticket: ticket({ act: 'sandbox.check', ws: 'w2' }), ...body });
    // Nothing started yet: a wait alone finds nothing.
    expect((await call({ wait: true })).status).toBe(404);
    expect(await (await call()).json()).toEqual({ ok: true });
    expect(await (await call({ wait: true })).json()).toEqual({ ok: true });
    expect(calls).toEqual([{ method: 'check', args: ['w2'] }]);
  });

  it('logs one line per request, never what was sent', async () => {
    logged.length = 0;
    await post('workspace.write', {
      ticket: ticket({ act: 'workspace.write', ws: 'w1' }),
      path: 'notes.txt',
      data: Buffer.from('a secret note').toString('base64'),
    });
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ act: 'workspace.write', ws: 'w1', ok: true });
    const line = JSON.stringify(logged[0]);
    expect(line).not.toContain(Buffer.from('a secret note').toString('base64'));
    expect(line).not.toContain('notes.txt');
  });

  it('hangs up on a terminal without a terminal ticket', async () => {
    calls.length = 0;
    const url = `${base.replace('http', 'ws')}/v1/terminal?ticket=${ticket({ act: 'sandbox.status', ws: 'w1' })}`;
    const ws = new WebSocket(url);
    const outcome = await new Promise<string>((resolve) => {
      ws.on('open', () => resolve('open'));
      ws.on('error', () => resolve('refused'));
    });
    expect(outcome).toBe('refused');
    expect(calls).toEqual([]);
  });
});
