import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseSourceHostDefinition, type SourceHostDefinition } from '@ats/shared';
import type { Log } from '../log.ts';

/** A repository host the server's owner allows: its definition, and its token if it has one. */
export interface SourceHost {
  def: SourceHostDefinition;
  token: string | null;
}

/** The repository hosts installed on this server (read once, at start). */
export interface SourceHostRegistry {
  get(id: string): SourceHost | undefined;
  list(): SourceHost[];
}

export const sourceHostsOf = (hosts: SourceHost[]): SourceHostRegistry => {
  const byId = new Map(hosts.map((h) => [h.def.id, h]));
  return { get: (id) => byId.get(id), list: () => [...byId.values()] };
};

export const NO_SOURCE_HOSTS = sourceHostsOf([]);

const FILE = /^([a-z0-9-]{2,32})\.json$/;

/**
 * Reads every `<id>.json` in the repository hosts folder. A file that isn't valid, names another
 * id, or names a token that isn't set is skipped with a message in the log: one bad file never
 * stops the server or the other hosts. No folder (unset, or missing): no repositories.
 */
export async function loadSourceHosts(
  dir: string | undefined,
  source: NodeJS.ProcessEnv,
  log: Pick<Log, 'info' | 'warn'>,
): Promise<SourceHostRegistry> {
  if (!dir) return NO_SOURCE_HOSTS;
  let names: string[];
  try {
    names = (await readdir(dir)).sort();
  } catch (err) {
    // The installer always makes the folder; only a server set up by hand might not have one.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
      log.warn({ dir, err: (err as Error).message }, 'repositories: the folder could not be read');
    return NO_SOURCE_HOSTS;
  }
  const found: SourceHost[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const id = FILE.exec(name)?.[1];
    if (!id) {
      log.warn({ file: name }, 'repositories: skipped (name it <id>.json: a-z, 0-9 and -)');
      continue;
    }
    try {
      const def = parseSourceHostDefinition(JSON.parse(await readFile(join(dir, name), 'utf8')));
      if (def.id !== id) throw new Error(`its id is "${def.id}", but the file is ${name}`);
      const token = def.tokenEnv ? source[def.tokenEnv] : undefined;
      if (def.tokenEnv && !token) throw new Error(`${def.tokenEnv} is not set`);
      found.push({ def, token: token ?? null });
      log.info(
        { host: id, repositories: def.repositories.length, token: Boolean(token) },
        'repositories: host installed',
      );
    } catch (err) {
      log.warn({ file: name, err: (err as Error).message }, 'repositories: skipped');
    }
  }
  return sourceHostsOf(found);
}
