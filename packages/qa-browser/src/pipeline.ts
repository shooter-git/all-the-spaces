import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ConnectorFixture } from '@allthespaces/bridge-protocol';
import {
  AssetsLock,
  AtsJson,
  type Check,
  checkAssets,
  checkDependencies,
  installedDependencies,
  QaScript,
  type Report,
  readSource,
  reportHtml,
  SnapshotError,
  scanForSecrets,
  sortChecks,
  type Tier,
} from '@ats/qa';
import {
  type BundleFile,
  checkBundle,
  cleanEnv,
  installDependencies,
  listFiles,
  prepareDependencies,
} from './build.ts';
import type { ConvertResult } from './convert.ts';
import type { ConnectorSetup, RunResult } from './harness/run.ts';
import { judgeBudgets } from './harness/run.ts';

const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));

/** A connector's made-up answers for the checks: qa/connectors/<connector>/<op>.json. */
const CONNECTOR_FIXTURE =
  /^qa\/connectors\/([a-z0-9-]{2,32})\/([A-Za-z][A-Za-z0-9_-]{0,63})\.json$/;

function isFixture(v: unknown): v is ConnectorFixture {
  const one = (x: unknown) =>
    !!x &&
    typeof x === 'object' &&
    !Array.isArray(x) &&
    ((x as { status?: unknown }).status === undefined ||
      (Number.isInteger((x as { status?: unknown }).status) &&
        (x as { status: number }).status >= 100 &&
        (x as { status: number }).status <= 599));
  return Array.isArray(v) ? v.length > 0 && v.every(one) : one(v);
}

export type Step = 'source' | 'dependencies' | 'build' | 'play' | 'report';

export interface CheckOptions {
  /** The creation's source (a scratch copy: installing rewrites package.json). */
  projectDir: string;
  /** Where the built creation goes. */
  distDir: string;
  /** Where the report and screenshots go. */
  outDir: string;
  /** pnpm's package cache. */
  storeDir: string;
  onStep?: (step: Step) => void;
  /** Seconds of random play per screen when there's no qa/script.json. */
  playSeconds?: number;
  viewports?: string[];
  /**
   * Run in two parts, in separate containers: `prepare` checks the source and installs its
   * dependencies (it needs the npm registry); `finish` builds and plays it (no network at all).
   * They share `outDir`. Default: both.
   */
  phase?: 'prepare' | 'finish';
}

export interface CheckResult {
  ok: boolean;
  report: Report;
  project: AtsJson | null;
  /** The built creation's files (when it built). */
  files: BundleFile[] | null;
  /** `prepare` finished without problems: run `finish` next. */
  prepared?: boolean;
}

/**
 * Everything a creation goes through before it can be published: its source is checked for
 * secrets and licences, it's built cleanly by the platform, made lighter, and played on phones,
 * a tablet and a laptop. The result is a report the Architect (and their assistant) can act on.
 */
