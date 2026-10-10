import { z } from 'zod';

// Server configuration. In dev, connection URLs are derived from the ATS_PORT_* values in the root .env.
const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  ATS_PUBLIC_URL: z.url(),
  ATS_PLAY_URL: z.url(),
  ATS_PORT_SERVER: z.coerce.number().int().default(45110),
  /** The release this server runs (set by the installer). */
  ATS_RELEASE: z.string().default('development'),
  DATABASE_URL: z.string().min(1),
  VALKEY_URL: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(32),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('garage'),
  S3_BUCKET: z.string().default('ats'),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  // Present only when the built-in Garage is used; enables automatic storage bootstrap.
  GARAGE_ADMIN_URL: z.string().optional(),
  GARAGE_ADMIN_TOKEN: z.string().optional(),
  SMTP_URL: z.string().optional(),
  /** Voice chat (LiveKit) is set up on this server; passes come from the real-time service. */
  LIVEKIT_API_KEY: z.string().optional(),
  /** Who notification emails come from (default: no-reply at the app's host). */
  MAIL_FROM: z.string().optional(),
  /** Shared with the real-time service to sign join tickets and authenticate internal calls. */
  REALTIME_SECRET: z.string().min(32),
  /** The supervisor (sandboxes for the Studio). Without it, the Studio is switched off. */
  ATS_SUPERVISOR_URL: z.string().optional(),
  SUPERVISOR_SECRET: z.string().min(32).optional(),
  /** The address to listen on (the image sets 0.0.0.0). */
  HOST: z.string().default('127.0.0.1'),
  /** Build sample spaces from plain colours and shapes, downloading nothing (tests, offline). */
  ATS_OFFLINE: z.string().optional(),
  /** Where downloaded CC0 assets are kept (default: .data/asset-cache in the checkout). */
  ATS_ASSET_CACHE: z.string().optional(),
  /** `0` builds places without baking their lighting. */
  ATS_BAKE: z.string().optional(),
  /** Lightmap size per room, in pixels (default 1024). */
  ATS_BAKE_RES: z.coerce.number().int().min(16).max(8192).optional(),
  /** Cycles samples per lightmap pixel (default 128). */
  ATS_BAKE_SAMPLES: z.coerce.number().int().min(1).max(4096).optional(),
  /**
   * Blender for baking here when there's no supervisor (development); default `blender` on the
   * PATH. With a supervisor, lighting is baked in the workbench instead.
   */
  ATS_BLENDER: z.string().optional(),
  /**
   * Where the server's owner keeps connector definitions (`<id>.json`, docs/connectors.md).
   * Unset: no connectors, and creations have no way out at all.
   */
  ATS_CONNECTORS_DIR: z.string().optional(),
  /**
   * The folder of repository host definitions (ADR 0011, docs/repositories.md), and where their
   * tokens come from. Unset: creations can't come from repositories.
   */
  ATS_SOURCES_DIR: z.string().optional(),
});

export type ServerEnv = z.infer<typeof schema>;

/** Fills in connection URLs from the dev ATS_PORT_* values when explicit URLs are absent. */
export function withLocalDefaults(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const e = { ...source };
  const local = (port: string | undefined) => `127.0.0.1:${port}`;
  if (e.ATS_PORT_POSTGRES) {
    e.DATABASE_URL ??= `postgres://ats:${e.POSTGRES_PASSWORD}@${local(e.ATS_PORT_POSTGRES)}/ats`;
  }
  if (e.ATS_PORT_VALKEY) e.VALKEY_URL ??= `redis://${local(e.ATS_PORT_VALKEY)}`;
  if (e.ATS_PORT_S3) e.S3_ENDPOINT ??= `http://${local(e.ATS_PORT_S3)}`;
  if (e.ATS_PORT_S3_ADMIN) e.GARAGE_ADMIN_URL ??= `http://${local(e.ATS_PORT_S3_ADMIN)}`;
  if (e.ATS_PORT_MAIL_SMTP) e.SMTP_URL ??= `smtp://${local(e.ATS_PORT_MAIL_SMTP)}`;
  if (e.ATS_PORT_SERVER) e.SERVER_INTERNAL_URL ??= `http://${local(e.ATS_PORT_SERVER)}`;
  if (e.ATS_PORT_VOICE) e.LIVEKIT_URL ??= `http://${local(e.ATS_PORT_VOICE)}`;
  return e;
}

