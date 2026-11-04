import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PROTOCOL_VERSION } from '@allthespaces/bridge-protocol';
import { type Db, schema } from '@ats/db';
import { AtsJson, cleanLine, type Report, readProgress, sdkVersion } from '@ats/qa';
import { packTar, unpackTar } from '@ats/shared';
import type { Storage } from '@ats/storage';
import { Queue, Worker } from 'bullmq';
import { and, eq, inArray } from 'drizzle-orm';
import { afterBuild } from '../commissions.ts';
import { type Log, silent } from '../log.ts';
import type { Notifier } from '../notify.ts';
import { recordSourceBuild } from '../sources/service.ts';
import { recordPlacements } from '../space-updates.ts';
import type { Supervisor } from '../studio/supervisor.ts';
import { downloadSourceFiles } from './sources.ts';
import { publishCreation } from './store.ts';

const { builds } = schema;

export const BUILD_QUEUE = 'creation-builds';
export const reportKey = (buildId: string, file: string) => `reports/${buildId}/${file}`;

const STEP_WORDS = {
  source: 'Checking the source',
  dependencies: 'Installing what it needs',
  build: 'Building it',
  play: 'Trying it on phones, a tablet and a laptop',
  report: 'Writing the report',
} as const;

/** The newest lines of what a build's checks said, kept with it for the Studio. */
export const LOG_LINES = 120;

/**
 * What a build's checks say as they go: the newest lines, saved with the build every two seconds
 * at most (`stop` saves the last of them).
 */
function follow(save: (values: { log: string }) => Promise<unknown>) {
  const lines: string[] = [];
  let changed = false;
  let saving: Promise<unknown> = Promise.resolve();
  const flush = () => {
    if (!changed) return saving;
    changed = false;
    const log = lines.join('\n');
    saving = saving.then(() => save({ log })).catch(() => {});
    return saving;
  };
  const timer = setInterval(flush, 2000);
  return {
    line(text: string) {
      const clean = cleanLine(text);
      if (!clean) return;
      lines.push(clean);
      if (lines.length > LOG_LINES) lines.splice(0, lines.length - LOG_LINES);
      changed = true;
    },
    stop() {
      clearInterval(timer);
      return flush();
    },
  };
}

/** A short summary of a report, kept with the build and the version. */
export function qaOf(report: Report): schema.VersionQa {
  return {
    ok: report.ok,
    failed: report.checks.filter((c) => c.status === 'fail').length,
    warned: report.checks.filter((c) => c.status === 'warn').length,
    thumbnail: report.thumbnail,
    summary: report.summary as Record<string, number> | null,
  };
}

/**
 * Builds and checks one creation from its source snapshot, stores the report, and (when it
 * passes) stores the build as a new version: live straight away, or as a candidate to try.
 */
export async function runBuild(
  db: Db,
  storage: Storage,
  buildId: string,
  opts: {
    workRoot?: string;
    storeDir?: string;
    playSeconds?: number;
    supervisor?: Supervisor;
    /** Tells people when a request it was built for moves on. */
    notifier?: Notifier;
    log?: Log;
  } = {},
) {
  await checkAndStore(db, storage, buildId, opts);
  // A request it was built for follows it.
  await afterBuild(db, opts.notifier, buildId).catch((err: Error) =>
    (opts.log ?? silent).error(
      { buildId, err: err.message },
      'a build could not update its request',
    ),
  );
}

