import type {
  ObjectRequests,
  Provider,
  RequestDetail,
  RequestEvent,
  RequestKind,
  RequestStatus,
  RequestSummary,
} from '@ats/api-types';
import { api } from './api.ts';

export type {
  ObjectRequests,
  RequestDetail,
  RequestEvent,
  RequestKind,
  RequestStatus,
  RequestSummary,
} from '@ats/api-types';

/**
 * A short title from what someone asked, when they gave none: the first words of its first line
 * with any words in it, without the Markdown around them (a heading's `#`, a list's `-`, bold,
 * a link's address).
 */
export function titleFrom(text: string) {
  const line =
    text
      .split('\n')
      .map((l) =>
        l
          .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)+/, '')
          .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
          .replace(/[*`~]+/g, '')
          .replace(/(^|\s)_+|_+(?=\s|$)/g, '$1')
          .trim(),
      )
      .find((l) => /[\p{L}\p{N}]/u.test(l)) ?? '';
  const words = line.split(/\s+/).slice(0, 7).join(' ');
  const t = words.replace(/[.,;:!?]+$/, '');
  return (t.length > 60 ? `${t.slice(0, 57)}…` : t) || 'A request';
}

export const askFor = (
  spaceId: string,
  body: {
    kind: RequestKind;
    objectKey?: string | null;
    roomKey?: string | null;
    creationId?: string | null;
    title: string;
    prompt: string;
  },
) => api<{ id: string }>(`/api/spaces/${spaceId}/requests`, { json: body });

export async function addPicture(id: string, name: string, picture: Blob) {
  const res = await fetch(`/api/requests/${id}/images/${name}`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'content-type': picture.type.startsWith('image/') ? picture.type : 'image/jpeg' },
    body: picture,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "That picture couldn't be added.");
  }
}

export const pictureUrl = (id: string, name: string) => `/api/requests/${id}/images/${name}`;

/** The longest a request's words, and each document with it, may be (as the server says). */
export const MAX_PROMPT_CHARS = 10_000;
export const MAX_DOCUMENT_CHARS = 50_000;

/** A Markdown (or plain text) document to go with a request: `doc-1` to `doc-3`. */
export const addDocument = (id: string, name: string, file: string, text: string) =>
  api<{ documents: { name: string; file: string }[] }>(`/api/requests/${id}/documents/${name}`, {
    method: 'PUT',
    json: { file, text },
  });

export const documentUrl = (id: string, name: string) => `/api/requests/${id}/documents/${name}`;

export const myRequests = () =>
  api<{ requests: RequestSummary[] }>('/api/requests').then((r) => r.requests);

export const loadRequest = (id: string) =>
  api<{ request: RequestDetail; events: RequestEvent[] }>(`/api/requests/${id}`);

export const withdrawRequest = (id: string) => api(`/api/requests/${id}/withdraw`, { json: {} });

/** Tried it: that's it. */
export const finishRequest = (id: string) => api(`/api/requests/${id}/done`, { json: {} });

/** Tried it, and it isn't right yet: back to the Architects, saying why. */
export const notQuite = (id: string, note: string) =>
  api(`/api/requests/${id}/not-quite`, { json: { note } });

export const addNote = (id: string, note: string) =>
  api(`/api/requests/${id}/notes`, { json: { note } });

export const objectRequests = (spaceId: string) =>
  api<{ objects: ObjectRequests }>(`/api/spaces/${spaceId}/requests/objects`).then(
    (r) => r.objects,
  );

// Architects

export const requestQueue = (all = false) =>
  api<{ requests: RequestSummary[] }>(`/api/studio/requests${all ? '?all=1' : ''}`).then(
    (r) => r.requests,
  );

export const updateRequest = (
  id: string,
  body: {
    title?: string;
    brief?: string | null;
    priority?: 'low' | 'normal' | 'high';
    effort?: 'small' | 'medium' | 'large' | null;
  },
) => api(`/api/requests/${id}`, { method: 'PATCH', json: body });

export const acceptRequest = (id: string, note?: string) =>
  api(`/api/requests/${id}/accept`, { json: note ? { note } : {} });

export const declineRequest = (id: string, note: string) =>
  api(`/api/requests/${id}/decline`, { json: { note } });

export const startRequestWorkspace = (
  spaceId: string,
  body: {
    requestId: string;
    title: string;
    brief: string;
    provider: Provider;
    model?: string | null;
    effort?: string | null;
  },
) => api<{ id: string }>(`/api/spaces/${spaceId}/workspaces`, { json: body });

/** A short line for where a request is: "Bookshelf · Studio apartment". */
export const whereOf = (r: Pick<RequestSummary, 'objectLabel' | 'spaceName' | 'kind'>) =>
  [r.objectLabel ?? (r.kind === 'new' ? 'A new object' : null), r.spaceName]
    .filter(Boolean)
    .join(' · ');

export const KIND_WORDS: Record<RequestKind, string> = {
  new: 'Something new',
  improve: 'A change',
  bug: 'A problem',
};

/** The steps a request goes through, for showing where it's up to. */
export const STEPS = ['Sent', 'Accepted', 'Being built', 'Ready to try', 'Done'] as const;
export function stepOf(status: RequestStatus): number {
  switch (status) {
    case 'submitted':
      return 0;
    case 'accepted':
      return 1;
    case 'in_progress':
    case 'qa_failed':
    case 'ready':
    case 'not_quite':
      return 2;
    case 'published':
      return 3;
    case 'done':
      return 4;
    default:
      return -1;
  }
}
