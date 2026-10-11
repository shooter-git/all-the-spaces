import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Db, schema } from '@ats/db';
import type { Storage } from '@ats/storage';
import { eq } from 'drizzle-orm';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));

async function tree(
  dir: string,
  into: Map<string, Uint8Array>,
  prefix: string,
  skip: (path: string) => boolean,
) {
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      const rel = relative(dir, full).split(sep).join('/');
      if (skip(rel)) continue;
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) into.set(`${prefix}${rel}`, await readFile(full));
    }
  };
  await walk(dir);
}

const SKIP = /(^|\/)(node_modules|dist|qa-output|\.turbo)(\/|$)/;

/** What a member asked for, as it goes into the workspace (their words and pictures). */
export interface WorkspaceRequest {
  kind: 'new' | 'improve' | 'bug';
  by: string;
  words: string;
  /** name → JPEG (snapshot, sketch, image-N). */
  images: Map<string, Uint8Array>;
  /** name (doc-N) → the Markdown they attached, and its file's own name. */
  documents: Map<string, { file: string; bytes: Uint8Array }>;
}

const PICTURES: Record<string, string> = {
  snapshot: 'what they drew a box around in the space',
  sketch: 'a sketch they drew',
};

export async function requestForWorkspace(
  db: Db,
  storage: Storage,
  c: typeof schema.commissions.$inferSelect,
): Promise<WorkspaceRequest> {
  const [who] = c.requesterId
    ? await db
        .select({ name: schema.user.name })
        .from(schema.user)
        .where(eq(schema.user.id, c.requesterId))
    : [];
  const images = new Map<string, Uint8Array>();
  for (const name of c.images) {
    const bytes = await storage.getBytes(`requests/${c.id}/${name}.jpg`).catch(() => null);
    if (bytes) images.set(name, bytes);
  }
  const documents = new Map<string, { file: string; bytes: Uint8Array }>();
  for (const { name, file } of c.documents) {
    const bytes = await storage.getBytes(`requests/${c.id}/${name}.md`).catch(() => null);
    if (bytes) documents.set(name, { file, bytes });
  }
  return {
    kind: c.kind,
    by: who?.name ?? 'Someone in the group',
    words: c.prompt,
    images,
    documents,
  };
}

