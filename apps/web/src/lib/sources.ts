import type {
  CreationSource,
  ServerSources,
  ServerSourcesChange,
  SourceHostInfo,
  SourceSettings,
} from '@ats/api-types';
import { api } from './api.ts';

export type {
  CreationSource,
  ServerSourceHost,
  ServerSources,
  ServerSourcesChange,
  SourceHostInfo,
  SourceSettings,
} from '@ats/api-types';

/** Creations from repositories (docs/repositories.md). */
export const loadSourceHosts = () => api<SourceHostInfo[]>('/api/sources');

export const linkSource = (creationId: string, settings: SourceSettings) =>
  api<{ source: CreationSource }>(`/api/creations/${creationId}/source`, {
    method: 'PUT',
    json: settings,
  });

export const unlinkSource = (creationId: string) =>
  api(`/api/creations/${creationId}/source`, { method: 'DELETE' });

export const checkSource = (creationId: string) =>
  api<{ source: CreationSource }>(`/api/creations/${creationId}/source/check`, {
    method: 'POST',
    json: {},
  });

export const updateFromSource = (creationId: string, commit?: string) =>
  api<{ buildId: string; commit: string; label: string }>(
    `/api/creations/${creationId}/source/update`,
    { method: 'POST', json: commit ? { commit } : {} },
  );

export const createFromRepository = (
  spaceId: string,
  body: SourceSettings & { objectKey: string },
) =>
  api<{ buildId: string; commit: string; label: string }>(
    `/api/spaces/${spaceId}/creations/from-repository`,
    { method: 'POST', json: body },
  );

/** Where creations may come from, as the server's owner sets it (ADR 0012). */
export const loadServerSources = () => api<ServerSources>('/api/server/sources');

export const saveServerSources = (change: ServerSourcesChange) =>
  api<ServerSources>('/api/server/sources', { method: 'PUT', json: change });

/** What a host allows, in words: `*` is any public repository. */
export function allowedInWords(patterns: string[]) {
  const named = patterns.filter((p) => p !== '*');
  if (!patterns.includes('*')) return named.join(', ') || 'none yet';
  return named.length ? `any public repository, and ${named.join(', ')}` : 'any public repository';
}

/** A list typed one to a line (commas and spaces work too), without the empty ones. */
export const patternsFrom = (text: string) =>
  text
    .split(/[\s,]+/)
    .map((p) => p.trim())
    .filter(Boolean);

/** A commit as people read it. */
export const short = (commit: string | null) => (commit ? commit.slice(0, 7) : '');
