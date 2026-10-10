import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Where the platform's own copy of the SDK lives: creations are always built against it. */
export function sdkPaths() {
  const dirOf = (spec: string) => dirname(dirname(fileURLToPath(import.meta.resolve(spec))));
  return {
    '@allthespaces/portal': dirOf('@allthespaces/portal'),
    '@allthespaces/bridge-protocol': dirOf('@allthespaces/bridge-protocol'),
  };
}

/** The version of the SDK creations are built against. */
export async function sdkVersion(): Promise<string> {
  const pkg = JSON.parse(
    await readFile(join(sdkPaths()['@allthespaces/portal'], 'package.json'), 'utf8'),
  );
  return String(pkg.version);
}
