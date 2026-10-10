import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkAssets, checkDependencies } from '../src/licenses.ts';
import { type Report, reportHtml } from '../src/report.ts';
import { scanForSecrets } from '../src/secrets.ts';
import { readSource, snapshotOf, writeSource } from '../src/snapshot.ts';

const text = (s: string) => new TextEncoder().encode(s);
const dirs: string[] = [];
const scratch = async () => {
  const d = await mkdtemp(join(tmpdir(), 'ats-qa-test-'));
  dirs.push(d);
  return d;
};
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe('secrets', () => {
  it('finds keys, tokens and credential files without repeating them', () => {
    const found = scanForSecrets(
      new Map([
        ['src/main.ts', text(`const a = 1;\nconst key = "sk-ant-oat01-${'a'.repeat(40)}";`)],
        ['src/other.ts', text(`fetch(x, { headers: { authorization: "ghp_${'b'.repeat(36)}" } })`)],
        ['.env', text('NOTHING=1')],
        ['.claude/.credentials.json', text('{}')],
        ['.env.example', text('KEY=')],
        ['README.md', text('Use sk-ant- keys only in the Studio.')],
      ]),
    );
    expect(found).toEqual([
      { path: 'src/main.ts', line: 2, kind: 'an Anthropic key or sign-in token' },
      { path: 'src/other.ts', line: 1, kind: 'a GitHub token' },
      { path: '.env', kind: 'an environment file' },
      { path: '.claude/.credentials.json', kind: "an AI assistant's sign-in file" },
    ]);
    expect(JSON.stringify(found)).not.toContain('aaaa');
  });
});

describe('licences', () => {
  it('wants every asset listed with a publishable licence and a source', () => {
    const problems = checkAssets(
      ['public/tree.glb', 'public/wind.ogg', 'public/logo.svg', 'public/font.woff2', 'src/main.ts'],
      {
        assets: [
          { path: 'public/tree.glb', license: 'CC0-1.0', source: 'https://polyhaven.com/a/tree' },
          { path: 'public/wind.ogg', license: 'CC-BY-NC-4.0', source: 'https://example.org' },
          { path: 'public/logo.svg', license: 'own' },
        ],
      },
    );
    expect(problems.map((p) => p.path)).toEqual(['public/wind.ogg', 'public/font.woff2']);
  });

  it('accepts permissive dependencies only', () => {
    const problems = checkDependencies([
      { name: 'three', version: '0.186.1', license: 'MIT' },
      { name: 'dual', version: '1.0.0', license: '(GPL-3.0 OR MIT)' },
      { name: 'copyleft', version: '2.0.0', license: 'GPL-3.0' },
    ]);
    expect(problems.map((p) => p.path)).toEqual(['copyleft@2.0.0']);
  });
});

describe('source snapshots', () => {
  it('skips dependencies, builds and links, and restores exactly', async () => {
    const dir = await scratch();
    await mkdir(join(dir, 'src'), { recursive: true });
    await mkdir(join(dir, 'node_modules/x'), { recursive: true });
    await mkdir(join(dir, 'dist'), { recursive: true });
    await writeFile(join(dir, 'index.html'), '<p>hi</p>');
    await writeFile(join(dir, 'src/main.ts'), 'export {}');
    await writeFile(join(dir, 'node_modules/x/index.js'), '');
    await writeFile(join(dir, 'dist/index.html'), '');
    await symlink('/etc/hostname', join(dir, 'src/link'));
    const { snapshot, contents, skipped } = await readSource(dir);
    expect(snapshot.files.map((f) => f.path)).toEqual(['index.html', 'src/main.ts']);
    expect(skipped).toEqual(['src/link (a link)']);
    const out = await scratch();
    await writeSource(out, snapshot, async (sha) => {
      const f = snapshot.files.find((x) => x.sha256 === sha);
      return contents.get(f?.path ?? '') as Uint8Array;
    });
    expect(await readFile(join(out, 'src/main.ts'), 'utf8')).toBe('export {}');
    // A tampered file is refused.
    await expect(writeSource(out, snapshot, async () => text('tampered'))).rejects.toThrow(/hash/);
  });
  it("leaves out a member's request pictures (they're for the assistant, not the creation)", async () => {
    const files = new Map<string, Uint8Array>([
      ['index.html', text('<p>hi</p>')],
      ['request/snapshot.jpg', text('jpeg')],
      ['src/request/api.ts', text('export {}')],
    ]);
    expect(snapshotOf(files).snapshot.files.map((f) => f.path)).toEqual([
      'index.html',
      'src/request/api.ts',
    ]);
  });
});

describe('the report page', () => {
  it('escapes everything that came from the creation', () => {
    const report = {
      format: 1,
      ok: false,
      createdAt: new Date(0).toISOString(),
      durationMs: 1,
      creation: {
        title: '<img src=x onerror=alert(1)>',
        tier: 'low',
        sessionMode: 'solo',
        saveVersion: null,
      },
      checks: [{ id: 'errors', status: 'fail', title: 'Error: <script>alert(1)</script>' }],
      viewports: [],
      summary: null,
      build: null,
      source: null,
      credits: [],
      dependencies: [],
      thumbnail: null,
    } as Report;
    const html = reportHtml(report);
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&#60;script&#62;');
  });
});
