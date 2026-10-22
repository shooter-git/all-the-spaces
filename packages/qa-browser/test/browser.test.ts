// Plays real creations in headless Chromium (about a minute each): QA_BROWSER=1 pnpm test
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runInBrowser } from '../src/harness/run.ts';
import { checkProject } from '../src/pipeline.ts';

const run = process.env.QA_BROWSER ? describe : describe.skip;
const here = fileURLToPath(new URL('.', import.meta.url));

async function check(project: string, viewports = ['phone-portrait', 'desktop']) {
  const work = await mkdtemp(join(tmpdir(), 'ats-qa-browser-'));
  try {
    await cp(project, join(work, 'project'), {
      recursive: true,
      filter: (s) => !s.includes('node_modules') && !s.includes('/dist'),
    });
    return await checkProject({
      projectDir: join(work, 'project'),
      distDir: join(work, 'dist'),
      outDir: join(work, 'out'),
      storeDir: join(tmpdir(), 'ats-pnpm-store'),
      playSeconds: 2,
      viewports,
    });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

run('in a real browser', () => {
  it('passes the starter', { timeout: 240_000 }, async () => {
    const result = await check(join(here, '../../../starters/creation'));
    expect(result.report.checks.filter((c) => c.status === 'fail')).toEqual([]);
    expect(result.ok).toBe(true);
  });

  // Creations already published are never rebuilt: the built files of one made with SDK 0.1.0
  // (protocol 1) are frozen, and must keep playing (see docs/protocol-compat.md).
  it('plays a version 1 creation exactly as it was published', { timeout: 120_000 }, async () => {
    const out = await mkdtemp(join(tmpdir(), 'ats-qa-v1-'));
    try {
      const result = await runInBrowser({
        distDir: join(here, 'fixtures/creation-v1/built'),
        outDir: out,
        title: 'A version 1 creation',
        tier: 'low',
        script: null,
        playSeconds: 2,
        viewports: ['phone-portrait', 'desktop'],
      });
      expect(result.checks.filter((c) => c.status === 'fail')).toEqual([]);
      expect(result.saveVersion).toBe(1);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  // Chromium won't start a module worker from a blob: URL in the sealed frame, so creations are
  // built with classic workers; this one is ready only once its worker has answered.
  it('starts an inline worker inside the sealed frame', { timeout: 240_000 }, async () => {
    const result = await check(join(here, 'fixtures/inline-worker'), ['desktop']);
    expect(result.report.checks.filter((c) => c.status === 'fail')).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('answers connector calls from the project’s fixtures, and lists them in the report', {
    timeout: 240_000,
  }, async () => {
    const result = await check(join(here, 'fixtures/lanternfield-desk'));
    expect(result.report.checks.filter((c) => c.status === 'fail')).toEqual([]);
    const calls = result.report.checks.filter((c) => c.id === 'connector-calls');
    expect(calls.length).toBeGreaterThan(0);
    const detail = calls.map((c) => c.detail).join(' · ');
    expect(detail).toContain('lanternfield-library listShelves → 200');
    expect(detail).toContain('lanternfield-library getMyLoans → 200');
    expect(detail).toContain('lanternfield-library borrowBook → 200');
    expect(detail).toContain('lanternfield-library borrowBook → clash');
  });

  it('fails a creation that calls a connector operation it doesn’t declare', {
    timeout: 240_000,
  }, async () => {
    const project = await mkdtemp(join(tmpdir(), 'ats-qa-undeclared-'));
    try {
      await cp(join(here, 'fixtures/lanternfield-desk'), project, { recursive: true });
      const ats = JSON.parse(await readFile(join(project, 'ats.json'), 'utf8'));
      ats.connectors[0].ops = ['listShelves', 'borrowBook'];
      await writeFile(join(project, 'ats.json'), JSON.stringify(ats));
      const result = await check(project);
      expect(result.ok).toBe(false);
      const failed = result.report.checks.filter((c) => c.status === 'fail');
      expect(failed.map((c) => c.id)).toContain('connectors');
      expect(failed.find((c) => c.id === 'connectors')?.detail).toContain(
        'lanternfield-library getMyLoans',
      );
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  it('counts a control in a list that scrolls as reachable, and one off the screen as cut off', {
    timeout: 240_000,
  }, async () => {
    const result = await check(join(here, 'fixtures/long-list'));
    const failed = result.report.checks.filter((c) => c.status === 'fail');
    expect([...new Set(failed.map((c) => c.id))]).toEqual(['cut-off']);
    for (const c of failed) expect(c.detail).toBe('Off the edge');
  });

  it('only warns about a pause in a creation drawing with WebGL, but fails one without', {
    timeout: 480_000,
  }, async () => {
    const drawing = await check(join(here, 'fixtures/slow-shaders'));
    const froze = drawing.report.checks.filter((c) => c.id === 'froze');
    expect(froze.length).toBeGreaterThan(0);
    for (const c of froze) expect(c.status).toBe('warn');
    expect(drawing.report.checks.filter((c) => c.status === 'fail')).toEqual([]);
    expect(drawing.ok).toBe(true);

    const project = await mkdtemp(join(tmpdir(), 'ats-qa-no-webgl-'));
    try {
      await cp(join(here, 'fixtures/slow-shaders'), project, { recursive: true });
      const main = join(project, 'src/main.ts');
      await writeFile(
        main,
        (await readFile(main, 'utf8')).replace("getContext('webgl2')", "getContext('2d') && null"),
      );
      const plain = await check(project);
      expect(plain.report.checks.find((c) => c.id === 'froze')?.status).toBe('fail');
      expect(plain.ok).toBe(false);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  it('fails a creation that is too heavy, and says how to fix it', {
    timeout: 240_000,
  }, async () => {
    const result = await check(join(here, 'fixtures/over-budget'));
    expect(result.ok).toBe(false);
    const failed = Object.fromEntries(
      result.report.checks.filter((c) => c.status === 'fail').map((c) => [c.id, c]),
    );
    expect(Object.keys(failed).sort()).toEqual([
      'audio-routing',
      'draw-calls',
      'heap',
      'textures',
      'voices',
    ]);
    expect(failed['draw-calls']?.title).toContain('400');
    expect(failed.textures?.title).toContain('192.0 MB');
    for (const c of Object.values(failed)) expect(c.fix).toBeTruthy();
  });
});
