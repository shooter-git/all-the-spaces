/** Someone in the group, as its Architects see them. */
export interface Person {
  userId: string;
  name: string;
  email: string;
  /** Whether they've confirmed their email; null when the server doesn't send email. */
  emailConfirmed: boolean | null;
  role: 'architect' | 'member';
  joinedAt: string;
  lastSeenAt: string | null;
  you: boolean;
  /** Their colour, as everyone sees it on their figure in a space. */
  color: string;
}

export interface InviteLink {
  id: string;
  role: 'architect' | 'member';
  label: string | null;
  uses: number;
  maxUses: number | null;
  expiresAt: string;
  revokedAt: string | null;
}

export interface ActivityEntry {
  id: string;
  action: string;
  at: string;
  actor: { id: string; name: string } | null;
  /** The person, space or creation it was about, by name (when there still is one). */
  about: string | null;
  room: string | null;
  details: Record<string, unknown>;
}

export interface ServerInfo {
  release: string;
  address: string;
  storage: 'builtin' | 'external';
  backups: { schedule: 'nightly' | 'weekly' | 'off'; keepDays: number; offsite: boolean };
  features: { studio: boolean; voice: boolean; email: boolean };
  counts: { people: number; spaces: number; creations: number };
  /** Who runs the server (ADR 0012): set up with the setup code, or handed on with ats-admin. */
  owner: { name: string | null; you: boolean };
}

/**
 * A repository host as the server's owner sees it in the Studio: never a token, nor where one is
 * kept.
 */
export interface ServerSourceHost {
  id: string;
  displayName: string;
  /** A definition file on the server, or the built-in GitHub host. */
  from: 'file' | 'built-in';
  /** The built-in host: whether it's switched on. A file's: always (removing the file stops it). */
  on: boolean;
  /** Its API's host name (api.github.com). */
  address: string;
  /** What its definition file allows (changed only there). */
  fileRepositories: string[];
  /** Whether the file gives it a token: then what the file names may be private. */
  token: boolean;
  /** What the owner added here: public repositories only (`*` for any). */
  repositories: string[];
}

export interface ServerSources {
  hosts: ServerSourceHost[];
}

/** A change to some hosts: the built-in one switched on or off, and what's added here. */
export interface ServerSourcesChange {
  hosts: { id: string; on?: boolean; repositories: string[] }[];
}
