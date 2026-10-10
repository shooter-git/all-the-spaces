/**
 * Operator-installed connectors (docs/connectors.md): the definition file a server's owner puts
 * in ATS_CONNECTORS_DIR, and the small, closed subset of JSON Schema its operations use to
 * describe what a creation may send. Everything here is plain checking: no network, no secrets.
 *
 * The schema subset is deliberately small, so it can be interpreted here without a dependency
 * and every value a creation sends is bounded:
 *
 * - `{ type: 'string', enum?, pattern?, minLength?, maxLength? }`
 * - `{ type: 'integer' | 'number', enum?, minimum?, maximum? }`
 * - `{ type: 'boolean' }`
 * - `{ type: 'array', items, maxItems, minItems? }`
 * - `{ type: 'object', properties, required?, additionalProperties: false }`
 *
 * Anything else (another keyword, a missing `maxItems`, an open object) is refused when the
 * definition is read. `pattern`, as in JSON Schema, isn't anchored: write `^…$`.
 */
import { z } from 'zod';

export type ConnectorSchema =
  | {
      type: 'string';
      enum?: string[];
      pattern?: string;
      minLength?: number;
      maxLength?: number;
      description?: string;
    }
  | {
      type: 'integer' | 'number';
      enum?: number[];
      minimum?: number;
      maximum?: number;
      description?: string;
    }
  | { type: 'boolean'; description?: string }
  | {
      type: 'array';
      items: ConnectorSchema;
      maxItems: number;
      minItems?: number;
      description?: string;
    }
  | {
      type: 'object';
      properties: Record<string, ConnectorSchema>;
      required?: string[];
      additionalProperties: false;
      description?: string;
    };

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** How deep a schema may nest (objects in arrays in objects…). */
const MAX_DEPTH = 8;
const PROPERTY = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

export class ConnectorDefinitionError extends Error {}

const fail = (at: string, problem: string): never => {
  throw new ConnectorDefinitionError(`${at}: ${problem}`);
};

const isCount = (n: unknown) => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 1e6;

