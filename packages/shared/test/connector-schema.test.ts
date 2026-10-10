import { describe, expect, it } from 'vitest';
import {
  atPointer,
  type ConnectorSchema,
  expandPath,
  jsonPointer,
  parseConnectorDefinition,
  readSchema,
  validate,
} from '../src/connector-schema.ts';

/** The fictional book-lending club the docs use. */
const lanternfield = () => ({
  id: 'lanternfield-library',
  displayName: 'Lanternfield Library',
  description: 'Borrow and return books from the club shelves.',
  baseUrl: 'https://library.example.org/api',
  oauth: {
    authorizeUrl: 'https://library.example.org/oauth/authorize',
    tokenUrl: 'https://library.example.org/oauth/token',
    revokeUrl: 'https://library.example.org/oauth/revoke',
    clientId: 'ats-lanternfield',
    clientSecretEnv: 'ATS_CONNECTOR_LANTERNFIELD_SECRET',
    scopes: ['shelves:read', 'loans:read', 'loans:write'],
    pkce: true,
    tokenAuth: 'basic',
  },
  operations: {
    listShelves: {
      method: 'GET',
      path: '/v1/shelves',
      params: {
        type: 'object',
        properties: { page: { type: 'integer', minimum: 1, maximum: 100 } },
        additionalProperties: false,
      },
      scope: 'shelves:read',
      kind: 'read',
      maxResponseBytes: 40000,
    },
    getMyLoans: {
      method: 'GET',
      path: '/v1/loans/me',
      scope: 'loans:read',
      kind: 'read',
      maxResponseBytes: 20000,
    },
    borrowBook: {
      method: 'PUT',
      path: '/v1/books/:bookId/loan',
      params: {
        type: 'object',
        properties: { bookId: { type: 'string', pattern: '^[0-9]{1,9}$' } },
        required: ['bookId'],
        additionalProperties: false,
      },
      body: {
        type: 'object',
        properties: { weeks: { type: 'integer', minimum: 1, maximum: 4 } },
        required: ['weeks'],
        additionalProperties: false,
      },
      scope: 'loans:write',
      kind: 'write',
      idempotencyHeader: 'Idempotency-Key',
      maxResponseBytes: 4000,
    },
    returnBook: {
      method: 'DELETE',
      path: '/v1/books/:bookId/loan',
      params: {
        type: 'object',
        properties: { bookId: { type: 'string', pattern: '^[0-9]{1,9}$' } },
        required: ['bookId'],
        additionalProperties: false,
      },
      scope: 'loans:write',
      kind: 'write',
      maxResponseBytes: 4000,
    },
  },
});

describe('connector definitions', () => {
  it('reads a good one', () => {
    const def = parseConnectorDefinition(lanternfield());
    expect(def.id).toBe('lanternfield-library');
    expect(def.allowPrivateAddress).toBe(false);
    expect(Object.keys(def.operations)).toEqual([
      'listShelves',
      'getMyLoans',
      'borrowBook',
      'returnBook',
    ]);
  });

  const broken: [string, (d: ReturnType<typeof lanternfield>) => unknown, RegExp][] = [
    ['plain http', (d) => ({ ...d, baseUrl: 'http://library.example.org' }), /https/],
    [
      'http token address',
      (d) => ({ ...d, oauth: { ...d.oauth, tokenUrl: 'http://x.example' } }),
      /tokenUrl/,
    ],
    ['an odd id', (d) => ({ ...d, id: 'Lanternfield!' }), /id/],
    ['unknown keys', (d) => ({ ...d, proxy: 'x' }), /proxy|Unrecognized/],
    ['no pkce', (d) => ({ ...d, oauth: { ...d.oauth, pkce: false } }), /pkce/],
    [
      'a secret named anything',
      (d) => ({ ...d, oauth: { ...d.oauth, clientSecretEnv: 'DATABASE_URL' } }),
      /clientSecretEnv/,
    ],
    [
      'overriding the state',
      (d) => ({ ...d, oauth: { ...d.oauth, extraAuthorizeParams: { state: 'x' } } }),
      /state/,
    ],
    [
      'a scope the app never asks for',
      (d) => {
        d.operations.getMyLoans.scope = 'admin';
        return d;
      },
      /scope "admin"/,
    ],
    [
      'a path parameter without a pattern',
      (d) => {
        d.operations.returnBook.params.properties.bookId = { type: 'string' } as never;
        return d;
      },
      /pattern or an enum/,
    ],
    [
      'an undeclared path parameter',
      (d) => {
        d.operations.getMyLoans.path = '/v1/loans/:who';
        return d;
      },
      /:who/,
    ],
    [
      'a step up in the path',
      (d) => {
        d.operations.getMyLoans.path = '/v1/../admin';
        return d;
      },
      /isn't allowed/,
    ],
    [
      'an open object',
      (d) => {
        (d.operations.borrowBook.body as { additionalProperties?: boolean }).additionalProperties =
          undefined;
        return d;
      },
      /additionalProperties/,
    ],
    [
      'a response the bridge can’t carry',
      (d) => {
        d.operations.getMyLoans.maxResponseBytes = 70000;
        return d;
      },
      /maxResponseBytes/,
    ],
    [
      'an idempotency header on a read',
      (d) => {
        (d.operations.getMyLoans as { idempotencyHeader?: string }).idempotencyHeader = 'Key';
        return d;
      },
      /idempotency/,
    ],
    [
      'an idempotency header the server sets',
      (d) => {
        d.operations.borrowBook.idempotencyHeader = 'Authorization';
        return d;
      },
      /set by the server/,
    ],
  ];
  it.each(broken)('refuses %s', (_name, change, message) => {
    expect(() => parseConnectorDefinition(change(lanternfield()))).toThrow(message);
  });

  it('allows plain http only for a private address the owner allowed', () => {
    const d = { ...lanternfield(), allowPrivateAddress: true, baseUrl: 'http://127.0.0.1:9000' };
    expect(parseConnectorDefinition(d).baseUrl).toBe('http://127.0.0.1:9000');
  });
});

