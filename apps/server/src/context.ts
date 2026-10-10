import type { Db } from '@ats/db';
import type { ServerEnv } from '@ats/shared';
import type { Storage } from '@ats/storage';
import type { Queue } from 'bullmq';
import type { Auth } from './auth.ts';
import type { ConnectorRegistry } from './connectors/registry.ts';
import type { SpaceEvents } from './events.ts';
import type { Log } from './log.ts';
import type { Notifier, NotifyTransport } from './notify.ts';
import type { SourceHostRegistry } from './sources/registry.ts';
import type { Supervisor } from './studio/supervisor.ts';

export interface AppContext {
  env: ServerEnv;
  db: Db;
  auth: Auth;
  /** Overrides the configured object store (tests). */
  storage?: Storage;
  /** Tells other services about changes (no-op when absent). */
  events?: SpaceEvents;
  /** Starts sandboxes for the Studio (absent: the Studio is switched off). */
  supervisor?: Supervisor;
  /**
   * Blender for baking a place's lighting here when there's no supervisor (null: none). Found
   * from ATS_BLENDER or the PATH when absent; tests set it.
   */
  blender?: string | null;
  /** How notifications leave the server (tests replace it). */
  notifyTransport?: NotifyTransport;
  /** Set up by buildApp: tells people about things (live, push, email). */
  notifier?: Notifier;
  /**
   * How long the play origin trusts an access check before checking again, in milliseconds
   * (default 2000; tests shorten it).
   */
  playAccessTtlMs?: number;
  /** Where messages go (main.ts sets the logger the app also uses; else the app's own). */
  log?: Log;
  /** The queue creation builds go on: one connection for the app, made on first use. */
  buildQueue?: Queue;
  /**
   * The connectors the server's owner installed (buildApp reads ATS_CONNECTORS_DIR when absent;
   * tests set it).
   */
  connectors?: ConnectorRegistry;
  /**
   * The repository hosts the server's owner allows (buildApp reads ATS_SOURCES_DIR when absent;
   * tests set it).
   */
  sourceHosts?: SourceHostRegistry;
}