/** Checks a schema from a definition file, keyword by keyword. Throws on anything outside the subset. */
export function readSchema(raw: unknown, at = 'schema', depth = 0): ConnectorSchema {
  if (depth > MAX_DEPTH) fail(at, `nests deeper than ${MAX_DEPTH} levels`);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail(at, 'must be an object');
  const s = raw as Record<string, unknown>;
  const allowed: Record<string, string[]> = {
    string: ['type', 'enum', 'pattern', 'minLength', 'maxLength', 'description'],
    integer: ['type', 'enum', 'minimum', 'maximum', 'description'],
    number: ['type', 'enum', 'minimum', 'maximum', 'description'],
    boolean: ['type', 'description'],
    array: ['type', 'items', 'maxItems', 'minItems', 'description'],
    object: ['type', 'properties', 'required', 'additionalProperties', 'description'],
  };
  const type = s.type;
  if (typeof type !== 'string' || !allowed[type])
    return fail(at, 'type must be string, integer, number, boolean, array or object');
  for (const key of Object.keys(s))
    if (!allowed[type]?.includes(key)) fail(at, `"${key}" isn't supported for ${type}`);
  if (
    s.description !== undefined &&
    (typeof s.description !== 'string' || s.description.length > 500)
  )
    fail(at, 'description must be a string of at most 500 characters');
  const description = s.description === undefined ? {} : { description: s.description as string };
  switch (type) {
    case 'string': {
      const out: ConnectorSchema = { type: 'string', ...description };
      if (s.enum !== undefined) {
        if (
          !Array.isArray(s.enum) ||
          s.enum.length === 0 ||
          s.enum.length > 200 ||
          !s.enum.every((v) => typeof v === 'string' && v.length <= 200)
        )
          fail(at, 'enum must be 1 to 200 strings');
        out.enum = s.enum as string[];
      }
      if (s.pattern !== undefined) {
        if (typeof s.pattern !== 'string' || s.pattern.length > 500)
          fail(at, 'pattern must be a string');
        try {
          new RegExp(s.pattern as string, 'u');
        } catch {
          fail(at, 'pattern is not a valid regular expression');
        }
        out.pattern = s.pattern as string;
      }
      for (const k of ['minLength', 'maxLength'] as const) {
        if (s[k] === undefined) continue;
        if (!isCount(s[k])) fail(at, `${k} must be a whole number from 0`);
        out[k] = s[k] as number;
      }
      return out;
    }
    case 'integer':
    case 'number': {
      const out: ConnectorSchema = { type, ...description };
      if (s.enum !== undefined) {
        if (
          !Array.isArray(s.enum) ||
          s.enum.length === 0 ||
          s.enum.length > 200 ||
          !s.enum.every((v) => typeof v === 'number' && Number.isFinite(v))
        )
          fail(at, 'enum must be 1 to 200 numbers');
        out.enum = s.enum as number[];
      }
      for (const k of ['minimum', 'maximum'] as const) {
        if (s[k] === undefined) continue;
        if (typeof s[k] !== 'number' || !Number.isFinite(s[k])) fail(at, `${k} must be a number`);
        out[k] = s[k] as number;
      }
      return out;
    }
    case 'boolean':
      return { type: 'boolean', ...description };
    case 'array': {
      if (!isCount(s.maxItems) || (s.maxItems as number) > 1000)
        fail(at, 'maxItems is required (a whole number up to 1000)');
      if (s.minItems !== undefined && !isCount(s.minItems))
        fail(at, 'minItems must be a whole number');
      return {
        type: 'array',
        items: readSchema(s.items, `${at}.items`, depth + 1),
        maxItems: s.maxItems as number,
        ...(s.minItems !== undefined ? { minItems: s.minItems as number } : {}),
        ...description,
      };
    }
    default: {
      if (s.additionalProperties !== false) fail(at, 'objects need "additionalProperties": false');
      if (!s.properties || typeof s.properties !== 'object' || Array.isArray(s.properties))
        fail(at, 'objects need "properties"');
      const properties: Record<string, ConnectorSchema> = {};
      const entries = Object.entries(s.properties as Record<string, unknown>);
      if (entries.length > 100) fail(at, 'at most 100 properties');
      for (const [name, sub] of entries) {
        if (!PROPERTY.test(name)) fail(at, `property name "${name}" isn't allowed`);
        properties[name] = readSchema(sub, `${at}.${name}`, depth + 1);
      }
      let required: string[] | undefined;
      if (s.required !== undefined) {
        if (!Array.isArray(s.required) || !s.required.every((r) => typeof r === 'string'))
          fail(at, 'required must be a list of property names');
        for (const r of s.required as string[])
          if (!(r in properties)) fail(at, `required names "${r}", which isn't a property`);
        required = s.required as string[];
      }
      return {
        type: 'object',
        properties,
        ...(required ? { required } : {}),
        additionalProperties: false,
        ...description,
      };
    }
  }
}

const describeJson = (v: unknown) =>
  v === null
    ? 'null'
    : Array.isArray(v)
      ? 'a list'
      : typeof v === 'object'
        ? 'an object'
        : typeof v;

/**
 * Checks a value against a schema. Null when it fits; otherwise what's wrong with it, in words a
 * developer can act on (e.g. `params.itemId: must match ^[0-9]+$`).
 */
export function validate(schema: ConnectorSchema, value: unknown, at = 'value'): string | null {
  switch (schema.type) {
    case 'string': {
      if (typeof value !== 'string') return `${at}: must be a string, not ${describeJson(value)}`;
      if (schema.enum && !schema.enum.includes(value))
        return `${at}: must be one of ${schema.enum.slice(0, 10).join(', ')}`;
      // Length in characters as people count them (code points), like JSON Schema.
      const length = [...value].length;
      if (schema.minLength !== undefined && length < schema.minLength)
        return `${at}: must be at least ${schema.minLength} characters`;
      if (schema.maxLength !== undefined && length > schema.maxLength)
        return `${at}: must be at most ${schema.maxLength} characters`;
      if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value))
        return `${at}: must match ${schema.pattern}`;
      return null;
    }
    case 'integer':
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value))
        return `${at}: must be a number, not ${describeJson(value)}`;
      if (schema.type === 'integer' && !Number.isInteger(value))
        return `${at}: must be a whole number`;
      if (schema.enum && !schema.enum.includes(value))
        return `${at}: must be one of ${schema.enum.slice(0, 10).join(', ')}`;
      if (schema.minimum !== undefined && value < schema.minimum)
        return `${at}: must be at least ${schema.minimum}`;
      if (schema.maximum !== undefined && value > schema.maximum)
        return `${at}: must be at most ${schema.maximum}`;
      return null;
    }
    case 'boolean':
      return typeof value === 'boolean' ? null : `${at}: must be true or false`;
    case 'array': {
      if (!Array.isArray(value)) return `${at}: must be a list, not ${describeJson(value)}`;
      if (value.length > schema.maxItems) return `${at}: at most ${schema.maxItems} items`;
      if (schema.minItems !== undefined && value.length < schema.minItems)
        return `${at}: at least ${schema.minItems} items`;
      for (let i = 0; i < value.length; i++) {
        const problem = validate(schema.items, value[i], `${at}[${i}]`);
        if (problem) return problem;
      }
      return null;
    }
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        return `${at}: must be an object, not ${describeJson(value)}`;
      const v = value as Record<string, unknown>;
      for (const key of Object.keys(v)) {
        if (!Object.hasOwn(schema.properties, key)) return `${at}: "${key}" isn't expected`;
      }
      for (const r of schema.required ?? [])
        if (v[r] === undefined) return `${at}.${r}: is required`;
      for (const [key, sub] of Object.entries(schema.properties)) {
        if (v[key] === undefined) continue;
        const problem = validate(sub, v[key], `${at}.${key}`);
        if (problem) return problem;
      }
      return null;
    }
  }
}

