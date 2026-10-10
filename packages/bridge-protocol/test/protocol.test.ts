import { describe, expect, it } from 'vitest';
import { fixtureAnswer, MAX_MESSAGE_BYTES, readCreationMessage, wrap } from '../src/index.ts';

describe('messages from a creation', () => {
  it('accepts well-formed messages', () => {
    expect(readCreationMessage(wrap({ type: 'ready' }))).toEqual({ type: 'ready' });
    const set = {
      type: 'save:set',
      id: 1,
      scope: 'personal',
      key: 'page-3',
      value: { ink: [] },
      schemaVersion: 2,
    };
    expect(readCreationMessage(wrap(set))).toEqual(set);
  });

  it('ignores anything else', () => {
    for (const bad of [
      null,
      'ready',
      { type: 'ready' }, // no envelope
      wrap({ type: 'become-architect' }),
      wrap({ type: 'save:get', id: 1, scope: 'everyone', key: 'x' }),
      wrap({ type: 'save:get', id: 1, scope: 'shared', key: '../../etc' }),
      wrap({ type: 'mp:send', kind: 'hi', body: 'x'.repeat(MAX_MESSAGE_BYTES) }),
      wrap({ type: 'ui:toast', text: 'x'.repeat(500) }),
    ]) {
      expect(readCreationMessage(bad)).toBeNull();
    }
  });
});

describe('connector messages', () => {
  it('accepts calls, status checks and link requests', () => {
    const call = {
      type: 'connector:call',
      id: 3,
      connector: 'lanternfield-library',
      op: 'borrowBook',
      params: { bookId: '42' },
      body: { weeks: 2 },
      idempotencyKey: 'borrow-42-0001',
    };
    expect(readCreationMessage(wrap(call))).toEqual(call);
    const status = { type: 'connector:status', id: 4, connector: 'lanternfield-library' };
    expect(readCreationMessage(wrap(status))).toEqual(status);
    const link = { type: 'connector:link', id: 5, connector: 'lanternfield-library' };
    expect(readCreationMessage(wrap(link))).toEqual(link);
  });

  it('ignores malformed ones', () => {
    const call = {
      type: 'connector:call',
      id: 1,
      connector: 'lanternfield-library',
      op: 'listShelves',
    };
    for (const bad of [
      { ...call, connector: 'Lanternfield Library' },
      { ...call, connector: '../etc' },
      { ...call, op: 'list shelves' },
      { ...call, op: '' },
      { ...call, id: -1 },
      { ...call, params: ['a'] },
      { ...call, params: 'page=1' },
      { ...call, idempotencyKey: 'short' },
      { ...call, idempotencyKey: 'has spaces in it' },
      { ...call, body: 'x'.repeat(MAX_MESSAGE_BYTES) },
      { type: 'connector:status', id: 1 },
      { type: 'connector:link', connector: 'lanternfield-library' },
    ])
      expect(readCreationMessage(wrap(bad)), JSON.stringify(bad).slice(0, 80)).toBeNull();
  });
});

describe('stand-in answers for connectors', () => {
  it('answers with the first entry that matches the params', () => {
    const fixture = [
      {
        match: { params: { bookId: '409' } },
        status: 409,
        body: { code: 'ON_LOAN', message: 'Taken.' },
      },
      { match: { params: { bookId: '1' } }, body: { title: 'Moss' } },
    ];
    expect(fixtureAnswer(fixture, { bookId: '1' })).toEqual({
      ok: true,
      status: 200,
      data: { title: 'Moss' },
    });
    expect(fixtureAnswer(fixture, { bookId: '409' })).toEqual({
      ok: false,
      code: 'clash',
      error: 'Taken.',
      details: { status: 409, code: 'ON_LOAN', message: 'Taken.' },
    });
    expect(fixtureAnswer(fixture, { bookId: '2' })).toBeNull();
    expect(fixtureAnswer({ status: 503 }, undefined)).toMatchObject({
      ok: false,
      code: 'upstream',
    });
    expect(fixtureAnswer({ status: 401 }, undefined)).toMatchObject({ code: 'not-linked' });
    expect(fixtureAnswer({ status: 422, body: { code: 'bad code' } }, undefined)).toEqual({
      ok: false,
      code: 'rejected',
      error: 'The service said 422.',
      details: { status: 422 },
    });
  });
});
