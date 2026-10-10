// @vitest-environment happy-dom
import { wrap } from '@allthespaces/bridge-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BridgeError, ConnectorError, connect } from '../src/index.ts';

type Bridge = { useHost: (h: unknown) => void; deliver: (d: unknown) => void };
const bridgeOf = (p: unknown) => (p as { bridge: Bridge }).bridge;

describe('connectors on their own (standalone, with stand-in answers)', () => {
  const shelves = { body: { shelves: ['Poetry', 'Maps'] } };
  const borrow = [
    {
      match: { params: { bookId: '409' } },
      status: 409,
      body: { code: 'ALREADY_ON_LOAN', message: 'Someone has it.' },
    },
    { status: 200, body: { ok: true } },
  ];

  it('answers calls from the fixtures it was given', async () => {
    const portal = await connect({
      standIn: {
        connectors: { 'lanternfield-library': { listShelves: shelves, borrowBook: borrow } },
      },
    });
    expect(await portal.connectors.call('lanternfield-library', 'listShelves')).toEqual({
      status: 200,
      data: { shelves: ['Poetry', 'Maps'] },
    });
    const key = portal.connectors.newKey();
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    await expect(
      portal.connectors.call('lanternfield-library', 'borrowBook', {
        params: { bookId: '7' },
        body: { weeks: 2 },
        idempotencyKey: key,
      }),
    ).resolves.toEqual({ status: 200, data: { ok: true } });
    const refused = await portal.connectors
      .call('lanternfield-library', 'borrowBook', {
        params: { bookId: '409' },
        idempotencyKey: key,
      })
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ConnectorError);
    expect(refused).toMatchObject({
      code: 'clash',
      message: 'Someone has it.',
      upstream: { status: 409, code: 'ALREADY_ON_LOAN', message: 'Someone has it.' },
    });
    expect(await portal.connectors.status('lanternfield-library')).toEqual({
      installed: true,
      linked: true,
      broken: false,
      displayName: 'lanternfield-library',
      scopes: [],
    });
    await expect(portal.connectors.link('lanternfield-library')).resolves.toBeUndefined();
  });

  it('says plainly when there is no stand-in answer', async () => {
    const portal = await connect();
    const err = await portal.connectors.call('lanternfield-library', 'getMyLoans').catch((e) => e);
    expect(err).toMatchObject({ code: 'upstream' });
    expect((await portal.connectors.status('lanternfield-library')).installed).toBe(false);
  });

  it('can take a function, e.g. to load fixtures only while developing', async () => {
    const portal = await connect({
      standIn: {
        connectors: async (connector, op, params) =>
          connector === 'lanternfield-library' && op === 'getMyLoans'
            ? { body: { loans: [], asked: params ?? null } }
            : undefined,
      },
    });
    const got = await portal.connectors.call('lanternfield-library', 'getMyLoans', {
      params: { page: 2 },
    });
    expect(got.data).toEqual({ loans: [], asked: { page: 2 } });
  });
});

describe('connectors inside the app', () => {
  afterEach(() => vi.useRealTimers());

  it('sends the call to the app and passes on its answer or its refusal', async () => {
    const p = await connect({ standaloneAfterMs: 0 });
    const bridge = bridgeOf(p);
    const sent: Record<string, unknown>[] = [];
    bridge.useHost({
      postMessage: (d: { msg: { type: string; id: number; op?: string } }) => {
        sent.push(d.msg);
        queueMicrotask(() =>
          bridge.deliver(
            wrap(
              d.msg.op === 'borrowBook'
                ? {
                    type: 'result',
                    re: d.msg.id,
                    ok: false,
                    error: 'Link your Lanternfield Library account to use this.',
                    code: 'not-linked',
                  }
                : { type: 'result', re: d.msg.id, ok: true, data: { status: 200, data: [1] } },
            ),
          ),
        );
      },
    });
    expect(
      await p.connectors.call('lanternfield-library', 'listShelves', { params: { page: 1 } }),
    ).toEqual({
      status: 200,
      data: [1],
    });
    expect(sent[0]).toEqual({
      type: 'connector:call',
      connector: 'lanternfield-library',
      op: 'listShelves',
      params: { page: 1 },
      id: expect.any(Number),
    });
    const err = await p.connectors
      .call('lanternfield-library', 'borrowBook', {
        body: { weeks: 1 },
        idempotencyKey: 'abcdefgh',
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err).toBeInstanceOf(BridgeError);
    expect(err.code).toBe('not-linked');
    expect(err.upstream).toBeNull();
  });

  it('gives up on an app that never answers (an older one), after 20 seconds', async () => {
    const p = await connect({ standaloneAfterMs: 0 });
    bridgeOf(p).useHost({ postMessage: () => {} });
    vi.useFakeTimers();
    const pending = p.connectors.status('lanternfield-library').catch((e) => e);
    await vi.advanceTimersByTimeAsync(20_001);
    expect(await pending).toMatchObject({ code: 'upstream' });
  });
});