export async function checkProject(opts: CheckOptions): Promise<CheckResult> {
  const started = Date.now();
  const checks: Check[] = [];
  const report: Report = {
    format: 1,
    ok: false,
    createdAt: new Date().toISOString(),
    durationMs: 0,
    creation: { title: 'Untitled creation', tier: 'low', sessionMode: 'shared', saveVersion: null },
    checks,
    viewports: [],
    summary: null,
    build: null,
    source: null,
    credits: [],
    dependencies: [],
    thumbnail: null,
  };
  let project: AtsJson | null = null;
  let files: BundleFile[] | null = null;
  const fail = (c: Omit<Check, 'status'>) => checks.push({ ...c, status: 'fail' });
  const failed = () => checks.some((c) => c.status === 'fail');

  await mkdir(opts.outDir, { recursive: true });
  const statePath = join(opts.outDir, '.state.json');
  let script: QaScript | null = null;
  let connectors: ConnectorSetup | null = null;
  try {
    if (opts.phase === 'finish') {
      const state = JSON.parse(await readFile(statePath, 'utf8'));
      checks.push(...state.checks);
      Object.assign(report, state.report);
      report.checks = checks;
      project = state.project;
      script = state.script;
      connectors = state.connectors ?? null;
    } else {
      // ---- The source -------------------------------------------------------------------------
      opts.onStep?.('source');
      let contents: Map<string, Buffer>;
      try {
        const read = await readSource(opts.projectDir);
        contents = read.contents;
        report.source = {
          hash: read.snapshot.hash,
          files: read.snapshot.files.length,
          bytes: read.snapshot.bytes,
        };
      } catch (err) {
        if (!(err instanceof SnapshotError)) throw err;
        fail({ id: 'source', title: err.message });
        return await finish();
      }
      const secrets = scanForSecrets(contents);
      if (secrets.length)
        fail({
          id: 'secrets',
          title: `The source contains ${secrets.length === 1 ? 'something that looks like a secret' : `${secrets.length} things that look like secrets`}`,
          detail: secrets
            .slice(0, 5)
            .map((s) => `${s.path}${s.line ? ` line ${s.line}` : ''}: ${s.kind}`)
            .join(' · '),
          fix: 'Remove keys, tokens, passwords and sign-in files from the project. Creations never need them.',
        });
      else checks.push({ id: 'secrets', status: 'pass', title: 'No secrets in the source' });

      const json = <T>(path: string, parse: (v: unknown) => T): T | null => {
        const data = contents.get(path);
        if (!data) return null;
        try {
          return parse(JSON.parse(data.toString('utf8')));
        } catch (err) {
          fail({
            id: path,
            title: `${path} isn't valid`,
            detail: (err as Error).message.slice(0, 400),
          });
          return null;
        }
      };
      project = contents.has('ats.json') ? json('ats.json', (v) => AtsJson.parse(v)) : null;
      if (!contents.has('ats.json'))
        fail({
          id: 'ats.json',
          title: 'ats.json is missing',
          fix: 'Add ats.json with at least a "title".',
        });
      if (project)
        report.creation = {
          title: project.title,
          tier: project.budgetTier as Tier,
          sessionMode: project.sessionMode,
          saveVersion: null,
        };
      const lock = contents.has('assets.lock.json')
        ? json('assets.lock.json', (v) => AssetsLock.parse(v))
        : { assets: [] };
      if (lock) {
        report.credits = lock.assets.map((a) => ({
          path: a.path,
          license: a.license,
          ...(a.source ? { source: a.source } : {}),
          ...(a.title ? { title: a.title } : {}),
          ...(a.author ? { author: a.author } : {}),
        }));
        const problems = checkAssets([...contents.keys()], lock);
        if (problems.length)
          fail({
            id: 'asset-licences',
            title: `${problems.length} asset${problems.length === 1 ? ' needs' : 's need'} a licence entry`,
            detail: problems
              .slice(0, 6)
              .map((p) => `${p.path} ${p.problem}`)
              .join(' · '),
            fix: 'List every file you didn\'t make yourself in assets.lock.json with its licence (CC0-1.0 or compatible) and where it came from; mark things made for this creation as "own".',
          });
        else
          checks.push({
            id: 'asset-licences',
            status: 'pass',
            title: lock.assets.length
              ? `Every asset has a licence (${lock.assets.length})`
              : 'No outside assets',
          });
      }
      script = contents.has('qa/script.json')
        ? json('qa/script.json', (v) => QaScript.parse(v))
        : null;
      // Connectors it calls, and the made-up answers the checks give (qa/connectors/<id>/<op>.json).
      const fixtures: ConnectorSetup['fixtures'] = {};
      for (const path of contents.keys()) {
        const m = CONNECTOR_FIXTURE.exec(path);
        if (!m) continue;
        const fixture = json(path, (v) => {
          if (!isFixture(v))
            throw new Error('Give { "status", "body" }, or a list of them with "match".');
          return v;
        });
        if (fixture) {
          fixtures[m[1] as string] ??= {};
          (fixtures[m[1] as string] as Record<string, unknown>)[m[2] as string] = fixture;
        }
      }
      if (project?.connectors?.length || Object.keys(fixtures).length)
        connectors = {
          declared: (project?.connectors ?? []).map((c) => ({ id: c.id, ops: c.ops })),
          fixtures,
        };
      if (!contents.has('index.html'))
        fail({
          id: 'index',
          title: 'index.html is missing',
          fix: 'A creation starts from index.html at the top of the project.',
        });
      if (failed()) return await finish();

      // ---- Dependencies -----------------------------------------------------------------------
      opts.onStep?.('dependencies');
      for (const p of await prepareDependencies(opts.projectDir))
        fail({ id: 'dependencies', ...p });
      if (failed()) return await finish();
      const install = await installDependencies(opts.projectDir, { storeDir: opts.storeDir });
      if (!install.ok) {
        fail({
          id: 'install',
          title: "Its dependencies couldn't be installed",
          detail:
            install.log
              .split('\n')
              .filter((l) => /ERR|error|not found/i.test(l))
              .slice(-4)
              .join(' · ') || install.log.slice(-400),
          fix: 'Check the package names and versions in package.json exist on npm.',
        });
        return await finish();
      }
      if (opts.phase === 'prepare') {
        await writeFile(statePath, JSON.stringify({ checks, report, project, script, connectors }));
        return { ok: true, prepared: true, report, project, files: null };
      }
    }
    const deps = await installedDependencies(opts.projectDir);
    report.dependencies = deps;
    const depProblems = checkDependencies(deps);
    if (depProblems.length)
      fail({
        id: 'dependency-licences',
        title: `${depProblems.length} dependenc${depProblems.length === 1 ? 'y has' : 'ies have'} an incompatible licence`,
        detail: depProblems
          .slice(0, 6)
          .map((p) => `${p.path} ${p.problem}`)
          .join(' · '),
        fix: 'Use packages under MIT, ISC, BSD, Apache-2.0 or similar permissive licences.',
      });
    else
      checks.push({
        id: 'dependency-licences',
        status: 'pass',
        title: `Dependencies have compatible licences (${deps.length})`,
      });
    if (failed()) return await finish();

    // ---- Build ------------------------------------------------------------------------------
    opts.onStep?.('build');
    await rm(opts.distDir, { recursive: true, force: true });
    const built = await child<{ ok: boolean; error?: string; convert?: ConvertResult }>([
      'build',
      opts.projectDir,
      opts.distDir,
      '--tier',
      report.creation.tier,
    ]);
    if (!built.ok) {
      fail(buildFailure(built));
      return await finish();
    }
    files = await listFiles(opts.distDir);
    const bundleProblems = await checkBundle(opts.distDir, files);
    for (const p of bundleProblems) fail({ id: 'bundle', ...p });
    report.build = {
      files: files.length,
      bytes: files.reduce((a, f) => a + f.bytes, 0),
      conversions: built.convert?.conversions ?? [],
      notes: built.convert?.notes ?? [],
    };
    if (!bundleProblems.length)
      checks.push({ id: 'build', status: 'pass', title: 'Built cleanly' });
    if (failed()) return await finish();

    // ---- Play it ----------------------------------------------------------------------------
    opts.onStep?.('play');
    const scriptFile = join(opts.outDir, '.script.json');
    if (script) await writeFile(scriptFile, JSON.stringify(script));
    const connectorsFile = join(opts.outDir, '.connectors.json');
    if (connectors) await writeFile(connectorsFile, JSON.stringify(connectors));
    const played = await child<{ ok: boolean; error?: string; result?: RunResult }>(
      [
        'play',
        opts.distDir,
        opts.outDir,
        '--title',
        report.creation.title,
        '--tier',
        report.creation.tier,
        ...(script ? ['--script', scriptFile] : []),
        ...(connectors ? ['--connectors', connectorsFile] : []),
        ...(opts.playSeconds !== undefined ? ['--seconds', String(opts.playSeconds)] : []),
        ...(opts.viewports ? ['--viewports', opts.viewports.join(',')] : []),
      ],
      PLAY_MINUTES * 60_000,
    );
    await rm(scriptFile, { force: true });
    await rm(connectorsFile, { force: true });
    if (!played.ok || !played.result) {
      fail({ id: 'play', title: "It couldn't be played", detail: played.error?.slice(0, 800) });
      return await finish();
    }
    const run = played.result;
    report.viewports = run.viewports;
    report.creation.saveVersion = run.saveVersion;
    checks.push(...run.checks);
    const judged = judgeBudgets(
      report.creation.tier,
      run.viewports,
      run.initialBytes,
      report.build.bytes,
    );
    checks.push(...judged.checks);
    report.summary = judged.summary;
    const screens = run.viewports.filter((v) => v.readyMs !== null).map((v) => v.label);
    if (screens.length === run.viewports.length && !run.checks.some((c) => c.status === 'fail'))
      checks.push({
        id: 'screens',
        status: 'pass',
        title: `Works on every screen (${screens.join(', ')})`,
      });
    report.thumbnail =
      run.viewports.find((v) => v.name === 'desktop')?.screenshots[0]?.file ??
      run.viewports[0]?.screenshots[0]?.file ??
      null;
    return await finish();
  } catch (err) {
    fail({
      id: 'internal',
      title: 'The checks themselves went wrong',
      detail: (err as Error).message,
    });
    return await finish();
  }

  async function finish(): Promise<CheckResult> {
    opts.onStep?.('report');
    await rm(statePath, { force: true });
    report.checks = sortChecks(checks);
    report.ok = !checks.some((c) => c.status === 'fail');
    report.durationMs = Date.now() - started;
    await writeFile(join(opts.outDir, 'report.json'), JSON.stringify(report, null, 2));
    await writeFile(join(opts.outDir, 'report.html'), reportHtml(report));
    return { ok: report.ok, report, project, files: report.ok ? files : null };
  }
}

