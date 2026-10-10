import type { Person, SessionMode } from '@allthespaces/bridge-protocol';
import type { CreationInfo, Me, OpenedCreation } from '@ats/api-types';
import { api } from './api.ts';

/** Your colour in creations until chat settings say otherwise. */
export const DEFAULT_COLOR = '#3F5B7C';

/** You, as a creation sees you (null when signed out). */
export const asPerson = (me: Me, color = DEFAULT_COLOR): Person | null =>
  me.user ? { id: me.user.id, name: me.user.name, color } : null;

export type { CreationInfo, OpenedCreation } from '@ats/api-types';
export type { SessionMode };

export const listCreations = (spaceId: string) =>
  api<{ creations: CreationInfo[] }>(`/api/spaces/${spaceId}/creations`).then((r) => r.creations);

export const openCreation = (
  id: string,
  mode: SessionMode,
  opts: { sessionId?: string; versionId?: string } = {},
) =>
  api<OpenedCreation>(`/api/creations/${id}/open`, {
    method: 'POST',
    json: {
      mode,
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      ...(opts.versionId ? { versionId: opts.versionId } : {}),
    },
  });
