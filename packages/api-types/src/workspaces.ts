/**
 * The AI assistants an Architect can connect. The same list as @ats/shared's VENDOR_CLIS: the
 * server's replies are checked against this type, so one missing here fails to compile.
 */
export type Provider = 'claude' | 'codex';

export interface Assistant {
  provider: Provider;
  name: string;
  vendor: string;
  version: string;
  installed: boolean;
  installedVersion: string | null;
  signedIn: boolean;
  /** Uses this server's own API key (API-key mode): no sign-in. */
  apiKey?: boolean;
}

export interface WorkspaceSummary {
  id: string;
  title: string;
  provider: Provider;
  status: 'ready' | 'running' | 'stopped' | 'archived';
  mine: boolean;
  /** A creation, or the place itself being changed. */
  kind: 'creation' | 'space';
  where: string | null;
  objectKey: string | null;
  creationId: string | null;
  lastActivityAt: string | null;
  createdAt: string;
}

/** A model and effort for one workspace (null: the group's default). */
export interface AssistantChoice {
  model: string | null;
  effort: string | null;
}

export interface WorkspaceDetail {
  id: string;
  title: string;
  kind: 'creation' | 'space';
  /** The member's request it's being built for. */
  request: { id: string; title: string; status: string } | null;
  brief: string;
  provider: Provider;
  assistant: string;
  /** Chosen for this workspace (null: the group's default), and what it runs with now. */
  choice: AssistantChoice;
  runsWith: AssistantChoice;
  status: 'ready' | 'running' | 'stopped' | 'archived';
  stoppedBecause: string | null;
  creationId: string | null;
  spaceId: string;
  objectKey: string | null;
  startedAt: string | null;
  limits: { idleMinutes: number; sessionHours: number };
  /** When an awake workspace goes to sleep as things stand (null: asleep, or not started). */
  sleepsAt: string | null;
  lastBuild: {
    id: string;
    status: 'queued' | 'running' | 'passed' | 'published' | 'failed' | 'error';
    step: string | null;
    qa: { ok: boolean; failed: number; warned: number } | null;
    error: string | null;
    versionId: string | null;
  } | null;
  blockedHosts: string[];
}

/** What the checks in a workspace found. */
export interface CheckResult {
  ok: boolean;
  problems: { status: 'fail' | 'warn'; title: string; where: string | null; fix: string | null }[];
  passed: number;
}

/** A picture the assistant made: a model from four sides, or a room drawn from a corner. */
export interface AssistantPicture {
  path: string;
  kind: 'room' | 'model';
  name: string;
  /** When it was drawn (ms). */
  at: number;
}

/** A file added to a workspace's `uploads/` folder, or a folder (a pack: an unpacked .zip). */
export interface UploadedFile {
  name: string;
  /** All together, for a folder. */
  bytes: number;
  /** When it was added (seconds). */
  at: number;
  folder?: true;
  /** How many files a folder holds. */
  files?: number;
}

/** A file the assistant made, changed or removed since the workspace started (its name only). */
export interface ChangedFile {
  /** From the workspace's top, with `/` between folders. */
  path: string;
  change: 'added' | 'changed' | 'removed';
}

/** What the assistant has made, changed or removed in an awake workspace. */
export interface ChangedFiles {
  files: ChangedFile[];
  /** More than could be listed (only the first are). */
  more: boolean;
}

/** One workspace file, to look at: its text, or a picture (as a `data:` address). */
export type FileView =
  | { path: string; bytes: number; kind: 'text'; text: string }
  | { path: string; bytes: number; kind: 'picture'; src: string };

/** A group's Studio settings. */
export interface StudioSettings {
  claudeModel: string | null;
  codexModel: string | null;
  codexEffort: string | null;
  claudeEffort: string | null;
  idleMinutes: number;
  sessionHours: number;
  telemetry: boolean;
  requireDeviceTest: boolean;
  /** Delete a place's floor plans and photos once it's published. */
  deleteInputsAfterPublish: boolean;
  /** Workspaces may reach the whole public internet (HTTPS), not just the allow-list. */
  openInternet: boolean;
}
