/**
 * Repository hosts a server's owner allows creations to come from (ADR 0011, ADR 0012,
 * docs/repositories.md): one definition file each in ATS_SOURCES_DIR, and the built-in GitHub
 * host the owner can switch on in the Studio. Everything here is plain checking: no network, no
 * secrets (a token is named by the environment variable that holds it).
 */
import { z } from 'zod';

export const SOURCE_HOST_ID = /^[a-z0-9-]{2,32}$/;

/**
 * The built-in GitHub host's id: github.com, public repositories only, never a token. It's off
 * until the server's owner switches it on in the Studio; a definition file can't use this id.
 */
export const BUILT_IN_GITHUB = 'github-public';

/**
 * `owner/name`, as GitHub spells them. Neither part may be only dots: `x/..` would climb out of
 * the repository's own address on the host's API.
 */
export const REPOSITORY = /^(?!\.+\/)[A-Za-z0-9_.-]{1,100}\/(?!\.+$)[A-Za-z0-9_.-]{1,100}$/;

/** A folder in a repository: plain names separated by `/`, no `.` or `..`, no leading `/`. */
export const REPO_PATH =
  /^(?:[A-Za-z0-9_@+-][A-Za-z0-9_.@+-]{0,99})(?:\/[A-Za-z0-9_@+-][A-Za-z0-9_.@+-]{0,99}){0,15}$/;

/**
 * A branch or tag name (refs/heads/… or refs/tags/… without the prefix). As git has them: no
 * `..`, no part starting with a dot, no empty part.
 */
export const GIT_REF =
  /^(?!.*\.\.)(?!\/)(?!.*\/$)(?!.*\/\/)(?!\.)(?!.*\/\.)[A-Za-z0-9._/-]{1,200}$/;

/** A commit, written in full. */
export const COMMIT = /^[0-9a-f]{40}$/;

/**
 * Which repositories are allowed: `owner/name`, `owner/*` (every one of an owner's), or `*`
 * (any public repository on the host).
 */
export const SOURCE_PATTERN =
  /^(?:\*|(?!\.+\/)[A-Za-z0-9_.-]{1,100}\/(?:\*|(?!\.+$)[A-Za-z0-9_.-]{1,100}))$/;

export const SourcePattern = z
  .string()
  .trim()
  .regex(SOURCE_PATTERN, 'owner/name, owner/* or * (any public repository)');

/** At most 100 patterns, without repeats (compared without case, as GitHub's names are). */
export const SourcePatterns = z
  .array(SourcePattern)
  .max(100)
  .transform((list) => uniquePatterns(list));

/** The patterns once each, in the order given (compared without case). */
export function uniquePatterns(list: readonly string[]): string[] {
  const seen = new Set<string>();
  return list.filter((p) => {
    const key = p.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export const SourceHostDefinition = z.strictObject({
  id: z.string().regex(SOURCE_HOST_ID),
  /** Shown to Architects ("GitHub", "Our Gitea"). */
  displayName: z.string().trim().min(1).max(60),
  /** Only GitHub (github.com, or GitHub Enterprise with its own apiUrl) for now. */
  kind: z.literal('github'),
  /** The host's API. Default: GitHub's. */
  apiUrl: z.url({ protocol: /^https$/ }).default('https://api.github.com'),
  /**
   * Where archives may be fetched from: the API sends an archive's address there (a redirect).
   * Default for github.com: codeload.github.com.
   */
  archiveHosts: z
    .array(z.string().regex(/^[a-z0-9.-]{1,253}$/))
    .max(5)
    .default(['codeload.github.com']),
  /**
   * The environment variable holding a read-only token (`ATS_SOURCE_…`), for private
   * repositories. Without one, only public repositories can be read. It's only ever used for
   * the repositories this file names (`owner/name` or `owner/*`), never for `*`.
   */
  tokenEnv: z
    .string()
    .regex(/^ATS_SOURCE_[A-Z0-9_]{1,60}$/)
    .optional(),
  /**
   * Which repositories creations may come from: `owner/name`, every one of an owner's
   * (`owner/*`), or any public one (`*`). May be empty when the list is kept in the Studio.
   */
  repositories: z
    .array(z.string().regex(SOURCE_PATTERN, 'owner/name, owner/* or *'))
    .max(100)
    .default([]),
  /**
   * Allow the host (and its archive address) on a private network: a company's own GitHub
   * Enterprise, say. Off by default: only public addresses are reached.
   */
  allowPrivateAddress: z.boolean().default(false),
  /** The largest archive fetched, in megabytes (default 150). */
  maxArchiveMb: z.number().int().min(1).max(300).default(150),
});
export type SourceHostDefinition = z.infer<typeof SourceHostDefinition>;

export class SourceHostDefinitionError extends Error {}

/** Reads a definition, or throws a SourceHostDefinitionError saying what's wrong. */
export function parseSourceHostDefinition(input: unknown): SourceHostDefinition {
  const parsed = SourceHostDefinition.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new SourceHostDefinitionError(
      `${issue?.path.join('.') || 'the file'}: ${issue?.message ?? 'not valid'}`,
    );
  }
  return parsed.data;
}

/**
 * How a list of patterns takes in a repository: by its owner or name (`named`), only through
 * `*` (`any`), or not at all (null). Names compare without case, as GitHub's do.
 */
export function matchRepository(
  patterns: readonly string[],
  repository: string,
): 'named' | 'any' | null {
  if (!REPOSITORY.test(repository)) return null;
  const [owner, name] = repository.toLowerCase().split('/') as [string, string];
  let any = false;
  for (const p of patterns) {
    if (p === '*') {
      any = true;
      continue;
    }
    const [o, n] = p.toLowerCase().split('/') as [string, string];
    if (o === owner && (n === '*' || n === name)) return 'named';
  }
  return any ? 'any' : null;
}

/**
 * How the server may read a repository from a host, if at all:
 *
 * - `token`: with the host's token, so it may be private. Only when the host has a token and its
 *   definition file names the repository (`owner/name` or `owner/*`).
 * - `public`: without any token, and only while the host says it's public. Everything else the
 *   owner allows: `*`, and every repository added in the Studio.
 * - null: not allowed.
 */
export function repositoryAccess(
  host: {
    /** From the definition file. */
    repositories: readonly string[];
    /** Added in the Studio: public only, whatever they name. */
    added?: readonly string[];
    /** Whether the host has a token. */
    token: boolean;
  },
  repository: string,
): 'token' | 'public' | null {
  if (!REPOSITORY.test(repository)) return null;
  const fromFile = matchRepository(host.repositories, repository);
  if (fromFile === 'named' && host.token) return 'token';
  if (fromFile || matchRepository(host.added ?? [], repository)) return 'public';
  return null;
}

/** What the server's owner chose in the Studio (stored with the install; see ADR 0012). */
export const StudioSources = z.object({
  /** The built-in GitHub host: off until the owner switches it on. */
  github: z
    .object({ on: z.boolean().default(false), repositories: SourcePatterns.default([]) })
    .default({ on: false, repositories: [] }),
  /** Repositories added to hosts defined in files, by host id: public ones only. */
  added: z.record(z.string().regex(SOURCE_HOST_ID), SourcePatterns).default({}),
});
export type StudioSources = z.infer<typeof StudioSources>;

/**
 * The owner's choices as stored, or none if what's stored isn't valid (nothing allowed is the
 * safe way to be wrong).
 */
export function studioSourcesOf(stored: unknown): StudioSources {
  const parsed = StudioSources.safeParse(stored ?? {});
  return parsed.success ? parsed.data : StudioSources.parse({});
}
