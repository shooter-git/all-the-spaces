import type { Json, SaveScope } from '@allthespaces/bridge-protocol';
import { type Bridge, BridgeError } from './bridge.ts';

export interface SaveOptions {
  /**
   * The shape of your saved data. Bump it when the shape changes and give `migrate`, so data
   * saved by older versions of your creation is upgraded when it's read.
   */
  version?: number;
  /** Turns data saved at `fromVersion` into today's shape. */
  migrate?: (value: Json, fromVersion: number) => Json;
}

/** Someone (or a newer version of this creation) saved in the meantime: reload and try again. */
export class StaleSaveError extends Error {
  constructor(message = 'This was saved somewhere else in the meantime.') {
    super(message);
  }
}

/**
 * Saved data in one scope: `shared` (everyone in the group sees the same) or `personal` (only
 * you — a journal, your progress). Values are any JSON up to 256 KB.
 */
export class SaveScopeStore {
  /** The version each key was at when last read or written (for detecting clashes). */
  private readonly versions = new Map<string, number | null>();

  constructor(
    private readonly bridge: Bridge,
    private readonly scope: SaveScope,
    private readonly options: SaveOptions,
  ) {}

  private get version() {
    return this.options.version ?? 1;
  }

  /** Reads a value (null if nothing is saved), upgraded to the current shape. */
  async get<T extends Json = Json>(key: string): Promise<T | null> {
    const res = (await this.bridge.request({ type: 'save:get', scope: this.scope, key })) as {
      value: Json;
      schemaVersion: number | null;
      version: number | null;
    } | null;
    this.versions.set(key, res?.version ?? null);
    if (!res || res.value === null || res.schemaVersion === null) return null;
    let value: Json = res.value;
    // A newer version of this creation saved it in a shape this one doesn't know: don't guess.
    // (The app offers to rejoin, which opens the newer version.)
    if (res.schemaVersion > this.version) {
      throw new StaleSaveError('Saved by a newer version of this creation. Rejoin to carry on.');
    }
    if (res.schemaVersion < this.version) {
      if (!this.options.migrate) {
        throw new Error(
          `Saved data is version ${res.schemaVersion}; give migrate() to upgrade it.`,
        );
      }
      value = this.options.migrate(value, res.schemaVersion);
    }
    return value as T;
  }

  /**
   * Saves a value. If someone else saved this key since you read it, or a newer version of this
   * creation saved it in a newer shape, it throws `StaleSaveError` instead of overwriting.
   */
  async set(key: string, value: Json): Promise<void> {
    try {
      const res = (await this.bridge.request({
        type: 'save:set',
        scope: this.scope,
        key,
        value,
        schemaVersion: this.version,
        basedOn: this.versions.get(key) ?? null,
      })) as { version: number };
      this.versions.set(key, res.version);
    } catch (err) {
      if (err instanceof BridgeError && err.code === 'stale') throw new StaleSaveError();
      throw err;
    }
  }

  /** Reads, changes and saves a value, retrying if someone else saved in between. */
  async update<T extends Json>(
    key: string,
    change: (current: T | null) => T,
    tries = 3,
  ): Promise<T> {
    for (let i = 0; ; i++) {
      const next = change(await this.get<T>(key));
      try {
        await this.set(key, next);
        return next;
      } catch (err) {
        if (!(err instanceof StaleSaveError) || i >= tries - 1) throw err;
      }
    }
  }
}

/**
 * A stand-in for localStorage (which creations can't use: they run in a sealed frame). Keeps
 * small values for you, privately, between visits.
 */
export class PortalStorage {
  constructor(private readonly personal: SaveScopeStore) {}

  async getItem(key: string): Promise<string | null> {
    const v = await this.personal.get(`storage.${key}`);
    return typeof v === 'string' ? v : null;
  }

  async setItem(key: string, value: string): Promise<void> {
    await this.personal.update(`storage.${key}`, () => value);
  }

  async removeItem(key: string): Promise<void> {
    await this.personal.update(`storage.${key}`, () => null);
  }
}