describe('the link check', () => {
  const withCheck = (linkCheck: unknown, extra: Record<string, unknown> = {}) => {
    const d = lanternfield();
    return {
      ...d,
      operations: {
        ...d.operations,
        whoAmI: {
          method: 'GET',
          path: '/v1/me',
          scope: 'loans:read',
          kind: 'read',
          maxResponseBytes: 2000,
          ...extra,
        },
      },
      linkCheck,
    };
  };

  it('reads one naming a read with nothing to fill in', () => {
    const def = parseConnectorDefinition(
      withCheck({ op: 'whoAmI', nameField: '/member/displayName' }),
    );
    expect(def.linkCheck).toEqual({ op: 'whoAmI', nameField: '/member/displayName' });
    expect(parseConnectorDefinition(withCheck({ op: 'whoAmI' })).linkCheck).toEqual({
      op: 'whoAmI',
    });
    // Optional params are fine: it's sent with none.
    expect(parseConnectorDefinition(withCheck({ op: 'listShelves' })).linkCheck?.op).toBe(
      'listShelves',
    );
    // Without one, there's none.
    expect(parseConnectorDefinition(lanternfield()).linkCheck).toBeUndefined();
  });

  it.each([
    ['an operation it doesn’t have', { op: 'whoAreYou' }, {}, /isn't one of the operations/],
    ['a write', { op: 'borrowBook' }, {}, /read \(GET\)/],
    ['a delete', { op: 'returnBook' }, {}, /read \(GET\)/],
    ['a read that isn’t a GET', { op: 'whoAmI' }, { method: 'POST' }, /read \(GET\)/],
    [
      'a read that needs params',
      { op: 'whoAmI' },
      {
        params: {
          type: 'object',
          properties: { who: { type: 'string' } },
          required: ['who'],
          additionalProperties: false,
        },
      },
      /no params/,
    ],
    [
      'a name field that isn’t a pointer',
      { op: 'whoAmI', nameField: 'nickname' },
      {},
      /starts with \//,
    ],
    ['a stray ~ in the pointer', { op: 'whoAmI', nameField: '/a~2b' }, {}, /~0 or ~1/],
    ['a long pointer', { op: 'whoAmI', nameField: `/${'x'.repeat(100)}` }, {}, /nameField/],
    ['other keys', { op: 'whoAmI', retries: 3 }, {}, /linkCheck|Unrecognized/],
  ])('refuses %s', (_name, linkCheck, extra, message) => {
    expect(() => parseConnectorDefinition(withCheck(linkCheck, extra))).toThrow(message);
  });

  it('follows JSON Pointers (RFC 6901)', () => {
    const doc = { member: { displayName: 'Ada', 'a/b': 1, 'm~n': 2 }, list: ['x', 'y'] };
    expect(jsonPointer('/member/displayName')).toEqual(['member', 'displayName']);
    expect(atPointer(doc, '/member/displayName')).toBe('Ada');
    expect(atPointer(doc, '/member/a~1b')).toBe(1);
    expect(atPointer(doc, '/member/m~0n')).toBe(2);
    expect(atPointer(doc, '/list/1')).toBe('y');
    expect(atPointer(doc, '/list/01')).toBeUndefined();
    expect(atPointer(doc, '/member/nickname')).toBeUndefined();
    expect(atPointer(doc, '/member/displayName/length')).toBeUndefined();
    expect(atPointer(doc, '/member/constructor')).toBeUndefined();
    expect(atPointer(null, '/member')).toBeUndefined();
  });
});

describe('the schema subset', () => {
  it('refuses keywords outside it', () => {
    expect(() => readSchema({ type: 'string', format: 'email' })).toThrow(/format/);
    expect(() => readSchema({ type: 'array', items: { type: 'string' } })).toThrow(/maxItems/);
    expect(() => readSchema({ type: 'object', properties: {} })).toThrow(/additionalProperties/);
    expect(() => readSchema({ type: 'null' })).toThrow(/type/);
    expect(() => readSchema({ type: 'string', pattern: '(' })).toThrow(/regular expression/);
    let deep: unknown = { type: 'string' };
    for (let i = 0; i < 12; i++) deep = { type: 'array', items: deep, maxItems: 1 };
    expect(() => readSchema(deep)).toThrow(/deeper/);
  });

  const book: ConnectorSchema = readSchema({
    type: 'object',
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 5 },
      copies: { type: 'integer', minimum: 0, maximum: 3 },
      genre: { type: 'string', enum: ['poetry', 'maps'] },
      tags: { type: 'array', items: { type: 'string', pattern: '^[a-z]+$' }, maxItems: 2 },
      signed: { type: 'boolean' },
    },
    required: ['title'],
    additionalProperties: false,
  });

  it('accepts what fits', () => {
    expect(validate(book, { title: 'Moss', copies: 2, tags: ['a'], signed: false })).toBeNull();
  });

  it.each([
    [{}, /title: is required/],
    [{ title: 'Ferns and lichens' }, /at most 5/],
    [{ title: 'Moss', copies: 1.5 }, /whole number/],
    [{ title: 'Moss', copies: 9 }, /at most 3/],
    [{ title: 'Moss', genre: 'opera' }, /one of/],
    [{ title: 'Moss', tags: ['a', 'b', 'c'] }, /at most 2 items/],
    [{ title: 'Moss', tags: ['A'] }, /tags\[0\]: must match/],
    [{ title: 'Moss', signed: 'yes' }, /true or false/],
    [{ title: 'Moss', extra: 1 }, /"extra" isn't expected/],
    [[], /must be an object/],
    [{ title: 'Moss', __proto__: { x: 1 } }, null],
  ])('says what is wrong with %j', (value, problem) => {
    const said = validate(book, value);
    if (problem === null) expect(said).toBeNull();
    else expect(said).toMatch(problem);
  });
});