// ---- Paths ----------------------------------------------------------------------------------

const PATH_PARAM = /^:([A-Za-z_][A-Za-z0-9_]{0,63})$/;
const PATH_LITERAL = /^[A-Za-z0-9._~-]+$/;

/** The parts of an operation's path: fixed words and `:name` slots, one whole segment each. */
export function pathSegments(path: string): ({ literal: string } | { param: string })[] {
  if (!path.startsWith('/') || path.length > 300)
    fail('path', 'must start with / (at most 300 characters)');
  const segments = path.slice(1).split('/');
  return segments.map((seg, i) => {
    const param = PATH_PARAM.exec(seg)?.[1];
    if (param) return { param };
    // A trailing slash is the only empty segment allowed.
    if (seg === '' && i === segments.length - 1 && i > 0) return { literal: '' };
    if (!PATH_LITERAL.test(seg) || seg === '.' || seg === '..')
      fail('path', `"${seg}" isn't allowed in a path (letters, digits, . _ ~ - and :params)`);
    return { literal: seg };
  });
}

/**
 * The path and query string for a call: each `:name` in the path is filled from `params` (checked
 * again here, and percent-encoded), and the other params become the query, in a stable order.
 * Params must already have passed `validate`.
 */
export function expandPath(
  path: string,
  params: Record<string, Json> | undefined,
): { path: string; query: string } | { error: string } {
  const used = new Set<string>();
  let out = '';
  for (const seg of pathSegments(path)) {
    if ('literal' in seg) {
      out += `/${seg.literal}`;
      continue;
    }
    const value = params?.[seg.param];
    if (typeof value !== 'string' && typeof value !== 'number')
      return { error: `params.${seg.param}: is required` };
    const text = String(value);
    // Never another segment, a step up or an empty one, whatever the schema allowed.
    if (
      text === '' ||
      text === '.' ||
      text === '..' ||
      /[/\\?#%]/.test(text) ||
      // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters
      /[\u0000-\u001f\u007f]/.test(text) ||
      text.length > 200
    )
      return { error: `params.${seg.param}: isn't allowed in a path` };
    used.add(seg.param);
    out += `/${encodeURIComponent(text)}`;
  }
  const query = new URLSearchParams();
  for (const key of Object.keys(params ?? {}).sort()) {
    if (used.has(key)) continue;
    const value = params?.[key];
    if (value === null || value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item === 'object' && item !== null)
        return { error: `params.${key}: only plain values can go in a query` };
      if (item !== null) query.append(key, String(item));
    }
  }
  const q = query.toString();
  return { path: out, query: q ? `?${q}` : '' };
}

// ---- The definition file ----------------------------------------------------------------------

