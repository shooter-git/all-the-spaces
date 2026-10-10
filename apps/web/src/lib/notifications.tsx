import type { AppNotification, NotificationSettings } from '@ats/api-types';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { api } from './api.ts';
import { acquireLive, releaseLive } from './live.ts';

export type { AppNotification, NotificationSettings } from '@ats/api-types';

export const loadNotificationSettings = () =>
  api<NotificationSettings>('/api/notifications/settings');

export const saveEmailNotifications = (email: boolean) =>
  api('/api/notifications/settings', { method: 'PUT', json: { email } });

// ---- Push notifications on this device -------------------------------------------------------

/** Whether this browser can receive push notifications (on iPhone: only once installed). */
export function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/** Supported, and the app's service worker is running (it isn't while developing). */
export async function pushAvailable() {
  return pushSupported() && Boolean(await navigator.serviceWorker.getRegistration());
}

async function registration() {
  return navigator.serviceWorker.ready;
}

export async function pushSubscription(): Promise<PushSubscription | null> {
  if (!(await pushAvailable())) return null;
  return (await registration()).pushManager.getSubscription();
}

/** A name people can tell their devices apart by, e.g. "Phone · Android · Chrome". */
export function deviceLabel() {
  const ua = navigator.userAgent;
  const touch = navigator.maxTouchPoints > 1;
  const os = /android/i.test(ua)
    ? 'Android'
    : /iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && touch)
      ? 'iOS'
      : /windows/i.test(ua)
        ? 'Windows'
        : /mac os/i.test(ua)
          ? 'Mac'
          : /cros/i.test(ua)
            ? 'ChromeOS'
            : 'Linux';
  const browser = /edg\//i.test(ua)
    ? 'Edge'
    : /firefox|fxios/i.test(ua)
      ? 'Firefox'
      : /chrome|crios/i.test(ua)
        ? 'Chrome'
        : /safari/i.test(ua)
          ? 'Safari'
          : 'Browser';
  const kind = /ipad|tablet/i.test(ua)
    ? 'Tablet'
    : /mobi|iphone|android/i.test(ua)
      ? 'Phone'
      : 'Computer';
  return `${kind} · ${os} · ${browser}`;
}

const fromBase64Url = (s: string) => {
  const b = atob(
    s
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(s.length / 4) * 4, '='),
  );
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};

/** Asks the browser for permission and signs this device up for push notifications. */
export async function enablePush(key: string): Promise<'on' | 'denied'> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return 'denied';
  const reg = await registration();
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: fromBase64Url(key),
    }));
  const json = sub.toJSON();
  await api('/api/notifications/devices', {
    json: { endpoint: json.endpoint, keys: json.keys, device: deviceLabel() },
  });
  return 'on';
}

/** Stops push notifications on this device (also on signing out). */
export async function disablePush() {
  const sub = await pushSubscription();
  if (!sub) return;
  await api('/api/notifications/devices', {
    method: 'DELETE',
    json: { endpoint: sub.endpoint },
  }).catch(() => {});
  await sub.unsubscribe();
}

// ---- The list, live ------------------------------------------------------------------------------

interface NotificationsState {
  items: AppNotification[];
  unread: number;
  more: boolean;
  loadMore: () => Promise<void>;
  markRead: (ids?: string[]) => Promise<void>;
  /** Hears each notification as it arrives (for a pop-up). */
  onArrive: (listener: (n: AppNotification) => void) => () => void;
}

const Ctx = createContext<NotificationsState | null>(null);

/** Keeps the signed-in person's notifications, live, for every page. */
export function NotificationsProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<AppNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [more, setMore] = useState(false);
  const listeners = useRef(new Set<(n: AppNotification) => void>());

  const load = useCallback(async () => {
    const res = await api<{ notifications: AppNotification[]; unread: number; more: boolean }>(
      '/api/notifications',
    ).catch(() => null);
    if (!res) return;
    setItems(res.notifications);
    setUnread(res.unread);
    setMore(res.more);
  }, []);

  useEffect(() => {
    void load();
    const live = acquireLive();
    let wasConnected = false;
    const unwatch = live.watchStatus((ok) => {
      // Catch up on anything that arrived while the connection was down.
      if (ok && wasConnected) void load();
      if (ok) wasConnected = true;
    });
    const off = live.on((event) => {
      if (event.t !== 'notification') return;
      const n = event.notification;
      setItems((list) => (list.some((x) => x.id === n.id) ? list : [n, ...list]));
      setUnread((u) => u + 1);
      for (const l of listeners.current) l(n);
    });
    return () => {
      off();
      unwatch();
      releaseLive();
    };
  }, [load]);

  const loadMore = useCallback(async () => {
    const last = items.at(-1);
    if (!last) return;
    const res = await api<{ notifications: AppNotification[]; more: boolean }>(
      `/api/notifications?${new URLSearchParams({ before: last.createdAt })}`,
    );
    setItems((list) => [
      ...list,
      ...res.notifications.filter((n) => !list.some((x) => x.id === n.id)),
    ]);
    setMore(res.more);
  }, [items]);

  const markRead = useCallback(
    async (ids?: string[]) => {
      const newlyRead = items.filter((n) => !n.read && (!ids || ids.includes(n.id))).length;
      if (ids && newlyRead === 0) return;
      setItems((list) => list.map((n) => (!ids || ids.includes(n.id) ? { ...n, read: true } : n)));
      setUnread((u) => (ids ? Math.max(0, u - newlyRead) : 0));
      await api('/api/notifications/read', { json: ids ? { ids } : {} }).catch(() => {});
    },
    [items],
  );

  const onArrive = useCallback((listener: (n: AppNotification) => void) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);

  const value = useMemo(
    () => ({ items, unread, more, loadMore, markRead, onArrive }),
    [items, unread, more, loadMore, markRead, onArrive],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useNotifications() {
  const value = useContext(Ctx);
  if (!value) throw new Error('useNotifications needs a NotificationsProvider');
  return value;
}
