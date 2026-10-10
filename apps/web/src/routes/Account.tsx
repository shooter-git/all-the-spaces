import {
  Button,
  Field,
  Icon,
  IconButton,
  type IconName,
  List,
  ListRow,
  Notice,
  Section,
  Tag,
} from '@ats/ui';
import { useCallback, useEffect, useState } from 'react';
import { ManageLayout } from '../components/ManageLayout.tsx';
import { NotificationSettingsCard } from '../components/NotificationBell.tsx';
import type { Me } from '../lib/api.ts';
import { authClient } from '../lib/auth-client.ts';
import {
  type ConnectorInfo,
  clearLinkFlags,
  type LinkReturn,
  linkCheckWords,
  loadConnectors,
  readLinkReturn,
  startLink,
  unlink,
} from '../lib/connectors.ts';
import {
  deviceName,
  endOtherSessions,
  endSession,
  loadSessions,
  type SignedIn,
  when,
} from '../lib/group.ts';

function Profile({ me, onChanged }: { me: Me; onChanged: () => Promise<unknown> }) {
  const [name, setName] = useState(me.user?.name ?? '');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed = name.trim() !== (me.user?.name ?? '') && name.trim().length > 0;
  return (
    <Section title="You">
      <Field
        label="Your name (what others see)"
        value={name}
        maxLength={60}
        onChange={(e) => {
          setName(e.target.value);
          setSaved(false);
        }}
      />
      <p className="ats-muted" style={{ margin: 0 }}>
        You sign in as {me.user?.email}.
      </p>
      <div className="ats-row">
        <Button
          variant="primary"
          disabled={!changed}
          onClick={async () => {
            setError(null);
            const res = await authClient.updateUser({ name: name.trim() });
            if (res.error) return setError(res.error.message ?? 'That didn’t save.');
            await onChanged();
            setSaved(true);
          }}
        >
          Save
        </Button>
        {saved && <span className="ats-muted">Saved.</span>}
      </div>
      {error && <Notice tone="error">{error}</Notice>}
    </Section>
  );
}

function Password() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [others, setOthers] = useState(true);
  const [state, setState] = useState<'idle' | 'saving' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);
  return (
    <Section title="Password">
      <form
        className="ats-stack"
        style={{ gap: 12 }}
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          if (next.length < 10) return setError('Use at least 10 characters.');
          setState('saving');
          const res = await authClient.changePassword({
            currentPassword: current,
            newPassword: next,
            revokeOtherSessions: others,
          });
          if (res.error) {
            setState('idle');
            return setError(
              res.error.status === 400 || res.error.status === 401
                ? 'Your current password isn’t right.'
                : (res.error.message ?? 'That didn’t work.'),
            );
          }
          setCurrent('');
          setNext('');
          setState('done');
        }}
      >
        <Field
          label="Current password"
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
        <Field
          label="New password"
          type="password"
          autoComplete="new-password"
          hint="At least 10 characters."
          value={next}
          onChange={(e) => setNext(e.target.value)}
        />
        <label className="studio-check">
          <input type="checkbox" checked={others} onChange={(e) => setOthers(e.target.checked)} />
          Sign out everywhere else
        </label>
        <div className="ats-row">
          <Button
            type="submit"
            variant="primary"
            disabled={!current || !next || state === 'saving'}
          >
            {state === 'saving' ? 'Changing…' : 'Change password'}
          </Button>
          {state === 'done' && <span className="ats-muted">Changed.</span>}
        </div>
        {error && <Notice tone="error">{error}</Notice>}
      </form>
    </Section>
  );
}

interface Key {
  id: string;
  name?: string | null;
  createdAt: string | Date;
  deviceType?: string;
}