export const CONNECTOR_ID = /^[a-z0-9-]{2,32}$/;
export const OPERATION_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const SCOPE = /^[A-Za-z0-9_:./-]{1,100}$/;
const HEADER = /^[A-Za-z0-9-]{1,64}$/;
/** Headers the server sets itself; an idempotency header can't be one of them. */
const RESERVED_HEADERS = new Set([
  'authorization',
  'accept',
  'content-type',
  'content-length',
  'cookie',
  'host',
  'user-agent',
  'connection',
  'transfer-encoding',
  'proxy-authorization',
]);
/** Parameters of the authorization request that come from the server, not the definition. */
const RESERVED_AUTHORIZE = new Set([
  'response_type',
  'client_id',
  'redirect_uri',
  'scope',
  'state',
  'code_challenge',
  'code_challenge_method',
]);
/** Most a single answer may be: the bridge carries at most 64 KB per message. */
export const MAX_CONNECTOR_RESPONSE_BYTES = 60_000;

const Url = z.string().max(500).pipe(z.url());
const SchemaField = z.unknown().transform((v, ctx) => {
  try {
    return readSchema(v);
  } catch (e) {
    ctx.addIssue({ code: 'custom', message: (e as Error).message });
    return z.NEVER;
  }
});

const Operation = z.strictObject({
  method: z.enum(['GET', 'PUT', 'POST', 'PATCH', 'DELETE']),
  path: z.string().min(1).max(300),
  params: SchemaField.optional(),
  body: SchemaField.optional(),
  scope: z.string().regex(SCOPE),
  kind: z.enum(['read', 'write']),
  idempotencyHeader: z.string().regex(HEADER).optional(),
  maxResponseBytes: z.number().int().min(1).max(MAX_CONNECTOR_RESPONSE_BYTES),
  timeoutMs: z.number().int().min(100).max(30_000).optional(),
  description: z.string().max(300).optional(),
});

const Definition = z.strictObject({
  $comment: z.string().optional(),
  id: z.string().regex(CONNECTOR_ID),
  displayName: z.string().trim().min(1).max(60),
  description: z.string().max(300).default(''),
  baseUrl: Url,
  /** Connect to this `host:port` instead of what the base URL's name resolves to (operator only). */
  resolveTo: z
    .string()
    .regex(/^(?:[A-Za-z0-9.-]{1,253}|\[[0-9A-Fa-f:.]{2,45}\]):\d{1,5}$/)
    .optional(),
  allowPrivateAddress: z.boolean().default(false),
  oauth: z.strictObject({
    authorizeUrl: Url,
    tokenUrl: Url,
    revokeUrl: Url.optional(),
    clientId: z.string().min(1).max(300),
    clientSecretEnv: z.string().regex(/^ATS_CONNECTOR_[A-Z0-9_]+$/),
    scopes: z.array(z.string().regex(SCOPE)).min(1).max(50),
    pkce: z.literal(true),
    extraAuthorizeParams: z.record(z.string().max(64), z.string().max(500)).optional(),
    tokenAuth: z.enum(['basic', 'body']),
  }),
  operations: z
    .record(z.string().regex(OPERATION_NAME), Operation)
    .refine((ops) => Object.keys(ops).length > 0 && Object.keys(ops).length <= 200, {
      message: 'between 1 and 200 operations',
    }),
  /**
   * One harmless read the server makes as the person right after they link: it proves the link
   * works, and `nameField` (a JSON Pointer into its answer) says who they're linked as.
   */
  linkCheck: z
    .strictObject({
      op: z.string().regex(OPERATION_NAME),
      nameField: z.string().min(1).max(100).optional(),
    })
    .optional(),
});

export type ConnectorDefinition = z.infer<typeof Definition>;
export type ConnectorOperation = ConnectorDefinition['operations'][string];

/**
 * Reads a connector definition (the parsed JSON of `<id>.json`), checking everything a creation
 * could later lean on: addresses, scopes, paths and schemas. Throws ConnectorDefinitionError
 * saying what's wrong.
 */
