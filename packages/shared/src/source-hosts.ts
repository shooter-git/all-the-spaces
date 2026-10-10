/**
 * Repository hosts a server's owner allows creations to come from (ADR 0011, docs/repositories.md):
 * one definition file each in ATS_SOURCES_DIR. Everything here is plain checking: no network, no
 * secrets (a token is named by the environment variable that holds it).
 */
import { z } from 'zod';

export const SOURCE_HOST_ID = /^[a-z0-9-]{2,32}$/;

/** `owner/name`, as GitHub spells them. */
export const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

/** A folder in a repository: plain names separated by `/`, no `.` or `..`, no leading `/`. */
export const REPO_PATH =
  /^(?:[A-Za-z0-9_@+-][A-Za-z0-9_.@+-]{0,99})(?:\/[A-Za-z0-9_@+-][A-Za-z0-9_.@+-]{0,99}){0,15}$/;

/** A branch or tag name (refs/heads/… or refs/tags/… without the prefix). */
export const GIT_REF = /^(?!.*\.\.)(?!\/)(?!.*\/$)[A-Za-z0-9._/-]{1,200}$/;

/** A commit, written in full. */
export const COMMIT = /^[0-9a-f]{40}$/;

const pattern = z
  .string()
  .regex(/^[A-Za-z0-9_.-]{1,100}\/(?:\*|[A-Za-z0-9_.-]{1,100})$/, 'an owner/name, or owner/*');

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
   * repositories. Without one, only public repositories can be read.
   */
  tokenEnv: z
    .string()
    .regex(/^ATS_SOURCE_[A-Z0-9_]{1,60}$/)
    .optional(),
  /** Which repositories creations may come from: `owner/name`, or every one of an owner's. */
  repositories: z.array(pattern).min(1).max(100),
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

/** Whether a host's definition allows a repository (names compare without case, as GitHub's do). */
export function allowsRepository(
  def: Pick<SourceHostDefinition, 'repositories'>,
  repository: string,
) {
  if (!REPOSITORY.test(repository)) return false;
  const [owner, name] = repository.toLowerCase().split('/') as [string, string];
  return def.repositories.some((p) => {
    const [o, n] = p.toLowerCase().split('/') as [string, string];
    return o === owner && (n === '*' || n === name);
  });
}
