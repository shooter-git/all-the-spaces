import { Button, IconButton, Notice, Section } from '@ats/ui';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  disablePush,
  enablePush,
  loadNotificationSettings,
  type NotificationSettings,
  pushAvailable,
  pushSubscription,
  pushSupported,
  saveEmailNotifications,
  useNotifications,
} from '../lib/notifications.tsx';
import { isIos, isStandalone } from '../lib/pwa.ts';
import './notifications.css';

/** "just now", "5 min ago", "yesterday", or a date. */
export function ago(at: string) {
  const s = (Date.now() - new Date(at).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 2 * 86400) return 'yesterday';
  return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** A bell with how many are unread; opens the list. */
export function NotificationBell({ className = 'ats-button ats-button--ghost' }) {
  const { unread } = useNotifications();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={`${className} notify-bell`}
        onClick={() => setOpen(true)}
        aria-label={unread ? `Notifications: ${unread} unread` : 'Notifications'}
      >
        <BellIcon />
        {unread > 0 && <span className="notify-badge">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && <NotificationSheet onClose={() => setOpen(false)} />}
    </>
  );
}

function BellIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <path
        d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16Z M10 20.5a2 2 0 0 0 4 0"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function NotificationSheet({ onClose }: { onClose: () => void }) {
  const { items, unread, more, loadMore, markRead } = useNotifications();
  const navigate = useNavigate();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
    if (document.pointerLockElement) document.exitPointerLock();
  }, []);
  const go = (id: string, url: string | null) => {
    void markRead([id]);
    dialog.current?.close();
    if (url) navigate(url);
  };
  return (
    <dialog
      ref={dialog}
      className="ats-sheet notify-sheet"
      onClose={onClose}
      aria-label="Notifications"
    >
      <div className="ats-stack">
        <div className="notify-head">
          <h2>Notifications</h2>
          <span className="notify-tools">
            {unread > 0 && (
              <IconButton icon="check" label="Mark all read" onClick={() => void markRead()} />
            )}
            <IconButton icon="close" label="Close" onClick={() => dialog.current?.close()} />
          </span>
        </div>
        {items.length === 0 ? (
          <p className="ats-muted">
            Nothing yet. You'll hear here when something you asked for moves on.
          </p>
        ) : (
          <ul className="notify-list">
            {items.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  className="notify-item"
                  data-unread={!n.read || undefined}
                  onClick={() => go(n.id, n.url)}
                >
                  <strong>{n.title}</strong>
                  {n.body && <span>{n.body}</span>}
                  <time dateTime={n.createdAt}>{ago(n.createdAt)}</time>
                </button>
              </li>
            ))}
          </ul>
        )}
        {more && (
          <Button variant="ghost" onClick={() => void loadMore()}>
            Show earlier
          </Button>
        )}
      </div>
    </dialog>
  );
}

/** How to be told: on this device (push), and by email. */
export function NotificationSettingsCard() {
  const [s, setS] = useState<NotificationSettings | null>(null);
  const [push, setPush] = useState<'on' | 'off' | 'denied' | 'install' | 'unsupported' | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadNotificationSettings().then(setS, (e: Error) => setError(e.message));
    void (async () => {
      if (!pushSupported()) return setPush(isIos() && !isStandalone() ? 'install' : 'unsupported');
      if (!(await pushAvailable())) return setPush('unsupported');
      if (Notification.permission === 'denied') return setPush('denied');
      setPush((await pushSubscription()) ? 'on' : 'off');
    })();
  }, []);

  const togglePush = async () => {
    if (!s?.pushKey) return;
    setBusy(true);
    setError(null);
    try {
      if (push === 'on') {
        await disablePush();
        setPush('off');
      } else {
        setPush(await enablePush(s.pushKey));
      }
    } catch (e) {
      setError((e as Error).message || "This device couldn't be set up for notifications.");
    }
    setBusy(false);
  };

  return (
    <Section title="Notifications">
      <p className="ats-muted">
        You'll always see them in the app (the bell at the top). When you're not in the app, they
        can also come to this device, or by email.
      </p>
      {push === 'install' && (
        <Notice>
          On iPhone and iPad, add the app to your Home Screen first (see “Install the app”), then
          turn notifications on from there.
        </Notice>
      )}
      {push === 'unsupported' && (
        <p className="ats-muted notify-small">
          This browser can't show notifications from the app.
        </p>
      )}
      {push === 'denied' && (
        <p className="ats-muted notify-small">
          Notifications are blocked for this app in your browser's settings. Allow them there, then
          come back.
        </p>
      )}
      {(push === 'on' || push === 'off') && (
        <label className="notify-check">
          <input
            type="checkbox"
            checked={push === 'on'}
            disabled={busy}
            onChange={() => void togglePush()}
          />
          On this device
        </label>
      )}
      {s?.canEmail && (
        <label className="notify-check">
          <input
            type="checkbox"
            checked={s.email}
            onChange={async (e) => {
              const email = e.target.checked;
              setS({ ...s, email });
              await saveEmailNotifications(email).catch((err: Error) => setError(err.message));
            }}
          />
          By email
        </label>
      )}
      {s && s.devices.length > 0 && (
        <p className="ats-muted notify-small">
          Your devices: {s.devices.map((d) => d.device || 'a device').join(', ')}
        </p>
      )}
      <p className="ats-muted notify-small">
        Do Not Disturb (in chat) holds them all back: they wait here for you.
      </p>
      {error && <Notice tone="error">{error}</Notice>}
    </Section>
  );
}