async function checkAndStore(
  db: Db,
  storage: Storage,
  buildId: string,
  opts: { workRoot?: string; storeDir?: string; playSeconds?: number; supervisor?: Supervisor },
) {
  const [build] = await db.select().from(builds).where(eq(builds.id, buildId));
  if (!build || !['queued', 'running'].includes(build.status)) return;
  const set = (values: Partial<typeof builds.$inferInsert>) =>
    db
      .update(builds)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(builds.id, buildId));
  await set({ status: 'running', step: 'Getting the source' });
  const log = follow(set);
  try {
    const source = await downloadSourceFiles(storage, build.groupId, build.sourceHash);
    const checked = opts.supervisor
      ? await checkInContainers(opts.supervisor, buildId, source, (step) => set({ step }), log.line)
      : await checkHere(source, opts, (step) => set({ step }), log.line);
    await log.stop();
    for (const [file, data] of checked.reportFiles) {
      const type = file.endsWith('.png')
        ? 'image/png'
        : file.endsWith('.html')
          ? 'text/html'
          : 'application/json';
      await storage.put(reportKey(buildId, file), data, type);
    }
    const report = checked.report;
    const qa = qaOf(report);
    const project = projectOf(source);
    const title = project?.title ?? null;
    if (!report.ok || !checked.dist || !project) {
      await set({ status: 'failed', step: null, qa, title, finishedAt: new Date() });
      return;
    }
    const published = await publishCreation(db, storage, {
      ...(build.creationId ? { creationId: build.creationId } : {}),
      groupId: build.groupId,
      spaceId: build.spaceId,
      objectKey: build.objectKey,
      title: project.title,
      ...(project.description !== undefined ? { description: project.description } : {}),
      defaultMode: project.sessionMode,
      files: checked.dist,
      sdkVersion: await sdkVersion(),
      protocolVersion: PROTOCOL_VERSION,
      createdBy: build.requestedBy,
      status: build.publish ? 'published' : 'candidate',
      qa,
      buildId,
      sourceHash: build.sourceHash,
      saveVersion: report.creation.saveVersion,
      credits: report.credits,
      ...(project.connectors?.length ? { connectors: project.connectors } : {}),
      ...(build.approveConnectors ? { approveConnectors: { by: build.requestedBy } } : {}),
    });
    // Built from a repository: the version remembers the commit, and the creation follows it.
    if (build.source)
      await recordSourceBuild(
        db,
        { groupId: build.groupId, requestedBy: build.requestedBy, source: build.source },
        published,
      );
    // The live version of the space remembers where its creations are.
    await recordPlacements(db, build.spaceId);
    await set({
      // A version using connectors waits as a candidate until an Architect approves them.
      status: published.live ? 'published' : 'passed',
      step: null,
      // What it said is shown only while it's built, and when it didn't pass.
      log: null,
      qa,
      title,
      creationId: published.creationId,
      versionId: published.versionId,
      finishedAt: new Date(),
    });
  } catch (err) {
    await log.stop();
    await set({
      status: 'error',
      step: null,
      error: (err as Error).message.slice(0, 1000),
      finishedAt: new Date(),
    });
  }
}

interface Checked {
  report: Report;
  /** report.json, report.html and screenshots. */
  reportFiles: Map<string, Uint8Array>;
  /** The built creation (when it passed). */
  dist: Map<string, Uint8Array> | null;
}

/** ats.json from the source (null if it's missing or not valid: the report says why). */
function projectOf(source: Map<string, Uint8Array>) {
  try {
    return AtsJson.parse(JSON.parse(new TextDecoder().decode(source.get('ats.json'))));
  } catch {
    return null;
  }
}

const REPORT_FILE = /^[\w.-]+\.(json|html|png)$/;

/**
 * The checks, each step in its own short-lived container started by the supervisor: installing
 * dependencies through the egress proxy, then building and playing with no network at all.
 * The server only receives the report and the built files.
 */
