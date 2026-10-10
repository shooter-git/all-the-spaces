#!/usr/bin/env node
/**
 * ats-qa: the steps of checking a creation, each runnable on its own.
 *
 *   ats-qa check <project> [<out>]      everything: source, dependencies, build, play, report
 *   ats-qa build <project> <dist>       clean build and lighter assets (the project must be installed)
 *   ats-qa play <dist> <out>            play a built creation on every screen size
 *   ats-qa watch <project> <out>        the live preview: rebuild whenever files change
 *   ats-qa prepare <project> <out>      source checks and dependencies (needs the npm registry)
 *   ats-qa finish <project> <dist> <out>  build, play and report (after prepare; no network)
 *
 * With --json, the last line printed is a JSON result (used by the pipeline).
 */
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { QaScript, type Tier } from '@ats/qa';
import { cleanBuild, listFiles } from './build.ts';
import { convertAssets } from './convert.ts';
import { type ConnectorSetup, runInBrowser } from './harness/run.ts';
import { checkProject } from './pipeline.ts';
import { watch } from './watch.ts';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    json: { type: 'boolean' },
    tier: { type: 'string', default: 'low' },
    title: { type: 'string', default: 'Creation' },
    script: { type: 'string' },
    seconds: { type: 'string' },
    viewports: { type: 'string' },
    store: { type: 'string' },
    connectors: { type: 'string' },
  },
});
const [command, a, b] = positionals;
const tier = values.tier as Tier;
const out = (result: unknown) => console.log(JSON.stringify(result));

try {
  if (command === 'build' && a && b) {
    await cleanBuild(resolve(a), resolve(b));
    const convert = await convertAssets(resolve(b), await listFiles(resolve(b)), tier);
    out({ ok: true, convert });
  } else if (command === 'play' && a && b) {
    const script = values.script
      ? QaScript.parse(JSON.parse(await readFile(values.script, 'utf8')))
      : null;
    const connectors = values.connectors
      ? (JSON.parse(await readFile(values.connectors, 'utf8')) as ConnectorSetup)
      : undefined;
    const result = await runInBrowser({
      distDir: resolve(a),
      outDir: resolve(b),
      title: values.title as string,
      tier,
      script,
      ...(connectors ? { connectors } : {}),
      ...(values.seconds ? { playSeconds: Number(values.seconds) } : {}),
      ...(values.viewports ? { viewports: values.viewports.split(',') } : {}),
    });
    out({ ok: true, result });
  } else if (
    (command === 'prepare' && a && b) ||
    (command === 'finish' && a && b && positionals[3])
  ) {
    const result = await checkProject({
      projectDir: resolve(a),
      distDir: command === 'finish' ? resolve(b) : resolve(a, '..', 'dist'),
      outDir: resolve(command === 'finish' ? (positionals[3] as string) : b),
      storeDir: values.store ?? join(tmpdir(), 'ats-pnpm-store'),
      phase: command,
      ...(values.seconds ? { playSeconds: Number(values.seconds) } : {}),
    });
    out({ ok: result.ok, prepared: result.prepared ?? false, files: result.files });
  } else if (command === 'watch' && a && b) {
    await watch(resolve(a), resolve(b));
  } else if (command === 'check' && a) {
    // Works on a scratch copy: installing rewrites package.json.
    const work = await mkdtemp(join(tmpdir(), 'ats-qa-'));
    const project = join(work, 'project');
    await cp(resolve(a), project, {
      recursive: true,
      filter: (src) =>
        !/[/\\](node_modules|dist|\.git)([/\\]|$)/.test(src.slice(resolve(a).length)),
    });
    const outDir = resolve(b ?? join(a, 'qa-output'));
    const result = await checkProject({
      projectDir: project,
      distDir: join(work, 'dist'),
      outDir,
      storeDir: values.store ?? join(tmpdir(), 'ats-pnpm-store'),
      onStep: (s) => values.json || console.error(`… ${s}`),
      ...(values.seconds ? { playSeconds: Number(values.seconds) } : {}),
      ...(values.viewports ? { viewports: values.viewports.split(',') } : {}),
    });
    await rm(work, { recursive: true, force: true });
    if (values.json) out({ ok: result.ok });
    else {
      for (const c of result.report.checks)
        console.log(
          `${c.status === 'pass' ? 'pass' : c.status === 'warn' ? 'note' : 'FAIL'}  ${c.title}${c.where ? ` (${c.where})` : ''}${c.status !== 'pass' && c.detail ? `\n      ${c.detail}` : ''}${c.status !== 'pass' && c.fix ? `\n      → ${c.fix}` : ''}`,
        );
      console.log(
        `\n${result.ok ? 'Ready.' : 'Not ready yet.'} Report: ${join(outDir, 'report.html')}`,
      );
    }
    process.exitCode = result.ok ? 0 : 1;
  } else {
    console.error(
      'Usage: ats-qa check <project> [<out>] | build <project> <dist> | play <dist> <out>',
    );
    process.exitCode = 2;
  }
} catch (err) {
  if (values.json) out({ ok: false, error: (err as Error).stack ?? String(err) });
  else console.error(err);
  process.exitCode = 1;
}
