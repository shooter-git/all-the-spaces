import { Icon, IconButton } from '@ats/ui';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Chat, ChatPerson } from '../lib/chat.ts';
import { useVisibleArea } from '../lib/keyboard.ts';
import { type ChatMessage, dmChannel, roomChannel, spaceChannel } from '../lib/live.ts';
import './chat.css';

type Tab = 'space' | 'room' | 'direct';

/**
 * The chat overlay: a bottom sheet in portrait, a side panel in landscape. Conversations: the
 * whole space, the room you're in, and direct messages.
 */
export function ChatPanel({
  chat,
  spaceId,
  room,
  channel: requested,
  onClose,
}: {
  chat: Chat;
  spaceId: string;
  room: { key: string; name: string } | null;
  /** Open this conversation (e.g. a direct message started from the people list). */
  channel?: string | null;
  onClose: () => void;
}) {
  const me = chat.state?.me;
  const area = useVisibleArea();
  const [tab, setTab] = useState<Tab>('space');
  const [dmWith, setDmWith] = useState<string | null>(null);

  // Jump to a requested conversation.
  useEffect(() => {
    if (!requested) return;
    if (requested.startsWith('dm:') && me) {
      setTab('direct');
      setDmWith(
        requested
          .split(':')
          .slice(1)
          .find((id) => id !== me.id) ?? null,
      );
    } else if (requested.startsWith('room:')) setTab('room');
    else setTab('space');
  }, [requested, me]);

  const channel =
    tab === 'space'
      ? spaceChannel(spaceId)
      : tab === 'room'
        ? room && roomChannel(spaceId, room.key)
        : dmWith && me
          ? dmChannel(me.id, dmWith)
          : null;

  const { open } = chat;
  useEffect(() => {
    open(channel);
    return () => open(null);
  }, [channel, open]);

  const people = new Map(chat.state?.people.map((p) => [p.id, p]) ?? []);
  const other = dmWith ? people.get(dmWith) : undefined;
  const count = (c: string | null) => (c ? (chat.unread[c] ?? 0) : 0);
  const directUnread = Object.entries(chat.unread)
    .filter(([c]) => c.startsWith('dm:'))
    .reduce((a, [, n]) => a + n, 0);

  return (
    <aside
      className="chat-panel"
      aria-label="Chat"
      style={
        {
          '--chat-inset': `${area?.inset ?? 0}px`,
          '--chat-top': `${area?.top ?? 0}px`,
          ...(area ? { '--chat-visible': `${area.height}px` } : {}),
        } as React.CSSProperties
      }
    >
      <header className="chat-head">
        <div className="chat-tabs" role="tablist">
          <TabButton
            active={tab === 'space'}
            onClick={() => setTab('space')}
            badge={count(spaceChannel(spaceId))}
          >
            Everyone
          </TabButton>
          {room && (
            <TabButton
              active={tab === 'room'}
              onClick={() => setTab('room')}
              badge={count(roomChannel(spaceId, room.key))}
            >
              {room.name}
            </TabButton>
          )}
          <TabButton
            active={tab === 'direct'}
            onClick={() => {
              setTab('direct');
              setDmWith(null);
            }}
            badge={directUnread}
          >
            Direct
          </TabButton>
        </div>
        <IconButton icon="close" label="Close chat" onClick={onClose} />
      </header>

      <div className="chat-bar">
        {tab === 'direct' && dmWith ? (
          <button type="button" className="chat-link" onClick={() => setDmWith(null)}>
            <Icon name="back" size={14} /> {other?.name ?? 'Back'}
            {other?.dnd && <span className="chat-dnd"> · Do not disturb</span>}
          </button>
        ) : (
          <span className="chat-muted">
            {tab === 'space'
              ? 'Everyone in this space'
              : tab === 'room'
                ? 'People who can see this room'
                : 'Direct messages'}
          </span>
        )}
        <span className="chat-toggles">
          {channel && (
            <label className="chat-toggle">
              <input
                type="checkbox"
                checked={chat.state?.muted.includes(channel) ?? false}
                onChange={(e) => chat.setMuted(channel, e.target.checked)}
              />
              Mute
            </label>
          )}
          <label className="chat-toggle" title="No pop-ups or badges; others see you're busy">
            <input
              type="checkbox"
              checked={me?.dnd ?? false}
              onChange={(e) => chat.setDnd(e.target.checked)}
            />
            Do not disturb
          </label>
        </span>
      </div>

      {tab === 'direct' && !dmWith ? (
        <PeoplePicker chat={chat} onPick={setDmWith} />
      ) : channel ? (
        <Conversation chat={chat} channel={channel} people={people} />
      ) : (
        <p className="chat-empty">Walk into a room to chat with the people there.</p>
      )}

      {channel && !(tab === 'direct' && !dmWith) && (
        <Composer
          chat={chat}
          channel={channel}
          disabled={Boolean(dmWith && chat.state?.blocked.includes(dmWith))}
          placeholder={
            tab === 'direct' && other
              ? `Message ${other.name}`
              : tab === 'room' && room
                ? `Message ${room.name}`
                : 'Message everyone'
          }
        />
      )}
    </aside>
  );
}

