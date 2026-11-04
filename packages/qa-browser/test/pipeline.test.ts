import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildFailure, child, playFailure } from '../src/pipeline.ts';

describe('a build that failed', () => {
  it('points at the error when the build broke', () => {
    const check = buildFailure({ error: 'Could not resolve "./missing.ts"' });
    expect(check.detail).toBe('Could not resolve "./missing.ts"');
    expect(check.fix).toMatch(/^Fix the error above/);
  });

  it('says how to fix a worker that waits at the top, since workers are built as classic', () => {
    const check = buildFailure({
      error:
        "[plugin vite:worker] Error: Build failed with 1 error:\n[UNSUPPORTED_FEATURE] Top-level await is currently not supported with the 'iife' output format",
    });
    expect(check.fix).toMatch(/^A worker can't use `await` outside a function/);
  });

  it('says to try again when it ran out of time, not to fix an error', () => {
    const check = buildFailure({ error: 'It took longer than 5 minutes.', timedOut: true });
    expect(check.detail).toBe('It took longer than 5 minutes.');
    expect(check.fix).toMatch(/^Building took too long, usually because the server was busy/);
    expect(check.fix).toMatch(/many large sounds or models/);
    expect(check.fix).not.toMatch(/vite\.config/);
  });
});

describe('a play that failed', () => {
  it('says what went wrong', () => {
    const check = playFailure({ error: 'Error: browserType.launch: Executable does not exist' });
    expect(check).toEqual({
      id: 'play',
      title: "It couldn't be played",
      detail: 'Error: browserType.launch: Executable does not exist',
    });
  });

  it('says to try again, or shorten its script, when it ran out of time', () => {
    const check = playFailure({ error: 'It took longer than 25 minutes.', timedOut: true });
    expect(check.detail).toBe('It took longer than 25 minutes.');
    expect(check.fix).toMatch(/^Playing took too long, usually because the server was busy/);
    expect(check.fix).toMatch(/shorten qa\/script\.json/);
  });
});

describe('a step in its own process', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ats-qa-child-'));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  /** A stand-in for the CLI: runs `code`, with the first argument it's given as `arg`. */
  async function cli(name: string, code: string) {
    const path = join(dir, `${name}.mjs`);
    await writeFile(path, `const arg = process.argv[2];\n${code}`);
    return path;
  }

  it('keeps the result it printed last, passing on what it said before', async () => {
    const path = await cli(
      'done',
      `console.log('::log Phone, upright: ready in 5.9 s');
       console.log(JSON.stringify({ ok: true, result: { arg } }));`,
    );
    const said: string[] = [];
    expect(await child(['x'], 10_000, (l) => said.push(l), path)).toEqual({
      ok: true,
      result: { arg: 'x' },
    });
    expect(said).toEqual(['Phone, upright: ready in 5.9 s']);
  });

  // Playing does this: stopped, Playwright closes its browser, its next wait throws, and the CLI
  // prints that as its result: a closed page, when what happened was the time running out.
  it('says it ran out of time, whatever it printed as it was stopped', async () => {
    const printed = join(dir, 'printed');
    const path = await cli(
      'stopped',
      `const { writeFileSync } = await import('node:fs');
       process.on('SIGTERM', () => {
         const result = JSON.stringify({
           ok: false,
           error: 'page.waitForTimeout: Target page, context or browser has been closed',
         });
         console.log(result);
         writeFileSync(arg, result);
         process.exit(1);
       });
       console.log('::log Phone, upright: following its script (60 steps)');
       setInterval(() => {}, 1000);`,
    );
    const said: string[] = [];
    const result = await child([printed], 1500, (l) => said.push(l), path);
    expect(said).toEqual(['Phone, upright: following its script (60 steps)']);
    expect(await readFile(printed, 'utf8')).toMatch(/browser has been closed/);
    expect(result).toMatchObject({ ok: false, timedOut: true });
    const { error } = result as { error: string };
    expect(error).toMatch(/^It took longer than \d+ minutes\.$/);
    expect(playFailure({ error, timedOut: true }).fix).toMatch(/^Playing took too long/);
  });
});
