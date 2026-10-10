import type {
  Assistant,
  AssistantChoice,
  AssistantPicture,
  ChangedFiles,
  CheckResult,
  FileView,
  Provider,
  StudioSettings,
  UploadedFile,
  WorkspaceDetail,
  WorkspaceSummary,
} from '@ats/api-types';
import { api } from './api.ts';

export type {
  Assistant,
  AssistantChoice,
  AssistantPicture,
  ChangedFile,
  ChangedFiles,
  CheckResult,
  FileView,
  Provider,
  StudioSettings,
  UploadedFile,
  WorkspaceDetail,
  WorkspaceSummary,
} from '@ats/api-types';

export const loadAssistants = () =>
  api<{ available: boolean; assistants: Assistant[] }>('/api/studio/assistants');
export const assistantAction = <T = { ok: boolean }>(
  p: Provider,
  action: 'open' | 'install' | 'sign-in' | 'check' | 'close' | 'forget',
) => api<T>(`/api/studio/assistants/${p}/${action}`, { method: 'POST', json: {} });

export const loadWorkspaces = (spaceId: string) =>
  api<{
    available: boolean;
    space: { id: string; name: string; groupId: string };
    workspaces: WorkspaceSummary[];
    objects: { key: string; label: string; room: string }[];
  }>(`/api/spaces/${spaceId}/workspaces`);

export const createWorkspace = (
  spaceId: string,
  body: {
    title: string;
    brief: string;
    objectKey: string | null;
    provider: Provider;
    creationId?: string;
    model?: string | null;
    effort?: string | null;
  },
) => api<{ id: string }>(`/api/spaces/${spaceId}/workspaces`, { method: 'POST', json: body });

/** Changes a workspace's model or effort (used the next time its assistant starts). */
export const setWorkspaceAssistant = (id: string, choice: AssistantChoice) =>
  api<{ ok: true; runsWith: AssistantChoice }>(`/api/workspaces/${id}/assistant`, {
    json: choice,
  });

export const loadWorkspace = (id: string) => api<WorkspaceDetail>(`/api/workspaces/${id}`);
/** Waking and sleeping are safe to repeat (and are when the network blinks as containers start). */
export const workspaceAction = (id: string, action: 'open' | 'stop') =>
  api(`/api/workspaces/${id}/${action}`, { method: 'POST', json: {}, retry: true });
/** Says the Architect is here, so their workspace doesn't go to sleep under them. */
export const stillHere = (id: string) =>
  api(`/api/workspaces/${id}/here`, { method: 'POST', json: {}, retry: true });
export const runChecks = (id: string) =>
  api<CheckResult>(`/api/workspaces/${id}/check`, { method: 'POST', json: {} });
export const typeInto = (id: string, what: 'start' | 'resume' | 'prompt', text?: string) =>
  api(`/api/workspaces/${id}/type`, { method: 'POST', json: { what, ...(text ? { text } : {}) } });
/** Files larger than this aren't taken (the server says the same). */
export const MAX_UPLOAD = 25 * 1024 * 1024;

/**
 * Adds a file to the workspace's `uploads/` folder; the server pastes its path into the terminal
 * (never sent). For a place, `as` says whether a picture is a plan or a photo.
 */
export async function uploadToWorkspace(id: string, file: File, as?: 'plan' | 'photo') {
  const res = await fetch(
    `/api/workspaces/${id}/uploads/${encodeURIComponent(file.name)}${as ? `?as=${as}` : ''}`,
    {
      method: 'PUT',
      credentials: 'include',
      headers: { 'content-type': file.type || 'application/octet-stream' },
      body: file,
    },
  );
  const body = (await res.json().catch(() => ({}))) as {
    error?: string;
    path?: string;
    typed?: boolean;
  };
  if (res.status === 413) throw new Error(`${file.name} is over 25 MB.`);
  if (!res.ok) throw new Error(body.error ?? `${file.name} couldn't be added.`);
  return body as { path: string; typed: boolean };
}

/**
 * The assistant's pictures, newest first, and for a place whether it has changed since its last
 * build (null for a creation).
 */
export const loadPictures = (id: string) =>
  api<{
    pictures: AssistantPicture[];
    build: { last: number | null; changed: boolean } | null;
  }>(`/api/workspaces/${id}/pictures`);
export const pictureUrl = (id: string, p: AssistantPicture) =>
  `/api/workspaces/${id}/pictures/${p.path}?at=${p.at}`;

/** What's in an awake workspace's `uploads/` folder, oldest first. */
export const listUploads = (id: string) =>
  api<{ files: UploadedFile[] }>(`/api/workspaces/${id}/uploads`).then((r) => r.files);
/** What the assistant has made, changed or removed since the workspace started (names only). */
export const listChanges = (id: string) => api<ChangedFiles>(`/api/workspaces/${id}/files`);
/** What's in one workspace file: its text, or a picture. */
export const viewFile = (id: string, path: string) =>
  api<FileView>(`/api/workspaces/${id}/files/view?path=${encodeURIComponent(path)}`);
/** Removes an added file from the workspace. */
export const removeUpload = (id: string, name: string) =>
  api(`/api/workspaces/${id}/uploads/${encodeURIComponent(name)}`, { method: 'DELETE' });
/** Puts an added file's name in the terminal again (never sent). */
export const mentionUpload = (id: string, name: string) =>
  api<{ typed: boolean }>(`/api/workspaces/${id}/uploads/${encodeURIComponent(name)}/mention`, {
    method: 'POST',
  });

export const loadPreview = (id: string) =>
  api<{
    state: 'off' | 'building' | 'ready' | 'error';
    stamp?: number;
    url?: string;
    error?: string;
  }>(`/api/workspaces/${id}/preview`);
export const publishWorkspace = (id: string, live: boolean) =>
  api<{ buildId: string; live: boolean }>(`/api/workspaces/${id}/publish`, {
    method: 'POST',
    json: { live },
  });
export const deleteWorkspace = (id: string) => api(`/api/workspaces/${id}`, { method: 'DELETE' });

export const loadStudioSettings = (groupId: string) =>
  api<StudioSettings>(`/api/groups/${groupId}/studio-settings`);
export const saveStudioSettings = (groupId: string, s: StudioSettings) =>
  api(`/api/groups/${groupId}/studio-settings`, { method: 'PUT', json: s });