export async function checkInContainers(
  sup: Supervisor,
  buildId: string,
  source: Map<string, Uint8Array>,
  step: (words: string) => Promise<unknown>,
  line: (text: string) => void = () => {},
): Promise<Checked> {
  // What the checks say: lines for the log, and the step they've reached (one update at a time,
  // so a quick run of steps can't land out of order).
  let stepping: Promise<unknown> = Promise.resolve();
  const moveTo = (words: string) => {
    stepping = stepping.then(() => step(words)).catch(() => {});
    return stepping;
  };
  const hear = (said: string[]) => {
    let reached: string | undefined;
    for (const text of said) {
      const p = readProgress(text);
      if (p && 'log' in p) line(p.log);
      else if (p && Object.hasOwn(STEP_WORDS, p.step))
        reached = STEP_WORDS[p.step as keyof typeof STEP_WORDS];
    }
    if (reached) void moveTo(reached);
  };
  try {
    await moveTo(STEP_WORDS.source);
    const init = await sup.call<{ ok: boolean; error?: string }>(
      'job.init',
      { ws: buildId },
      { tar: packTar(source).toString('base64') },
    );
    if (!init.ok) throw new Error(`The source couldn't be prepared: ${init.error}`);
    await moveTo(STEP_WORDS.dependencies);
    const prepared = await runStep(sup, buildId, 'prepare', hear);
    if (prepared.result.prepared) {
      await moveTo(`${STEP_WORDS.build}, then ${STEP_WORDS.play.toLowerCase()}`);
      const finished = await runStep(sup, buildId, 'finish', hear);
      if (finished.code !== 0 && finished.code !== 1)
        throw new Error(`The checks stopped: ${finished.error.slice(-500)}`);
    } else if (prepared.code !== 0 && prepared.code !== 1) {
      throw new Error(`The checks stopped: ${prepared.error.slice(-500)}`);
    }
    await moveTo(STEP_WORDS.report);
    const tar = await sup.raw('job.files', { ws: buildId });
    if (!tar) throw new Error('The checks left no report');
    const files = unpackTar(tar);
    const reportJson = files.get('out/report.json');
    if (!reportJson) throw new Error('The checks left no report');
    const report = JSON.parse(reportJson.toString('utf8')) as Report;
    const reportFiles = new Map<string, Uint8Array>();
    const dist = new Map<string, Uint8Array>();
    for (const [path, data] of files) {
      if (path.startsWith('out/') && REPORT_FILE.test(path.slice(4)))
        reportFiles.set(path.slice(4), data);
      else if (path.startsWith('dist/') && path.length > 5) dist.set(path.slice(5), data);
    }
    return { report, reportFiles, dist: report.ok && dist.size ? dist : null };
  } finally {
    await sup.call('job.delete', { ws: buildId }).catch(() => {});
  }
}

/** Lines a step said, each with the time it said it (see the supervisor's jobs.ts). */
type Said = [at: string, text: string][];

interface StepEnded {
  done: boolean;
  code: number;
  result: { prepared?: boolean };
  error: string;
  /** What it said that hadn't been heard yet. */
  said?: Said;
}

/**
 * One step of the checks in its own container: started, then waited on in calls the supervisor
 * holds for under a minute each (a step may take a quarter of an hour; one request can't).
 * Meanwhile, every two seconds, what it has said about what it's doing goes to `hear`.
 */
async function runStep(
  sup: Supervisor,
  buildId: string,
  step: 'prepare' | 'finish',
  hear: (said: string[]) => void,
) {
  await sup.call('job.run', { ws: buildId }, { step });
  let after: string | undefined;
  const take = (said: Said = []) => {
    const fresh = said.filter(([at]) => !after || at > after);
    if (!fresh.length) return;
    after = fresh.at(-1)?.[0];
    hear(fresh.map(([, text]) => text));
  };
  let waiting = true;
  let wake = () => {};
  const listening = (async () => {
    while (waiting) {
      await new Promise<void>((r) => {
        wake = r;
        setTimeout(r, 2000);
      });
      if (!waiting) break;
      const heard = await sup
        .call<{ said?: Said }>('job.said', { ws: buildId }, { step, ...(after ? { after } : {}) })
        .catch(() => null);
      take(heard?.said);
    }
  })();
  let ended: StepEnded;
  try {
    do
      ended = await sup.call<StepEnded>(
        'job.wait',
        { ws: buildId },
        { step, ...(after ? { after } : {}) },
      );
    while (!ended.done);
  } finally {
    waiting = false;
    wake();
    await listening;
  }
  take(ended.said);
  return ended;
}

