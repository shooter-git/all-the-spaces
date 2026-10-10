import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEgressEnv } from '../src/env.ts';

describe('egress settings', () => {
  let dir = '';
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'egress-env-'));
    await writeFile(
      join(dir, 'allow.txt'),
      'registry.npmjs.org\n# a comment\n\napi.anthropic.com # inline\n',
    );
    await writeFile(join(dir, 'deny.txt'), 'metadata.google.internal\n');
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('reads the allow-list from the variable and the file, and the deny-list from its file', () => {
    expect(
      loadEgressEnv({
        EGRESS_ALLOW: 'example.org,,pypi.org',
        EGRESS_ALLOW_FILE: join(dir, 'allow.txt'),
        EGRESS_DENY_FILE: join(dir, 'deny.txt'),
      }),
    ).toEqual({
      allow: ['example.org', 'pypi.org', 'registry.npmjs.org', 'api.anthropic.com'],
      deny: ['metadata.google.internal'],
      port: 3128,
    });
  });

  it('keeps a secret only when it is long enough, and refuses a port that is not one', () => {
    expect(loadEgressEnv({ EGRESS_SECRET: 'short' }).secret).toBeUndefined();
    expect(loadEgressEnv({ EGRESS_SECRET: 's'.repeat(32), EGRESS_PORT: '8080' })).toMatchObject({
      secret: 's'.repeat(32),
      port: 8080,
    });
    expect(() => loadEgressEnv({ EGRESS_PORT: 'http' })).toThrow("EGRESS_PORT isn't a port");
  });
});