function parse<T extends z.ZodType>(s: T, env: NodeJS.ProcessEnv): z.infer<T> {
  const parsed = s.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Configuration is incomplete:\n${problems.join('\n')}`);
  }
  return parsed.data;
}

const realtimeSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  /** The app's address: the only origin allowed to call the matchmaking routes from a browser. */
  ATS_PUBLIC_URL: z.url(),
  ATS_PORT_REALTIME: z.coerce.number().int().default(45120),
  VALKEY_URL: z.string().min(1),
  REALTIME_SECRET: z.string().min(32),
  /** How the real-time service reaches the API server (never through the public proxy). */
  SERVER_INTERNAL_URL: z.string().min(1),
  /** Voice chat (LiveKit): off unless all three are set. */
  LIVEKIT_URL: z.string().optional(),
  LIVEKIT_API_KEY: z.string().optional(),
  LIVEKIT_API_SECRET: z.string().min(32).optional(),
  /** The address to listen on (the image sets 0.0.0.0). */
  HOST: z.string().default('127.0.0.1'),
  /** Log how long each update takes every this many seconds (the load test); 0: never. */
  ATS_REALTIME_STATS: z.coerce.number().min(0).default(0),
});
export type RealtimeEnv = z.infer<typeof realtimeSchema>;
export const loadRealtimeEnv = (source: NodeJS.ProcessEnv = process.env): RealtimeEnv =>
  parse(realtimeSchema, withLocalDefaults(source));

const workerSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().min(1),
  VALKEY_URL: z.string().min(1),
  /** Touched on every heartbeat, for the container's health check (set in compose.yml). */
  ATS_HEARTBEAT_FILE: z.string().optional(),
});
export type WorkerEnv = z.infer<typeof workerSchema>;
export const loadWorkerEnv = (source: NodeJS.ProcessEnv = process.env): WorkerEnv =>
  parse(workerSchema, withLocalDefaults(source));

/** A secret shorter than 32 characters counts as not set (the service runs without it). */
const optionalSecret = z
  .string()
  .optional()
  .transform((s) => (s && s.length >= 32 ? s : undefined));

const supervisorSchema = z.object({
  /** Shared with the server, which signs a ticket for every request. */
  SUPERVISOR_SECRET: z.string().min(32),
  /** Names and labels everything this installation's supervisor creates. */
  ATS_INSTANCE: z.string().default('ats'),
  ATS_WORKBENCH_IMAGE: z.string().default('ats-workbench:latest'),
  /** Default: `<instance>_sandbox`. */
  ATS_SANDBOX_NETWORK: z.string().optional(),
  ATS_EGRESS_URL: z.string().default('http://egress:3128'),
  /** Default: `<instance>-egress-1`. */
  ATS_EGRESS_CONTAINER: z.string().optional(),
  /** Signs the egress passes of workspaces allowed the whole internet. */
  EGRESS_SECRET: optionalSecret,
  ATS_SANDBOX_RUNTIME: z.string().default('runsc'),
  ATS_SANDBOX_CPUS: z.coerce.number().positive().default(2),
  ATS_SANDBOX_MEMORY_MB: z.coerce.number().int().positive().default(4096),
  ATS_SANDBOX_PIDS: z.coerce.number().int().positive().default(1024),
  /** CPUs for each lighting bake job (one room each). */
  ATS_BAKE_CPUS: z.coerce.number().positive().default(2),
  /** Lighting bake jobs at once, across all builds. Default: the host's CPUs / ATS_BAKE_CPUS. */
  ATS_BAKE_PARALLEL: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().positive().optional(),
  ),
  /**
   * CPUs for checking a creation (building it and playing it in a browser with no graphics card,
   * which draws on the CPU). Default: 4, or the host's CPUs if it has fewer.
   */
  ATS_CHECK_CPUS: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().positive().optional(),
  ),
  /** API-key mode: off unless the server's owner sets it to `on` (docs/self-hosting.md). */
  ATS_API_KEY_MODE: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  ATS_PORT_SUPERVISOR: z.coerce.number().int().default(45140),
  HOST: z.string().default('127.0.0.1'),
  DOCKER_SOCKET: z.string().default('/var/run/docker.sock'),
});
export type SupervisorEnv = z.infer<typeof supervisorSchema>;
export const loadSupervisorEnv = (source: NodeJS.ProcessEnv = process.env): SupervisorEnv =>
  parse(supervisorSchema, source);

export function loadServerEnv(source: NodeJS.ProcessEnv = process.env): ServerEnv {
  return parse(schema, withLocalDefaults(source));
}
