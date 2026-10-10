import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkAssets } from '../src/licenses.ts';
import { AssetsLock, AtsJson } from '../src/project.ts';
import { scanForSecrets } from '../src/secrets.ts';
import { readSource } from '../src/snapshot.ts';

// A creation published with SDK 0.1.0 (protocol 1), frozen with the browser checks' fixtures:
// its source must keep passing these checks, as its built files must keep playing in a host
// (@ats/qa-browser, QA_BROWSER=1). See docs/protocol-compat.md.
const SOURCE = fileURLToPath(
  new URL('../../qa-browser/test/fixtures/creation-v1/source', import.meta.url),
);

describe('a version 1 creation', () => {
  it('still passes the source checks', async () => {
    const { contents, skipped } = await readSource(SOURCE);
    expect(skipped).toEqual([]);
    const text = (path: string) => JSON.parse(contents.get(path)?.toString('utf8') ?? 'null');
    expect(AtsJson.safeParse(text('ats.json')).success).toBe(true);
    const lock = AssetsLock.safeParse(text('assets.lock.json'));
    expect(lock.success).toBe(true);
    if (!lock.success) return;
    expect(checkAssets([...contents.keys()], lock.data)).toEqual([]);
    expect(scanForSecrets(contents)).toEqual([]);
  });
});