/**
 * The checks run as child processes of this server: development only (production always has the
 * supervisor). The browser half of the checks (Playwright, Vite) is a development dependency, so
 * it's loaded here and never in a production server.
 */
async function checkHere(
  source: Map<string, Uint8Array>,
  opts: { workRoot?: string; storeDir?: string; playSeconds?: number },
  step: (words: string) => Promise<unknown>,
  line: (text: string) => void,
): Promise<Checked> {
  const root = opts.workRoot ?? join(tmpdir(), 'ats-builds');
  await mkdir(root, { recursive: true });
  const work = await mkdtemp(join(root, 'build-'));
  try {
    const projectDir = join(work, 'project');
    const distDir = join(work, 'dist');
    const outDir = join(work, 'report');
    for (const [path, data] of source) {
      await mkdir(dirname(join(projectDir, path)), { recursive: true });
      await writeFile(join(projectDir, path), data);
    }
    const { checkProject } = await import('@ats/qa-browser').catch(() => {
      throw new Error('Creations can only be checked here in development (no supervisor found)');
    });
    const result = await checkProject({
      projectDir,
      distDir,
      outDir,
      storeDir: opts.storeDir ?? join(tmpdir(), 'ats-pnpm-store'),
      // (Drizzle queries only run once awaited or then-ed.)
      onStep: (s) => {
        step(STEP_WORDS[s]).then(
          () => {},
          () => {},
        );
      },
      onLine: line,
      ...(opts.playSeconds !== undefined ? { playSeconds: opts.playSeconds } : {}),
    });
    const reportFiles = new Map<string, Uint8Array>();
    for (const file of await readdir(outDir))
      if (REPORT_FILE.test(file)) reportFiles.set(file, await readFile(join(outDir, file)));
    let dist: Map<string, Uint8Array> | null = null;
    if (result.ok && result.files) {
      dist = new Map();
      for (const f of result.files) dist.set(f.path, await readFile(join(distDir, f.path)));
    }
    return { report: result.report, reportFiles, dist };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * How long the queue waits on a running build's worker before taking the build back (the worker
 * renews its hold while it's alive).
 */
const BUILD_LOCK_MS = 15 * 60_000;

/** Builds run one at a time, in the background, and survive the server restarting. */
export function startBuildWorker(
  db: Db,
  storage: () => Promise<Storage>,
  valkeyUrl: string,
  supervisor?: Supervisor,
  notifier?: Notifier,
  log: Log = silent,
) {
  const connection = { url: valkeyUrl };
  const worker = new Worker(
    BUILD_QUEUE,
    async (job) =>
      runBuild(db, await storage(), (job.data as { buildId: string }).buildId, {
        ...(supervisor ? { supervisor } : {}),
        ...(notifier ? { notifier } : {}),
        log,
      }),
    { connection, concurrency: 1, lockDuration: BUILD_LOCK_MS },
  );
  worker.on('failed', (job, err) =>
    log.error({ buildId: job?.data?.buildId, err: err.message }, 'build failed'),
  );
  return worker;
}

export function buildQueue(valkeyUrl: string) {
  return new Queue(BUILD_QUEUE, { connection: { url: valkeyUrl } });
}

/** A build that was running when the server stopped is picked up again by the queue; one that
 * never got queued can't be, so it's marked as interrupted. */
export async function failStuckBuilds(db: Db, queue: Queue) {
  const open = await db
    .select()
    .from(builds)
    .where(inArray(builds.status, ['queued', 'running']));
  for (const b of open) {
    const job = await queue.getJob(b.id);
    if (!job)
      await db
        .update(builds)
        .set({
          status: 'error',
          error: 'Interrupted: the server restarted before it ran.',
          finishedAt: new Date(),
        })
        .where(and(eq(builds.id, b.id), inArray(builds.status, ['queued', 'running'])));
  }
}
