import type {
  AddedInput,
  AddedPack,
  PlaceInput,
  PlaceVersion,
  PlanProblem,
  Provider,
  Review,
  SpaceType,
} from '@ats/api-types';
import { api } from './api.ts';

export type {
  AddedInput,
  AddedPack,
  PlaceInput,
  PlaceVersion,
  PlanProblem,
  Review,
  SpaceType,
} from '@ats/api-types';

export const createPlace = (groupId: string, name: string, spaceType: SpaceType) =>
  api<{ spaceId: string }>(`/api/groups/${groupId}/places`, {
    method: 'POST',
    json: { name, spaceType },
  });

export const listInputs = (spaceId: string) =>
  api<{ inputs: PlaceInput[] }>(`/api/spaces/${spaceId}/inputs`).then((r) => r.inputs);

/** Uploads a floor plan or photo (the server re-saves it without hidden details). */
export async function uploadInput(spaceId: string, name: string, file: File, note = '') {
  const res = await fetch(
    `/api/spaces/${spaceId}/inputs/${name}?${new URLSearchParams({ note })}`,
    {
      method: 'PUT',
      credentials: 'include',
      headers: { 'content-type': file.type.startsWith('image/') ? file.type : 'image/jpeg' },
      body: file,
    },
  );
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(body.error ?? "That picture couldn't be added.");
  return body as AddedInput;
}

/**
 * Adds a pack: a .zip of photos with notes on them (a README, a manifest), unpacked and kept whole
 * with the place, its files keeping their names. `left` is what in it a place can't take.
 */
export async function uploadPack(spaceId: string, file: File, positions = false) {
  const query = positions ? '?positions=1' : '';
  const res = await fetch(`/api/spaces/${spaceId}/packs/${encodeURIComponent(file.name)}${query}`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'content-type': 'application/zip' },
    body: file,
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (res.status === 413 && !body.error) throw new Error(`${file.name} is over 25 MB.`);
  if (!res.ok) throw new Error(body.error ?? `${file.name} couldn't be added.`);
  return body as AddedPack;
}

export const removeInput = (spaceId: string, name: string) =>
  api(`/api/spaces/${spaceId}/inputs/${name}`, { method: 'DELETE' });

/** Discards a place that's still being set up, with its workspace and everything added for it. */
export const discardPlace = (spaceId: string) =>
  api(`/api/spaces/${spaceId}`, { method: 'DELETE' });

export const inputUrl = (spaceId: string, name: string) => `/api/spaces/${spaceId}/inputs/${name}`;

export const startPlaceWorkspace = (
  spaceId: string,
  provider: Provider,
  description: string,
  choice: { model?: string | null; effort?: string | null } = {},
) =>
  api<{ id: string }>(`/api/spaces/${spaceId}/workspace`, {
    method: 'POST',
    json: { provider, description, ...choice },
  });

export const loadReview = (spaceId: string) => api<Review>(`/api/spaces/${spaceId}/review`);
/** Starts building a candidate; when the plan has problems, says which. */
export async function buildPlace(workspaceId: string) {
  const res = await fetch(`/api/workspaces/${workspaceId}/build-space`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string; problems?: PlanProblem[] };
  return { ok: res.ok, error: body.error ?? null, problems: body.problems ?? [] };
}
/** Publishes a candidate; `moves` gives each creation whose object is gone a new one (or null). */
export const publishPlace = (
  spaceId: string,
  versionId: string,
  moves: Record<string, string | null> = {},
) =>
  api<{ ok: true; inputsDeleted: boolean }>(
    `/api/spaces/${spaceId}/versions/${versionId}/publish`,
    { method: 'POST', json: { moves } },
  );

/** Every version that has been live, and when the live one became live. */
export const placeVersions = (spaceId: string) =>
  api<{ liveSince: string | null; versions: PlaceVersion[] }>(`/api/spaces/${spaceId}/versions`);
/** Makes an earlier (or later) version live again, with every creation where it was then. */
export const makePlaceVersionLive = (spaceId: string, versionId: string) =>
  api<{ ok: boolean; shelved?: number }>(`/api/spaces/${spaceId}/versions/${versionId}/live`, {
    json: {},
  });
/** Gives a creation an object (or puts it on the unplaced shelf, with null). */
export const placeCreation = (creationId: string, objectKey: string | null) =>
  api(`/api/creations/${creationId}/place`, { method: 'PUT', json: { objectKey } });

/** How one floor's drawing lines up with the plan (trace.json), as the assistant's tools read it. */
export { type Trace as FloorTrace, traceFor } from '@ats/space-format';
export const redrawOverlay = (workspaceId: string) =>
  api(`/api/workspaces/${workspaceId}/overlay`, { method: 'POST', json: {} });
export const savePlan = (workspaceId: string, plan: unknown) =>
  api<{ ok: boolean; problems: PlanProblem[] }>(`/api/workspaces/${workspaceId}/plan`, {
    method: 'PUT',
    json: { plan },
  });
export const workspaceFile = (workspaceId: string, path: string) =>
  `/api/workspaces/${workspaceId}/files/${path}`;