function Passkeys() {
  const [keys, setKeys] = useState<Key[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    const res = await authClient.passkey.listUserPasskeys();
    if (res.error) setError(res.error.message ?? 'Couldn’t load your passkeys.');
    else setKeys((res.data ?? []) as Key[]);
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return (
    <Section title="Passkeys">
      <p className="ats-muted">
        Sign in with Face ID, a fingerprint, or your device PIN instead of a password.
      </p>
      {keys && keys.length > 0 && (
        <List label="Your passkeys">
          {keys.map((k) => (
            <ListRow
              key={k.id}
              lead={<Icon name="key" />}
              title={k.name || 'Passkey'}
              meta={`Added ${when(new Date(k.createdAt).toISOString())}${k.deviceType === 'multiDevice' ? ' · works on your other devices too' : ''}`}
              actions={
                <IconButton
                  icon="trash"
                  tone="danger"
                  label={`Remove the passkey ${k.name || ''}`.trim()}
                  onClick={async () => {
                    const res = await authClient.passkey.deletePasskey({ id: k.id });
                    if (res.error) setError(res.error.message ?? 'That didn’t work.');
                    await refresh();
                  }}
                />
              }
            />
          ))}
        </List>
      )}
      <div>
        <Button
          onClick={async () => {
            setError(null);
            const res = await authClient.passkey.addPasskey({
              name: deviceName(navigator.userAgent),
            });
            if (res?.error)
              setError('That didn’t work on this device. You can try again any time.');
            await refresh();
          }}
        >
          <Icon name="plus" size={16} />
          Add a passkey on this device
        </Button>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
    </Section>
  );
}

/** A picture of the kind of device: phone, tablet or computer. */
const deviceIcon = (ua: string | null): IconName =>
  /iPhone|Android.+Mobile/.test(ua ?? '')
    ? 'phone'
    : /iPad|Android/.test(ua ?? '')
      ? 'tablet'
      : 'laptop';

function Devices() {
  const [list, setList] = useState<SignedIn[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(
    () =>
      loadSessions().then(
        (r) => setList(r.sessions),
        (e: Error) => setError(e.message),
      ),
    [],
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const [all, setAll] = useState(false);
  const others = list?.filter((s) => !s.current).length ?? 0;
  // This device first, then the most recently used; a long list folds away.
  const sorted = list ? [...list].sort((a, b) => Number(b.current) - Number(a.current)) : [];
  const shown = all ? sorted : sorted.slice(0, 5);
  return (
    <Section title="Where you’re signed in">
      {list && (
        <List label="Devices you're signed in on">
          {shown.map((s) => (
            <ListRow
              key={s.id}
              lead={<Icon name={deviceIcon(s.userAgent)} />}
              title={deviceName(s.userAgent)}
              tag={s.current ? <Tag tone="accent">This device</Tag> : undefined}
              meta={`Signed in ${when(s.createdAt)} · last used ${when(s.lastActiveAt)}`}
              actions={
                s.current ? undefined : (
                  <IconButton
                    icon="signOut"
                    label={`Sign out on ${deviceName(s.userAgent)}`}
                    onClick={async () => {
                      await endSession(s.id).catch((e: Error) => setError(e.message));
                      await refresh();
                    }}
                  />
                )
              }
            />
          ))}
        </List>
      )}
      {(sorted.length > shown.length || others > 1) && (
        <div className="ats-row" style={{ gap: 8 }}>
          {sorted.length > shown.length && (
            <Button variant="ghost" onClick={() => setAll(true)}>
              Show all {sorted.length}
            </Button>
          )}
          {others > 1 && (
            <Button
              onClick={async () => {
                await endOtherSessions().catch((e: Error) => setError(e.message));
                await refresh();
              }}
            >
              <Icon name="signOut" size={16} />
              Sign out everywhere else
            </Button>
          )}
        </div>
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </Section>
  );
}

/** What came back from linking, in words (the server adds `?linked=` or `?link_error=`). */
function linkOutcome(
  back: LinkReturn,
  list: ConnectorInfo[] | null,
): { tone: 'error' | undefined; text: string } {
  const c = list?.find((x) => x.id === back.connector);
  const checked = linkCheckWords(back.outcome, c?.displayName ?? null);
  switch (back.outcome) {
    case 'linked':
      return { tone: undefined, text: c?.accountName ? `Linked as ${c.accountName}.` : 'Linked.' };
    case 'unconfirmed':
      return { tone: undefined, text: checked as string };
    case 'refused':
      return { tone: 'error', text: checked as string };
    case 'expired':
      return {
        tone: 'error',
        text: 'That link had expired or was already used. Start again here.',
      };
    case 'cancelled':
      return { tone: 'error', text: 'Linking was cancelled.' };
    default:
      return { tone: 'error', text: 'Linking didn’t work this time. Try again in a moment.' };
  }
}

/**
 * Services the server's owner set up for creations to use (connectors), and whether you've linked
 * your own account at each. Only shown when the server has some.
 */
function LinkedAccounts() {
  const [list, setList] = useState<ConnectorInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [back] = useState(() => readLinkReturn(window.location.search));
  const refresh = useCallback(
    () =>
      loadConnectors().then(setList, (e: Error) => {
        setError(e.message);
      }),
    [],
  );
  useEffect(() => {
    void refresh();
    if (back) clearLinkFlags();
  }, [refresh, back]);
  if (!list?.length && !error) return null;
  const outcome = back ? linkOutcome(back, list) : null;
  return (
    <Section title="Linked accounts">
      <p className="ats-muted">
        Some creations can use your account at another service, after you link it here or from
        inside the creation. Each one only does what an Architect approved, as you.
      </p>
      {outcome &&
        (outcome.tone ? (
          <Notice tone="error">{outcome.text}</Notice>
        ) : (
          <Notice>{outcome.text}</Notice>
        ))}
      {list && (
        <List label="Services you can link">
          {list.map((c) => (
            <ListRow
              key={c.id}
              lead={<Icon name="link" />}
              title={c.displayName}
              tag={
                c.broken ? (
                  <Tag>Needs linking again</Tag>
                ) : c.linked ? (
                  <Tag tone="accent">Linked</Tag>
                ) : undefined
              }
              meta={
                c.linked && c.accountName && !c.broken
                  ? `Linked as ${c.accountName}`
                  : c.linked && c.linkedAt
                    ? `Linked ${when(new Date(c.linkedAt).toISOString())}`
                    : c.description || 'Not linked'
              }
              actions={
                c.linked && !c.broken ? (
                  <IconButton
                    icon="unlink"
                    label={`Unlink ${c.displayName}`}
                    disabled={busy === c.id}
                    onClick={async () => {
                      setBusy(c.id);
                      setError(null);
                      await unlink(c.id).catch((e: Error) => setError(e.message));
                      setBusy(null);
                      await refresh();
                    }}
                  />
                ) : (
                  <Button
                    disabled={busy === c.id}
                    onClick={async () => {
                      setBusy(c.id);
                      setError(null);
                      try {
                        await startLink(c.id, '/account');
                      } catch (e) {
                        setError((e as Error).message);
                        setBusy(null);
                      }
                    }}
                  >
                    <Icon name="link" size={16} />
                    {c.broken ? 'Link again' : 'Link'}
                  </Button>
                )
              }
            />
          ))}
        </List>
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </Section>
  );
}

export function Account({ me, onChanged }: { me: Me; onChanged: () => Promise<unknown> }) {
  return (
    <ManageLayout me={me} title="Your account">
      <Profile me={me} onChanged={onChanged} />
      <Devices />
      <Passkeys />
      <Password />
      <LinkedAccounts />
      <NotificationSettingsCard />
    </ManageLayout>
  );
}
