import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { prepareDependencies } from '../src/build.ts';

const dirs: string[] = [];
const scratch = async () => {
  const d = await mkdtemp(join(tmpdir(), 'ats-qa-test-'));
  dirs.push(d);
  return d;
};
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe('preparing dependencies', () => {
  it('allows only published packages, uses the platform SDK, and ignores install hooks', async () => {
    const dir = await scratch();
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'x',
        scripts: { postinstall: 'curl evil' },
        dependencies: {
          '@allthespaces/portal': 'workspace:*',
          three: '0.186.1',
          sneaky: 'git+https://example.org/x.git',
          local: 'file:../../secrets',
          gh: 'someone/repo',
        },
        devDependencies: { vite: '8.3.1' },
        pnpm: { overrides: { three: 'file:/etc' } },
      }),
    );
    await writeFile(join(dir, '.pnpmfile.cjs'), 'module.exports = {}');
    await writeFile(join(dir, '.npmrc'), 'registry=https://evil.example/');
    await writeFile(
      join(dir, 'tsconfig.json'),
      '{ "extends": "../../x.json", "compilerOptions": { "jsx": "react-jsx", "paths": {} } }',
    );
    const problems = await prepareDependencies(dir);
    expect(problems.map((p) => p.title)).toEqual([
      'The dependency "sneaky" isn\'t a version range (git+https://example.org/x.git)',
      'The dependency "local" isn\'t a version range (file:../../secrets)',
      'The dependency "gh" isn\'t a version range (someone/repo)',
    ]);
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    expect(Object.keys(pkg)).toEqual(['name', 'private', 'type', 'dependencies']);
    expect(pkg.dependencies.three).toBe('0.186.1');
    expect(pkg.dependencies['@allthespaces/portal']).toMatch(/^link:\/.*portal-sdk$/);
    await expect(readFile(join(dir, '.pnpmfile.cjs'))).rejects.toThrow();
    await expect(readFile(join(dir, '.npmrc'))).rejects.toThrow();
    const ts = JSON.parse(await readFile(join(dir, 'tsconfig.json'), 'utf8'));
    expect(ts).toEqual({
      compilerOptions: expect.objectContaining({ jsx: 'react-jsx', moduleResolution: 'Bundler' }),
    });
    expect(ts.extends).toBeUndefined();
  });
});