/** The part of BRIEF.md that says who asked, in their own words, with their pictures. */
function requestSection(r: WorkspaceRequest) {
  const asked =
    r.kind === 'bug'
      ? `${r.by} reported a problem`
      : r.kind === 'improve'
        ? `${r.by} asked for a change`
        : `${r.by} asked for this`;
  const quote = r.words
    .trim()
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');
  const documents = [...r.documents].map(
    ([n, { file }]) => `- \`request/${n}.md\`: a document they wrote for it (${file})`,
  );
  const pictures = [...r.images.keys()].map(
    (n) => `- \`request/${n}.jpg\`: ${PICTURES[n] ?? 'a picture they added'}`,
  );
  return `\n## ${asked}, in their own words\n\n${quote}\n${
    documents.length
      ? `\nRead the whole of what they attached: it's part of what they asked for.\n\n${documents.join('\n')}\n`
      : ''
  }${
    pictures.length ? `\nLook at the pictures that came with it:\n\n${pictures.join('\n')}\n` : ''
  }`;
}

/** Adds a request's pictures (under request/) and its section of the brief. */
function addRequest(files: Map<string, Uint8Array>, r: WorkspaceRequest | undefined) {
  if (!r) return;
  for (const [name, bytes] of r.images) files.set(`request/${name}.jpg`, bytes);
  for (const [name, { bytes }] of r.documents) files.set(`request/${name}.md`, bytes);
  const brief = new TextDecoder().decode(files.get('BRIEF.md'));
  // Before the original brief, when improving a creation.
  const at = brief.indexOf('\n---\n\n## The original brief');
  const [top, rest] = at < 0 ? [brief, ''] : [brief.slice(0, at), brief.slice(at)];
  files.set('BRIEF.md', new TextEncoder().encode(`${top.trimEnd()}\n${requestSection(r)}${rest}`));
}

/**
 * The platform's part of CLAUDE.md and AGENTS.md sits between these markers, so it can be kept up
 * to date (each time a workspace wakes) without touching notes the assistant or the Architect
 * add outside it.
 */
export const INSTRUCTIONS_START =
  '<!-- All the Spaces: kept up to date by the platform, down to the end marker. Add notes of your own below it. -->';
export const INSTRUCTIONS_END = '<!-- All the Spaces: end of the platform’s instructions. -->';

/** The instructions an assistant reads, for a creation or a real place, between the markers. */
export async function instructionsFor(
  kind: 'creation' | 'space',
  title: string,
  where = 'not placed yet',
): Promise<string> {
  const body = new TextDecoder()
    .decode(
      await readFile(
        join(repo, `agent-instructions/${kind === 'space' ? 'SPACE' : 'CREATION'}.md`),
      ),
    )
    .replaceAll('{{TITLE}}', title)
    .replaceAll('{{WHERE}}', where)
    .trimEnd();
  return `${INSTRUCTIONS_START}\n${body}\n${INSTRUCTIONS_END}\n`;
}

/**
 * Brings an instructions file up to date. The platform's part is replaced; anything outside it
 * stays. A file from before the markers is replaced whole, and handed back to be kept aside (it
 * may hold notes). Null when nothing changes.
 */
export function refreshInstructions(
  existing: string | null,
  fresh: string,
): { text: string; previous: string | null } | null {
  if (existing === null || !existing.trim()) return { text: fresh, previous: null };
  const a = existing.indexOf(INSTRUCTIONS_START);
  const b = existing.indexOf(INSTRUCTIONS_END);
  if (a >= 0 && b > a) {
    const after = existing.slice(b + INSTRUCTIONS_END.length).replace(/^\n/, '');
    const text = `${existing.slice(0, a)}${fresh}${after}`;
    return text === existing ? null : { text, previous: null };
  }
  return { text: fresh, previous: existing };
}

/** What an instructions file says it's for (its title, and where a creation lives). */
export function instructionsVars(existing: string | null) {
  const body = existing?.replace(INSTRUCTIONS_START, '') ?? '';
  return {
    title: /^\s*# (.+)$/m.exec(body)?.[1]?.trim() ?? null,
    where: /model of their real place \((.+?)\), with the people/s.exec(body)?.[1] ?? undefined,
  };
}

/**
 * A new creation's workspace: the blank starter, the SDK (vendored, with its README for the
 * assistant), the brief, and the instructions each assistant reads (CLAUDE.md, AGENTS.md).
 */
export async function newWorkspaceFiles(input: {
  title: string;
  brief: string;
  where: string;
  telemetry: boolean;
  request?: WorkspaceRequest;
}): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  const text = (s: string) => new TextEncoder().encode(s);
  await tree(
    join(repo, 'starters/creation'),
    files,
    '',
    (p) => SKIP.test(p) || p === 'README.md' || p === 'LICENSE',
  );
  for (const [name, dir] of [
    ['allthespaces-portal', 'packages/portal-sdk'],
    ['allthespaces-bridge-protocol', 'packages/bridge-protocol'],
  ] as const) {
    await tree(
      join(repo, dir),
      files,
      `vendor/${name}/`,
      (p) => SKIP.test(p) || p === 'tsconfig.json' || p.startsWith('test'),
    );
    const pkgPath = `vendor/${name}/package.json`;
    const pkg = JSON.parse(new TextDecoder().decode(files.get(pkgPath)));
    delete pkg.devDependencies;
    delete pkg.scripts;
    if (pkg.dependencies?.['@allthespaces/bridge-protocol'])
      pkg.dependencies['@allthespaces/bridge-protocol'] = 'file:../allthespaces-bridge-protocol';
    files.set(pkgPath, text(`${JSON.stringify(pkg, null, 2)}\n`));
  }

  const pkg = JSON.parse(new TextDecoder().decode(files.get('package.json')));
  files.set(
    'package.json',
    text(
      `${JSON.stringify(
        {
          name: 'creation',
          private: true,
          type: 'module',
          scripts: { dev: 'vite', build: 'vite build', typecheck: 'tsc -p .' },
          dependencies: {
            '@allthespaces/portal': 'file:./vendor/allthespaces-portal',
            '@allthespaces/bridge-protocol': 'file:./vendor/allthespaces-bridge-protocol',
          },
          devDependencies: pkg.devDependencies,
        },
        null,
        2,
      )}\n`,
    ),
  );
  files.set(
    'ats.json',
    text(
      `${JSON.stringify({ title: input.title, sessionMode: 'shared', budgetTier: 'low' }, null, 2)}\n`,
    ),
  );
  files.set(
    'BRIEF.md',
    text(
      `# ${input.title}\n\nIt lives on: ${input.where}\n\n## What's wanted\n\n${input.brief.trim()}\n`,
    ),
  );
  const instructions = await instructionsFor('creation', input.title, input.where);
  files.set('CLAUDE.md', text(instructions));
  files.set('AGENTS.md', text(instructions));
  // Claude Code's own workspace settings: what it may run without asking. (The model and effort
  // are given when it's started.) Nothing is written to the Architect's own configuration.
  files.set(
    '.claude/settings.json',
    text(
      `${JSON.stringify(
        {
          permissions: {
            allow: [
              'Bash(pnpm:*)',
              'Bash(ats:*)',
              'Bash(git:*)',
              'Bash(node:*)',
              'Bash(ls:*)',
              'Bash(cat:*)',
            ],
          },
          env: {
            DISABLE_AUTOUPDATER: '1',
            ...(input.telemetry ? {} : { DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1' }),
          },
        },
        null,
        2,
      )}\n`,
    ),
  );
  files.set('.gitignore', text('node_modules/\ndist/\nqa-output/\nuploads/\n'));
  addRequest(files, input.request);
  return files;
}

