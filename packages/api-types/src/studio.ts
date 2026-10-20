import type { SessionMode } from './creations.ts';
import type { Tier } from './perf.ts';

/** The checks a version passed: a short summary (the full report is kept with its build). */
export interface VersionQa {
  ok: boolean;
  failed: number;
  warned: number;
  thumbnail: string | null;
  summary: Record<string, number> | null;
  /** Never checked on this server: imported from another one (`ok` is false, nothing failed). */
  unchecked?: 'imported';
}

/** Results from "Try on this device". */
export interface DeviceTest {
  at: string;
  by: string | null;
  /** e.g. "Phone · Android · Chrome". */
  device: string;
  width: number;
  height: number;
  seconds: number;
  fps: number;
  p50Ms: number;
  p95Ms: number;
  worstMs: number;
}

/** A connector a creation says it uses (its ats.json `connectors`). */
export interface DeclaredConnector {
  /** The connector's id on the server (`ATS_CONNECTORS_DIR/<id>.json`). */
  id: string;
  /** The operations it calls. */
  ops: string[];
  /** Why, in a sentence the Architect reads before approving. */
  why: string;
}

/** A declared connector as an Architect reviews it for a version. */
export interface StudioVersionConnector extends DeclaredConnector {
  /** Its name on this server; null when this server doesn't have it installed. */
  displayName: string | null;
  /** Each declared operation as this server defines it (null: not defined here). */
  operations: {
    name: string;
    kind: 'read' | 'write' | null;
    scope: string | null;
    method: string | null;
  }[];
  /** The operations an Architect has approved for this version. */
  approvedOps: string[];
  approvedAt: string | null;
}

export interface StudioVersion {
  id: string;
  number: number;
  status: 'candidate' | 'published';
  live: boolean;
  createdAt: string;
  publishedAt: string | null;
  bytes: number;
  qa: VersionQa | null;
  buildId: string | null;
  saveVersion: number | null;
  deviceTests: DeviceTest[];
  title: string;
  /** The connectors it uses, and whether they're approved (empty: none). */
  connectors: StudioVersionConnector[];
  /** The repository commit it was built from (creations that follow one). */
  sourceCommit: string | null;
}

/** Where a creation's source comes from, when it follows a repository (ADR 0011). */
export interface SourceSettings {
  host: string;
  /** `owner/name`. */
  repository: string;
  /** Its folder in the repository ('' for the whole repository). */
  path: string;
  follows: 'release' | 'branch' | 'commit';
  /** The branch, or the commit (null for releases). */
  ref: string | null;
  /** New versions become candidates to try first, or go live straight away. */
  updateMode: 'candidate' | 'live';
}

export interface CreationSource extends SourceSettings {
  /** The host's name on this server (null: it isn't installed any more). */
  hostName: string | null;
  /** The commit the newest version came from. */
  builtCommit: string | null;
  /** What it follows was at this commit when last looked at. */
  latestCommit: string | null;
  /** The release's tag, or the commit's first line. */
  latestLabel: string | null;
  /** Commits between the built one and the latest (null: unknown). */
  behindBy: number | null;
  checkedAt: string | null;
  /** Why the last look failed, if it did. */
  checkError: string | null;
}

/** A repository host the server's owner allows (GET /api/sources). */
export interface SourceHostInfo {
  id: string;
  displayName: string;
  /** `owner/name`, `owner/*`, or `*` (any public repository). */
  repositories: string[];
}

export interface StudioCreation {
  id: string;
  title: string;
  description: string;
  defaultMode: SessionMode;
  objectKey: string | null;
  object: { label: string; room: string } | null;
  currentVersionId: string | null;
  playing: number;
  versions: StudioVersion[];
  /** The repository it follows (null: it's built in the Studio). */
  source: CreationSource | null;
}

export interface StudioBuild {
  id: string;
  status: 'queued' | 'running' | 'passed' | 'published' | 'failed' | 'error';
  step: string | null;
  title: string | null;
  creationId: string | null;
  objectKey: string | null;
  versionId: string | null;
  publish: boolean;
  qa: VersionQa | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  /** Built from a repository: which commit. */
  source: { repository: string; commit: string; label: string } | null;
}

/** A space's creations as its Architects see them (GET /api/spaces/:spaceId/studio). */
export interface Studio {
  space: { id: string; name: string };
  creations: StudioCreation[];
  /** Objects without a creation, which one could be put on. */
  freeObjects: { key: string; label: string; room: string }[];
  builds: StudioBuild[];
}

/** How smoothly things ran on people's devices (from those who share it), last 30 days. */
export interface FieldPerf {
  creationVersionId: string | null;
  device: string;
  tier: Tier;
  samples: number;
  fps: number;
  p50Ms: number;
  p95Ms: number;
  scale: number;
}

/**
 * For Architects: time people spent in a place (GET /api/spaces/:spaceId/visits), over the last
 * `days` days. Time in a room counts once someone has stayed a few seconds, while the app is in
 * sight; time in a creation, while it's open.
 */
export interface PlaceVisits {
  days: number;
  /** False when the group's Architects turned visit records off (Group settings): nothing then. */
  recording: boolean;
  /** Every room of the live version, and any since removed that people spent time in. */
  rooms: {
    key: string;
    /** Null for a room no longer in the place. */
    name: string | null;
    /** Its floor, when the place has more than one. */
    floor: string | null;
    /** How many different people. */
    people: number;
    seconds: number;
  }[];
  creations: { id: string; title: string; people: number; seconds: number }[];
  people: {
    userId: string;
    name: string;
    color: string;
    /** Time in the place, creations included (time in a creation is also time in its room). */
    seconds: number;
    inCreations: number;
    lastAt: string;
  }[];
}