export function parseConnectorDefinition(raw: unknown): ConnectorDefinition {
  const parsed = Definition.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ConnectorDefinitionError(
      `${issue?.path.join('.') || 'definition'}: ${issue?.message ?? 'invalid'}`,
    );
  }
  const def = parsed.data;
  const httpsOnly = (name: string, value: string) => {
    const url = new URL(value);
    if (url.protocol === 'https:') return url;
    if (url.protocol === 'http:' && def.allowPrivateAddress) return url;
    return fail(name, 'must be an https:// address');
  };
  const base = httpsOnly('baseUrl', def.baseUrl);
  if (base.search || base.hash || base.username || base.password)
    fail('baseUrl', 'must be a plain address (no query, fragment or credentials)');
  httpsOnly('oauth.authorizeUrl', def.oauth.authorizeUrl);
  httpsOnly('oauth.tokenUrl', def.oauth.tokenUrl);
  if (def.oauth.revokeUrl) httpsOnly('oauth.revokeUrl', def.oauth.revokeUrl);
  for (const key of Object.keys(def.oauth.extraAuthorizeParams ?? {}))
    if (RESERVED_AUTHORIZE.has(key))
      fail('oauth.extraAuthorizeParams', `"${key}" is set by the server`);
  for (const [name, op] of Object.entries(def.operations)) {
    const at = `operations.${name}`;
    if (!def.oauth.scopes.includes(op.scope))
      fail(at, `scope "${op.scope}" isn't one of oauth.scopes`);
    if (op.body && op.method === 'GET') fail(at, 'a GET has no body');
    if (op.idempotencyHeader && op.kind !== 'write')
      fail(at, 'only writes take an idempotency header');
    if (op.idempotencyHeader && RESERVED_HEADERS.has(op.idempotencyHeader.toLowerCase()))
      fail(at, `"${op.idempotencyHeader}" is set by the server`);
    if (op.params && op.params.type !== 'object') fail(`${at}.params`, 'must be an object schema');
    if (op.body && op.body.type !== 'object' && op.body.type !== 'array')
      fail(`${at}.body`, 'must be an object or array schema');
    let segments: ReturnType<typeof pathSegments>;
    try {
      segments = pathSegments(op.path);
    } catch (e) {
      return fail(at, (e as Error).message);
    }
    const props = op.params?.type === 'object' ? op.params : null;
    for (const seg of segments) {
      if (!('param' in seg)) continue;
      const p = props?.properties[seg.param];
      if (!p || !props?.required?.includes(seg.param))
        fail(at, `path parameter :${seg.param} must be a required property of params`);
      if (p?.type === 'string' && !p.pattern && !p.enum)
        fail(at, `path parameter :${seg.param} needs a pattern or an enum`);
      if (p && p.type !== 'string' && p.type !== 'integer')
        fail(at, `path parameter :${seg.param} must be a string or an integer`);
    }
    // Other params go in the query: plain values, or lists of them.
    for (const [key, p] of Object.entries(props?.properties ?? {})) {
      if (segments.some((s) => 'param' in s && s.param === key)) continue;
      const plain = (s: ConnectorSchema) => s.type !== 'object' && s.type !== 'array';
      if (!plain(p) && !(p.type === 'array' && plain(p.items)))
        fail(at, `query parameter "${key}" must be a plain value or a list of them`);
    }
  }
  if (def.linkCheck) {
    const op = def.operations[def.linkCheck.op];
    if (!op) fail('linkCheck.op', `"${def.linkCheck.op}" isn't one of the operations`);
    // Only something that can run with nothing filled in, and changes nothing.
    if (op?.kind !== 'read' || op.method !== 'GET')
      fail('linkCheck.op', 'must be a read (GET) operation');
    if (op?.params?.type === 'object' && op.params.required?.length)
      fail('linkCheck.op', 'must need no params');
    if (def.linkCheck.nameField !== undefined) {
      try {
        jsonPointer(def.linkCheck.nameField);
      } catch (e) {
        fail('linkCheck.nameField', (e as Error).message);
      }
    }
  }
  return def;
}

/**
 * The reference tokens of a JSON Pointer (RFC 6901): `/member/displayName` → `['member',
 * 'displayName']`, with `~1` for `/` and `~0` for `~`. `""` is the whole document. Throws on
 * anything that isn't one.
 */
export function jsonPointer(pointer: string): string[] {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) throw new Error('a JSON Pointer starts with /');
  if (/~(?![01])/.test(pointer)) throw new Error('in a JSON Pointer, ~ is only ~0 or ~1');
  return pointer
    .slice(1)
    .split('/')
    .map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'));
}

/** What a JSON Pointer points at in a value, or undefined when there's nothing there. */
export function atPointer(value: unknown, pointer: string): unknown {
  let here = value;
  for (const token of jsonPointer(pointer)) {
    if (Array.isArray(here)) {
      if (!/^(?:0|[1-9][0-9]{0,8})$/.test(token)) return undefined;
      here = here[Number(token)];
    } else if (here && typeof here === 'object' && Object.hasOwn(here, token)) {
      here = (here as Record<string, unknown>)[token];
    } else return undefined;
  }
  return here;
}