/**
 * How long playing on every screen may take. Every screenshot waits for the browser to draw a
 * frame on the CPU: on a busy server (load 20 on 8 CPUs) a 3D creation's took 12 to 30 seconds
 * each, and a creation with screenshots of its own took 14½ minutes to play, passing everything.
 */
const PLAY_MINUTES = 25;

/** A step that crashed or ran out of time, so it couldn't say what happened itself. */
interface ChildFailure {
  ok: false;
  error: string;
  timedOut?: true;
}

/** The failed check for a build that failed or ran out of time. */
export function buildFailure(built: { error?: string; timedOut?: boolean }): Omit<Check, 'status'> {
  // Workers are built as classic scripts (see cleanBuild), and those can't wait at the top.
  const workerAwaits = /Top-level await is (currently )?not supported with the 'iife'/.test(
    built.error ?? '',
  );
  return {
    id: 'build',
    title: "It didn't build",
    detail: built.error?.slice(0, 800),
    fix: built.timedOut
      ? 'Building took too long, usually because the server was busy: try again. If it keeps happening, the creation has files that take long to check (many large sounds or models): fewer or smaller ones help.'
      : workerAwaits
        ? "A worker can't use `await` outside a function: workers are built as classic scripts, the only kind the creation's frame can start. Move the `await` into a function, such as the worker's onmessage."
        : 'Fix the error above. The platform builds with its own settings (vite.config is ignored): import files by relative path and keep assets in public/ or import them.',
  };
}

/**
 * Runs a step in its own process with nothing secret in its environment: it handles code and
 * files from the creation, so it never shares a process with the platform's credentials.
 */
function child<T>(args: string[], timeout = 5 * 60_000): Promise<T | ChildFailure> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args, '--json'],
      { timeout, maxBuffer: 64 * 1024 * 1024, env: cleanEnv() },
      (err, stdout, stderr) => {
        const last = stdout.trim().split('\n').pop() ?? '';
        try {
          resolve(JSON.parse(last) as T);
        } catch {
          const timedOut = !!err?.killed;
          const error = timedOut
            ? `It took longer than ${Math.round(timeout / 60_000)} minutes.`
            : (stderr || err?.message || 'failed').slice(-2000);
          resolve({ ok: false, error, ...(timedOut && { timedOut }) });
        }
      },
    );
  });
}

/** Reads a report written by `checkProject`. */
export async function readReport(outDir: string): Promise<Report> {
  return JSON.parse(await readFile(join(outDir, 'report.json'), 'utf8')) as Report;
}
