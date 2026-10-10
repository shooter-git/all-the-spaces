import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type ConnectorDefinition, parseConnectorDefinition } from '@ats/shared';
import type { Log } from '../log.ts';

/** An installed connector: its definition, and the client secret from the environment. */
export interface Connector {
  def: ConnectorDefinition;
  clientSecret: string;
}

/** The connectors this server's owner installed (read once, at start). */
export interface ConnectorRegistry {
  get(id: string): Connector | undefined;
  list(): Connector[];
}

export const registryOf = (connectors: Connector[]): ConnectorRegistry => {
  const byId = new Map(connectors.map((c) => [c.def.id, c]));
  return { get: (id) => byId.get(id), list: () => [...byId.values()] };
};

export const NO_CONNECTORS = registryOf([]);

const FILE = /^([a-z0-9-]{2,32})\.json$/;

/**
 * Reads every `<id>.json` in the connectors folder. A file that isn't valid, names another id, or
 * whose client secret isn't set is skipped with a message in the log: one bad file never stops
 * the server or the other connectors. No folder (unset, or missing): no connectors.
 */
export async function loadConnectors(
  dir: string | undefined,
  source: NodeJS.ProcessEnv,
  log: Pick<Log, 'info' | 'warn'>,
): Promise<ConnectorRegistry> {
  if (!dir) return NO_CONNECTORS;
  let names: string[];
  try {
    names = (await readdir(dir)).sort();
  } catch (err) {
    log.warn({ dir, err: (err as Error).message }, 'connectors: the folder could not be read');
    return NO_CONNECTORS;
  }
  const found: Connector[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const id = FILE.exec(name)?.[1];
    if (!id) {
      log.warn({ file: name }, 'connectors: skipped (name it <id>.json: a-z, 0-9 and -)');
      continue;
    }
    try {
      const def = parseConnectorDefinition(JSON.parse(await readFile(join(dir, name), 'utf8')));
      if (def.id !== id) throw new Error(`its id is "${def.id}", but the file is ${name}`);
      const clientSecret = source[def.oauth.clientSecretEnv];
      if (!clientSecret) throw new Error(`${def.oauth.clientSecretEnv} is not set`);
      found.push({ def, clientSecret });
      log.info(
        { connector: id, operations: Object.keys(def.operations).length },
        'connectors: installed',
      );
    } catch (err) {
      log.warn({ file: name, err: (err as Error).message }, 'connectors: skipped');
    }
  }
  return registryOf(found);
}