describe('paths', () => {
  const def = parseConnectorDefinition(lanternfield());
  const borrow = def.operations.borrowBook as NonNullable<typeof def.operations.borrowBook>;

  it('fills path parameters and puts the rest in the query, in order', () => {
    expect(expandPath(borrow.path, { bookId: '42' })).toEqual({
      path: '/v1/books/42/loan',
      query: '',
    });
    expect(expandPath('/v1/shelves', { page: 2, tag: ['b', 'a'], all: true })).toEqual({
      path: '/v1/shelves',
      query: '?all=true&page=2&tag=b&tag=a',
    });
  });

  it('never lets a parameter become another segment or a step up (fuzzed)', () => {
    const nasty = [
      '',
      '.',
      '..',
      '/',
      '..%2f',
      'a/b',
      'a\\b',
      '?x=1',
      '#x',
      '%2e%2e',
      '\u0000',
      'x'.repeat(201),
    ];
    for (const v of nasty) expect(expandPath(borrow.path, { bookId: v })).toHaveProperty('error');
    // Random strings: whatever comes out stays exactly four segments under /v1/books.
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const alphabet = 'ab./\\%?#&=;:@ é \u0000-_~';
    for (let i = 0; i < 2000; i++) {
      let s = '';
      const n = Math.floor(rand() * 8);
      for (let j = 0; j < n; j++) s += alphabet[Math.floor(rand() * alphabet.length)];
      const out = expandPath(borrow.path, { bookId: s });
      if ('error' in out) continue;
      const segments = out.path.split('/');
      expect(segments).toHaveLength(5);
      expect(segments.slice(0, 3)).toEqual(['', 'v1', 'books']);
      expect(segments[4]).toBe('loan');
      expect(decodeURIComponent(segments[3] as string)).toBe(s);
      expect(['.', '..', '']).not.toContain(segments[3]);
      const url = new URL(`https://library.example.org/api${out.path}`);
      expect(url.pathname.startsWith('/api/v1/books/')).toBe(true);
    }
  });

  it('refuses objects in a query', () => {
    expect(expandPath('/v1/shelves', { where: { a: 1 } })).toHaveProperty('error');
  });
});
