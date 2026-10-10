import type { ActivityEntry, InviteLink, Person, ServerInfo, SignedIn } from '@ats/api-types';
import { api } from './api.ts';

export type { ActivityEntry, InviteLink, Person, ServerInfo, SignedIn } from '@ats/api-types';

export const loadPeople = (groupId: string) =>
  api<{ people: Person[] }>(`/api/groups/${groupId}/people`);
export const setRole = (groupId: string, userId: string, role: Person['role']) =>
  api(`/api/groups/${groupId}/people/${userId}`, { method: 'PUT', json: { role } });
export const removePerson = (groupId: string, userId: string) =>
  api(`/api/groups/${groupId}/people/${userId}`, { method: 'DELETE' });

export const loadInvites = (groupId: string) =>
  api<InviteLink[]>(`/api/groups/${groupId}/invite-links`);
export const makeInvite = (groupId: string, role: InviteLink['role']) =>
  api<{ url: string }>(`/api/groups/${groupId}/invite-links`, {
    json: { expiresInDays: 7, role },
  });
export const turnOffInvite = (groupId: string, id: string) =>
  api(`/api/groups/${groupId}/invite-links/${id}`, { method: 'DELETE' });
/** Still works: not turned off, not expired, not used up. */
export const usableInvite = (i: InviteLink) =>
  !i.revokedAt &&
  new Date(i.expiresAt).getTime() > Date.now() &&
  (i.maxUses === null || i.uses < i.maxUses);

export const saveGroup = (groupId: string, g: { name?: string; themeColor?: string }) =>
  api(`/api/groups/${groupId}`, { method: 'PUT', json: g });

export const loadActivity = (groupId: string, opts: { before?: string; all?: boolean } = {}) => {
  const q = new URLSearchParams();
  if (opts.before) q.set('before', opts.before);
  if (opts.all) q.set('all', '1');
  return api<{ entries: ActivityEntry[]; more: boolean }>(
    `/api/groups/${groupId}/activity${q.size ? `?${q}` : ''}`,
  );
};

export const loadServer = () => api<ServerInfo>('/api/server');

export const loadSessions = () => api<{ sessions: SignedIn[] }>('/api/account/sessions');
export const endSession = (id: string) => api(`/api/account/sessions/${id}`, { method: 'DELETE' });
export const endOtherSessions = () =>
  api<{ signedOut: number }>('/api/account/sessions/sign-out-others', { json: {} });

/** "Firefox on a Mac", from a browser's user agent (a rough guess is enough). */
export function deviceName(ua: string | null): string {
  if (!ua) return 'A device';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'A browser';
  const os = /iPhone/.test(ua)
    ? 'an iPhone'
    : /iPad/.test(ua)
      ? 'an iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Mac OS X/.test(ua)
          ? 'a Mac'
          : /Windows/.test(ua)
            ? 'Windows'
            : /CrOS/.test(ua)
              ? 'a Chromebook'
              : /Linux/.test(ua)
                ? 'Linux'
                : null;
  return os ? `${browser} on ${os}` : browser;
}

/** "3 Oct", "today 14:05": short and in the reader's own format. */
export function when(iso: string | null): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  const now = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `today ${time}`;
  const yesterday = new Date(now.getTime() - 86_400_000);
  if (d.toDateString() === yesterday.toDateString()) return `yesterday ${time}`;
  return d.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}
