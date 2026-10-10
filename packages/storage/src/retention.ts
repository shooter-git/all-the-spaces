// Which backup folders are old enough to delete. Folder names start with a UTC timestamp and end
// with what made them: "auto" (scheduled), "manual" (ats-admin backup) or "before-<release>"
// (an update). Only scheduled backups expire on their own; the others only when asked.
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const NAME = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-([A-Za-z0-9._-]+)$/;
const DAY = 86_400_000;

export const AUTO_LABEL = 'auto';

export interface BackupName {
  time: Date;
  label: string;
}

/** The time and label of a backup folder name, or null for anything else. */
export function parseBackupName(name: string): BackupName | null {
  const m = NAME.exec(name);
  if (!m) return null;
  const n = (i: number) => Number(m[i]);
  const time = new Date(Date.UTC(n(1), n(2) - 1, n(3), n(4), n(5), n(6)));
  return { time, label: m[7] ?? '' };
}

export interface RetentionOptions {
  keepDays: number;
  now?: Date;
  /** Also let manual and pre-update backups expire. */
  includeManual?: boolean;
  /** Never delete these (the backup an update would roll back to). */
  protect?: readonly string[];
}

/** The backups older than `keepDays`, oldest first. The newest one that could expire is always
 *  kept, so a server whose backups stop working never ends up with none. */
export function expiredBackups(names: readonly string[], opts: RetentionOptions): string[] {
  const cutoff = (opts.now ?? new Date()).getTime() - opts.keepDays * DAY;
  const candidates = names
    .map((name) => ({ name, parsed: parseBackupName(name) }))
    .filter(
      (c): c is { name: string; parsed: BackupName } =>
        c.parsed !== null && (opts.includeManual || c.parsed.label === AUTO_LABEL),
    )
    .sort((a, b) => a.parsed.time.getTime() - b.parsed.time.getTime());
  const newest = candidates.at(-1)?.name;
  const protect = new Set(opts.protect ?? []);
  return candidates
    .filter((c) => c.name !== newest && !protect.has(c.name) && c.parsed.time.getTime() < cutoff)
    .map((c) => c.name);
}

/** Deletes the expired backup folders in `root`; returns their names. */
export async function pruneLocal(root: string, opts: RetentionOptions): Promise<string[]> {
  const names = (await readdir(root, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  const expired = expiredBackups(names, opts);
  for (const name of expired) await rm(join(root, name), { recursive: true, force: true });
  return expired;
}
