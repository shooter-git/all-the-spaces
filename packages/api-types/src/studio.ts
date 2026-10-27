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

/** What someone was on (not known for time before this was recorded). */
export type VisitDevice = 'phone' | 'tablet' | 'computer' | 'headset';

/** Time per kind of device. */
export interface DeviceTime {
  device: VisitDevice | null;
  seconds: number;
}

/**
 * For Architects: time people spent in a place (GET /api/spaces/:spaceId/visits?days=&tz=), over
 * the last `days` days. Time in a room counts once someone has stayed a few seconds, while the app
 * is in sight; time in a creation, while it's open. Time in a creation is also time in its room,
 * so a person's time is never the sum of their rooms and creations.
 */
export interface PlaceVisits {
  /** The days shown, today included: 7, 30 or 90. */
  days: number;
  /** How many days visits are kept (the longest period there is). */
  kept: number;
  /** False when the group's Architects turned visit records off (Group settings): nothing then. */
  recording: boolean;
  /** The time zone days and hours are in (`?tz=`, else UTC). */
  timeZone: string;
  summary: {
    /** Everyone's time here, each person's counted once where their visits overlap. */
    seconds: number;
    people: number;
    /** Separate times people came: back within a few minutes is the same visit. */
    visits: number;
    /** How long the middle visit lasted. */
    typicalSeconds: number;
    /** People here on two days or more. */
    cameBack: number;
    /** Time in rooms with someone else there too, and all time in rooms. */
    togetherSeconds: number;
    roomSeconds: number;
  };
  /**
   * Time and people over the period, oldest first: a day each for 7 or 30 days, a week each
   * (from Monday) for 90. `from` is the first day (YYYY-MM-DD).
   */
  trend: { from: string; days: number; seconds: number; people: number }[];
  /** Time by weekday (0 is Monday) and hour of the day: 7 rows of 24. */
  week: number[][];
  devices: DeviceTime[];
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
    /** How many times people came in (stepping out of sight and back isn't another). */
    visits: number;
    /** Time with someone else in the room too. */
    togetherSeconds: number;
  }[];
  creations: {
    id: string;
    title: string;
    people: number;
    seconds: number;
    /** How many times it was opened. */
    visits: number;
    /** Time in a session with someone else playing too. */
    togetherSeconds: number;
  }[];
  /** The most common moves from one room straight into another, most first. */
  moves: { from: string; to: string; times: number }[];
  people: {
    userId: string;
    name: string;
    color: string;
    /** Time in the place, creations included (time in a creation is also time in its room). */
    seconds: number;
    inCreations: number;
    lastAt: string;
    /** How many different days they were here, and how many times they came. */
    days: number;
    visits: number;
    typicalSeconds: number;
    /** Time in rooms and creations with someone else there too. */
    togetherSeconds: number;
    /** Their time in each room and creation, most first. */
    rooms: { key: string; seconds: number }[];
    creations: { id: string; seconds: number }[];
    devices: DeviceTime[];
    /** Their time by hour of the day: 24. */
    hours: number[];
  }[];
}