/**
 * Improving a creation: its published source, with the current SDK, instructions and settings,
 * and a brief that says what to change.
 */
export async function refreshedWorkspaceFiles(
  source: Map<string, Uint8Array>,
  input: {
    title: string;
    brief: string;
    where: string;
    telemetry: boolean;
    request?: WorkspaceRequest;
  },
) {
  const { request, ...rest } = input;
  const fresh = await newWorkspaceFiles(rest);
  const files = new Map(source);
  for (const [path, data] of fresh) {
    const shared =
      path.startsWith('vendor/') ||
      ['CLAUDE.md', 'AGENTS.md', '.claude/settings.json', '.gitignore'].includes(path);
    if (shared || !files.has(path)) files.set(path, data);
  }
  // Pictures from an earlier request aren't part of this one.
  for (const path of [...files.keys()]) if (path.startsWith('request/')) files.delete(path);
  const previous = source.get('BRIEF.md');
  files.set(
    'BRIEF.md',
    new TextEncoder().encode(
      `# ${input.title}: what to change\n\nIt lives on: ${input.where}\n\n${input.brief.trim()}\n\nKeep everything that works, and keep people's saved data working (see "Changing it later" in CLAUDE.md).\n${previous ? `\n---\n\n## The original brief\n\n${new TextDecoder().decode(previous).replace(/^# .*\n/, '')}` : ''}`,
    ),
  );
  addRequest(files, request);
  return files;
}

/**
 * A space workspace: the Architect's floor plans and photos, a brief, the instructions for
 * building a real place, and an empty plan to fill in.
 */
export async function spaceWorkspaceFiles(input: {
  name: string;
  spaceType: string;
  description: string;
  inputs: (
    | { name: string; kind: 'plan' | 'photo'; note: string; data: Uint8Array }
    | { name: string; kind: 'pack'; note: string; files: Map<string, Uint8Array> }
  )[];
  telemetry: boolean;
  /** Changing a place that's live: the plan it was built from (to start from). */
  current?: { plan: unknown | null; version: number };
}): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  const text = (s: string) => new TextEncoder().encode(s);
  for (const i of input.inputs)
    if (i.kind === 'pack')
      for (const [path, data] of i.files) files.set(`inputs/${i.note}/${path}`, data);
    else files.set(`inputs/${i.name}.jpg`, i.data);
  const listing = input.inputs
    .map((i) =>
      i.kind === 'pack'
        ? `- \`inputs/${i.note}/\` — ${i.files.size} files the Architect gave together (photos and notes on them): read its README or manifest first`
        : `- \`inputs/${i.name}.jpg\` — ${i.kind === 'plan' ? 'floor plan' : 'photo'}${i.note ? `: ${i.note}` : ''}`,
    )
    .join('\n');
  const words = input.description.trim() || '(No description.)';
  files.set(
    'BRIEF.md',
    text(
      input.current
        ? `# Changing ${input.name}\n\nA ${input.spaceType}. Version ${input.current.version} is live; \`plan.json\` is the plan it was built from. Change only what's asked, and keep every room's and object's \`key\` as it is: creations live on objects by their keys (see "Changing a place that's live" in CLAUDE.md).\n\n## What to change, in the Architect's words\n\n${words}\n${listing ? `\n## What you have\n\n${listing}\n` : ''}`
        : `# ${input.name}\n\nA ${input.spaceType}.\n\n## In the Architect's words\n\n${words}\n\n## What you have\n\n${listing}\n`,
    ),
  );
  files.set(
    'plan.json',
    text(
      `${JSON.stringify(
        input.current?.plan ?? {
          name: input.name,
          spaceType: input.spaceType,
          floors: [{ key: 'f1', name: input.name, elevation: 0, height: 2.6 }],
          rooms: [],
          openings: [],
          furniture: [],
          spawns: [],
        },
        null,
        2,
      )}\n`,
    ),
  );
  const instructions = await instructionsFor('space', input.name);
  files.set('CLAUDE.md', text(instructions));
  files.set('AGENTS.md', text(instructions));
  files.set(
    '.claude/settings.json',
    text(
      `${JSON.stringify(
        {
          permissions: { allow: ['Bash(ats:*)', 'Bash(git:*)', 'Bash(ls:*)', 'Bash(cat:*)'] },
          env: {
            DISABLE_AUTOUPDATER: '1',
            ...(input.telemetry ? {} : { DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1' }),
          },
        },
        null,
        2,
      )}\n`,
    ),
  );
  // The plans and photos are private: never in the workspace's history (its checkpoints).
  files.set('.gitignore', text('preview/\nuploads/\ninputs/\n'));
  return files;
}