function TabButton({
  active,
  onClick,
  badge,
  children,
}: {
  active: boolean;
  onClick: () => void;
  badge: number;
  children: React.ReactNode;
}) {
  return (
    <button type="button" role="tab" aria-selected={active} className="chat-tab" onClick={onClick}>
      <span className="chat-tab-label">{children}</span>
      {badge > 0 && <span className="chat-badge">{badge > 99 ? '99+' : badge}</span>}
    </button>
  );
}

function PeoplePicker({ chat, onPick }: { chat: Chat; onPick: (id: string) => void }) {
  const me = chat.state?.me.id;
  const recent = new Map(chat.state?.conversations.map((c, i) => [c.channel, i]) ?? []);
  const order = (p: ChatPerson) =>
    me ? (recent.get(dmChannel(me, p.id)) ?? Number.MAX_SAFE_INTEGER) : 0;
  const people = (chat.state?.people ?? [])
    .filter((p) => p.id !== me)
    .sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
  if (people.length === 0) {
    return <p className="chat-empty">Nobody else has joined yet.</p>;
  }
  return (
    <ul className="chat-people">
      {people.map((p) => {
        const unread = me ? (chat.unread[dmChannel(me, p.id)] ?? 0) : 0;
        return (
          <li key={p.id}>
            <button type="button" className="chat-person" onClick={() => onPick(p.id)}>
              <span className="chat-dot" style={{ background: p.color }} data-online={p.online} />
              <span className="chat-person-name">
                {p.name}
                {p.dnd && <span className="chat-dnd"> · Do not disturb</span>}
                {chat.state?.blocked.includes(p.id) && (
                  <span className="chat-muted"> · Blocked</span>
                )}
              </span>
              {unread > 0 && <span className="chat-badge">{unread}</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function Conversation({
  chat,
  channel,
  people,
}: {
  chat: Chat;
  channel: string;
  people: Map<string, ChatPerson>;
}) {
  const thread = chat.threads[channel];
  const list = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const me = chat.state?.me.id;
  const last = thread?.messages.at(-1)?.id;

  // Stay at the newest message.
  useLayoutEffect(() => {
    if (last && list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [last]);

  const act = async (m: ChatMessage, what: 'report' | 'block') => {
    setMenu(null);
    try {
      if (what === 'report') {
        await chat.report(m.id);
        setNotice('Reported to the Architects. Thank you.');
      } else {
        await chat.setBlocked(m.senderId, true);
        setNotice(`You won't see anything from ${m.senderName} any more.`);
      }
    } catch (e) {
      setNotice((e as Error).message);
    }
  };

  return (
    <div className="chat-list" ref={list} role="log" aria-live="polite">
      {thread?.more && (
        <button
          type="button"
          className="chat-link chat-older"
          onClick={() => chat.load(channel, true)}
        >
          Show earlier messages
        </button>
      )}
      {thread && !thread.loading && thread.messages.length === 0 && (
        <p className="chat-empty">No messages yet. Say hello!</p>
      )}
      {thread?.messages.map((m) => {
        const mine = m.senderId === me;
        return (
          <div key={m.id} className="chat-message" data-mine={mine}>
            <div className="chat-meta">
              <span className="chat-dot" style={{ background: people.get(m.senderId)?.color }} />
              <strong>{mine ? 'You' : m.senderName}</strong>
              <time dateTime={m.createdAt}>{time(m.createdAt)}</time>
              {!mine && (
                <IconButton
                  icon="more"
                  className="chat-more"
                  label={`Options for ${m.senderName}'s message`}
                  aria-expanded={menu === m.id}
                  onClick={() => setMenu(menu === m.id ? null : m.id)}
                />
              )}
            </div>
            <p className="chat-body">{m.body}</p>
            {menu === m.id && (
              <div className="chat-menu" role="menu">
                <button type="button" role="menuitem" onClick={() => act(m, 'report')}>
                  <Icon name="flag" size={16} />
                  Report this message
                </button>
                <button type="button" role="menuitem" onClick={() => act(m, 'block')}>
                  <Icon name="block" size={16} />
                  Block {m.senderName}
                </button>
              </div>
            )}
          </div>
        );
      })}
      {notice && (
        <p className="chat-notice" role="status">
          {notice}
        </p>
      )}
    </div>
  );
}

function Composer({
  chat,
  channel,
  placeholder,
  disabled,
}: {
  chat: Chat;
  channel: string;
  placeholder: string;
  disabled: boolean;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Ready to type straight away on keyboards (not on phones, where it'd pop the keyboard up).
    if (window.matchMedia('(pointer: fine)').matches) input.current?.focus();
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    try {
      await chat.send(channel, body);
      setText('');
    } catch (err) {
      setError((err as Error).message);
    }
    setSending(false);
  };

  return (
    <form className="chat-compose" onSubmit={submit}>
      {error && <p className="chat-error">{error}</p>}
      {disabled ? (
        <p className="chat-muted">You've blocked this person.</p>
      ) : (
        <div className="chat-compose-row">
          <input
            ref={input}
            className="ats-input"
            value={text}
            maxLength={2000}
            placeholder={placeholder}
            aria-label={placeholder}
            enterKeyHint="send"
            onChange={(e) => setText(e.target.value)}
          />
          <button
            type="submit"
            className="ats-button ats-button--primary chat-send"
            disabled={!text.trim()}
            aria-label="Send"
            title="Send"
          >
            <Icon name="send" />
          </button>
        </div>
      )}
      {!chat.connected && <p className="chat-muted">Reconnecting…</p>}
    </form>
  );
}

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
