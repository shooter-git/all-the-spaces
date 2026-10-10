// Checks and publishes a creation's source to an object in a space from the command line (the
// Studio's Publish queues the same build):
//
//   pnpm --filter @ats/server creation:publish <project> --space <id> --object <key>
//        [--candidate] [--creation <id>] [--no-wait] [--approve-connectors]
//
// The project is snapshotted (refused if it contains secrets), built cleanly and checked on
// phones, a tablet and a laptop by the server. If it passes it goes live, or with --candidate
// it's kept for trying first. A creation already on that object gets a new version.
//
// A creation that uses connectors (its ats.json `connectors`) is kept as a candidate until
// they're approved for that version: --approve-connectors approves what it declares as you
// publish (you're the server's owner), otherwise an Architect approves them in Creations.
//
// For test fixtures that must skip the checks (they misbehave on purpose):
//   creation:publish --unchecked <built-folder> --space <id> --object <key> --title "…" [--mode solo]
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { PROTOCOL_VERSION } from '@allthespaces/bridge-protocol';
import { createDb, schema } from '@ats/db';
import { type Report, readSource, scanForSecrets, sdkVersion } from '@ats/qa';
import { loadServerEnv } from '@ats/shared';
import { and, eq } from 'drizzle-orm';
import { buildQueue, reportKey } from '../creations/builds.ts';
import { uploadSource } from '../creations/sources.ts';
import { publishCreation } from '../creations/store.ts';
import { getStorage } from '../storage.ts';

const { values, positionals } = parseArgs({
  // `pnpm run x -- args` passes the `--` along: skip it.
  args: process.argv.slice(2).filter((a, i) => !(i === 0 && a === '--')),
  allowPositionals: true,
  options: {
    space: { type: 'string' },
    object: { type: 'string' },
    creation: { type: 'string' },
    candidate: { type: 'boolean' },
    'approve-connectors': { type: 'boolean' },
    'no-wait': { type: 'boolean' },
    unchecked: { type: 'boolean' },
    title: { type: 'string' },
    mode: { type: 'string', default: 'shared' },
  },
});
const dir = positionals[0];
if (!dir || !values.space || !values.object) {
  console.error('Usage: creation:publish <project> --space <id> --object <key> [--candidate]');
  process.exit(2);
}

const env = loadServerEnv();
const db = createDb(env.DATABASE_URL);
const storage = await getStorage({ db, env });
try {
  const [space] = await db
    .select({ groupId: schema.spaces.groupId })
    .from(schema.spaces)
    .where(eq(schema.spaces.id, values.space));
  if (!space) throw new Error(`No space ${values.space}`);
  // A creation already on this object gets a new version rather than a twin.
  const [existing] = values.creation
    ? [{ id: values.creation }]
    : await db
        .select({ id: schema.creations.id })
        .from(schema.creations)
        .where(
          and(
            eq(schema.creations.spaceId, values.space),
            eq(schema.creations.objectKey, values.object),
          ),
        );

  if (values.unchecked) {
    const result = await publishCreation(db, storage, {
      ...(existing ? { creationId: existing.id } : {}),
      groupId: space.groupId,
      spaceId: values.space,
      objectKey: values.object,
      title: values.title ?? 'Untitled creation',
      defaultMode: values.mode as 'solo' | 'shared' | 'invite',
      files: await filesIn(resolve(dir)),
      sdkVersion: await sdkVersion(),
      protocolVersion: PROTOCOL_VERSION,
    });
    console.log(
      `Published "${values.title}" version ${result.number}, unchecked (${result.creationId})`,
    );
  } else {
    const { snapshot, contents } = await readSource(resolve(dir));
    const secrets = scanForSecrets(contents);
    if (secrets.length) {
      console.error('Not uploaded: the project contains things that look like secrets.');
      for (const s of secrets) console.error(`  ${s.path}${s.line ? `:${s.line}` : ''}  ${s.kind}`);
      process.exitCode = 1;
    } else {
      await uploadSource(storage, space.groupId, snapshot, contents);
      const [build] = await db
        .insert(schema.builds)
        .values({
          groupId: space.groupId,
          spaceId: values.space,
          creationId: existing?.id ?? null,
          objectKey: values.object,
          publish: !values.candidate,
          approveConnectors: values['approve-connectors'] ?? false,
          sourceHash: snapshot.hash,
        })
        .returning();
      const queue = buildQueue(env.VALKEY_URL);
      await queue.add(
        'build',
        { buildId: build?.id },
        {
          ...(build ? { jobId: build.id } : {}),
          removeOnComplete: 200,
          removeOnFail: 200,
        },
      );
      await queue.close();
      console.log(`Queued build ${build?.id} (${snapshot.files.length} files)`);
      if (!values['no-wait'] && build) process.exitCode = await follow(build.id);
    }
  }
} finally {
  await db.close();
}

async function follow(id: string): Promise<number> {
  let last = '';
  for (;;) {
    const [b] = await db.select().from(schema.builds).where(eq(schema.builds.id, id));
    if (!b) return 1;
    const line = b.step ?? b.status;
    if (line !== last) console.log(`… ${line}`);
    last = line;
    if (!['queued', 'running'].includes(b.status)) {
      try {
        const report = JSON.parse(
          new TextDecoder().decode(await storage.getBytes(reportKey(id, 'report.json'))),
        ) as Report;
        for (const c of report.checks.filter((c) => c.status !== 'pass'))
          console.log(
            `${c.status === 'fail' ? 'FAIL' : 'note'}  ${c.title}${c.where ? ` (${c.where})` : ''}${c.detail ? `\n      ${c.detail}` : ''}${c.fix ? `\n      → ${c.fix}` : ''}`,
          );
      } catch {}
      const words = {
        published: 'Passed and published.',
        passed: b.publish
          ? 'Passed: kept as a candidate until its connectors are approved (Creations, or --approve-connectors).'
          : 'Passed: kept as a candidate to try before publishing.',
        failed: "Didn't pass.",
        error: `Something went wrong: ${b.error}`,
      } as Record<string, string>;
      console.log(
        `${words[b.status] ?? b.status} Report: ${env.ATS_PUBLIC_URL}/api/builds/${id}/report/report.html`,
      );
      return ['published', 'passed'].includes(b.status) ? 0 : 1;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function filesIn(root: string) {
  const out = new Map<string, Uint8Array>();
  const walk = async (d: string) => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) await walk(p);
      else out.set(relative(root, p).split('\\').join('/'), new Uint8Array(await readFile(p)));
    }
  };
  await walk(root);
  return out;
}
