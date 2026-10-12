import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Db, schema } from '@ats/db';
import {
  BUILT_IN_GITHUB,
  parseSourceHostDefinition,
  type SourceHostDefinition,
  type StudioSources,
  studioSourcesOf,
} from '@ats/shared';
import { eq } from 'drizzle-orm';
import type { Log } from '../log.ts';

/** A repository host the server's owner allows: its definition, and its token if it has one. */
export interface SourceHost {
  def: SourceHostDefinition;
  /** Only ever used for the repositories the definition file names (ADR 0012). */
  token: string | null;
  /** Where it's set up: a file on the server, or built in (switched on in the Studio). */
  from: 'file' | 'built-in';
  /** Repositories the owner added in the Studio: read as public ones only, never with the token. */
  added: string[];
}

/** The repository hosts on this server. */
export interface SourceHostRegistry {
  get(id: string): SourceHost | undefined;
  list(): SourceHost[];
  /** The built-in GitHub host, when it isn't github.com itself (only tests set it: a fake). */
  builtIn?: SourceHostDefinition;
}

/** A registry of these hosts (a host without `from` is from a file, with nothing added). */
export const sourceHostsOf = (
  hosts: (Omit<SourceHost, 'from' | 'added'> & Partial<Pick<SourceHost, 'from' | 'added'>>)[],
  opts: { builtIn?: SourceHostDefinition | undefined } = {},
): SourceHostRegistry => {
  const all: SourceHost[] = hosts.map((h) => ({ from: 'file', added: [], ...h }));
  const byId = new Map(all.map((h) => [h.def.id, h]));
  return {
    get: (id) => byId.get(id),
    list: () => [...byId.values()],
    ...(opts.builtIn ? { builtIn: opts.builtIn } : {}),
  };
};

export const NO_SOURCE_HOSTS = sourceHostsOf([]);

/**
 * The built-in GitHub host: github.com, only public addresses, never a token. The owner switches
 * it on in the Studio (off by default) and says which repositories, `*` for any public one.
 */
export const BUILT_IN_GITHUB_DEF: SourceHostDefinition = {
  id: BUILT_IN_GITHUB,
  displayName: 'GitHub',
  kind: 'github',
  apiUrl: 'https://api.github.com',
  archiveHosts: ['codeload.github.com'],
  repositories: [],
  allowPrivateAddress: false,
  maxArchiveMb: 150,
};

/**
 * The hosts in files with what the owner chose in the Studio: repositories added to them, and
 * the built-in GitHub host when it's switched on.
 */
export function withStudioSources(files: SourceHostRegistry, studio: StudioSources) {
  const hosts: SourceHost[] = files
    .list()
    .filter((h) => h.from === 'file')
    .map((h) => ({ ...h, added: studio.added[h.def.id] ?? [] }));
  if (studio.github.on)
    hosts.push({
      def: files.builtIn ?? BUILT_IN_GITHUB_DEF,
      token: null,
      from: 'built-in',
      added: studio.github.repositories,
    });
  return sourceHostsOf(hosts, { builtIn: files.builtIn });
}

/** What the owner chose in the Studio (nothing, until they choose). */
export async function studioSources(db: Db): Promise<StudioSources> {
  const [row] = await db
    .select({ sources: schema.installState.sources })
    .from(schema.installState)
    .where(eq(schema.installState.id, 1));
  return studioSourcesOf(row?.sources);
}

/**
 * The repository hosts allowed right now. Files are read when the server starts; the Studio's
 * part is read each time, so the owner's changes count straight away.
 */
export async function currentSourceHosts(db: Db, files: SourceHostRegistry | undefined) {
  return withStudioSources(files ?? NO_SOURCE_HOSTS, await studioSources(db));
}

const FILE = /^([a-z0-9-]{2,32})\.json$/;

/**
 * Reads every `<id>.json` in the repository hosts folder. A file that isn't valid, names another
 * id, takes the built-in host's id, or names a token that isn't set is skipped with a message in
 * the log: one bad file never stops the server or the other hosts. No folder (unset, or
 * missing): no hosts from files.
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
      if (def.id === BUILT_IN_GITHUB)
        throw new Error(`"${BUILT_IN_GITHUB}" is the built-in GitHub host's: choose another id`);
      const token = def.tokenEnv ? source[def.tokenEnv] : undefined;
      if (def.tokenEnv && !token) throw new Error(`${def.tokenEnv} is not set`);
      found.push({ def, token: token ?? null, from: 'file', added: [] });
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
