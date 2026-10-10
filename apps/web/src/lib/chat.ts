import type { ChatState } from '@ats/api-types';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.ts';
import { acquireLive, type ChatMessage, type LiveConnection, releaseLive } from './live.ts';

export type { ChatPerson } from '@ats/api-types';

interface Thread {
  messages: ChatMessage[];
  /** Older messages exist beyond the first one loaded. */
  more: boolean;
  loading: boolean;
}

export type Chat = ReturnType<typeof useChat>;

/**
 * Everything the chat overlay needs: the live connection, people, threads and unread counts.
 * `onIncoming` hears about new messages worth a pop-up (not your own, not muted, not while
 * Do Not Disturb is on).
 */
export function useChat(onIncoming?: (m: ChatMessage) => void) {
  const [state, setState] = useState<ChatState | null>(null);
  const [threads, setThreads] = useState<Record<string, Thread>>({});
  /** The same threads, readable synchronously (for deciding what to load). */
  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [connected, setConnected] = useState(false);
  const live = useRef<LiveConnection | null>(null);
  /** The conversation on screen (it doesn't collect unread messages). */
  const viewing = useRef<string | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const incoming = useRef(onIncoming);
  incoming.current = onIncoming;

  const loadState = useCallback(
    () => api<ChatState>('/api/chat/state').then(setState, () => {}),
    [],
  );

  const load = useCallback(async (channel: string, older = false) => {
    const before = older ? threadsRef.current[channel]?.messages[0]?.createdAt : undefined;
    setThreads((t) => ({
      ...t,
      [channel]: { messages: t[channel]?.messages ?? [], more: false, loading: true },
    }));
    try {
      const q = new URLSearchParams({ channel, ...(before ? { before } : {}) });
      const res = await api<{ messages: ChatMessage[]; more: boolean }>(`/api/chat/history?${q}`);
      setThreads((t) => {
        const current = t[channel]?.messages ?? [];
        const merged = older ? [...res.messages, ...current] : mergeById(current, res.messages);
        return { ...t, [channel]: { messages: merged, more: res.more, loading: false } };
      });
    } catch {
      setThreads((t) => ({
        ...t,
        [channel]: { messages: t[channel]?.messages ?? [], more: false, loading: false },
      }));
    }
  }, []);

  const add = useCallback((m: ChatMessage) => {
    setThreads((t) => {
      const current = t[m.channel];
      if (!current) return t; // loaded in full when opened
      if (current.messages.some((x) => x.id === m.id)) return t;
      return { ...t, [m.channel]: { ...current, messages: [...current.messages, m] } };
    });
  }, []);

  useEffect(() => {
    const connection = acquireLive();
    live.current = connection;
    let wasConnected = false;
    const unwatch = connection.watchStatus((ok) => {
      setConnected(ok);
      // Catch up on anything missed while the connection was down.
      if (ok && wasConnected) {
        for (const channel of Object.keys(threadsRef.current)) void load(channel);
      }
      if (ok) wasConnected = true;
    });
    const off = connection.on((event) => {
      if (event.t === 'message') {
        const m = event.message;
        add(m);
        const s = stateRef.current;
        const mine = m.senderId === s?.me.id;
        const muted = s?.muted.includes(m.channel);
        if (
          m.channel.startsWith('dm:') &&
          s &&
          !s.conversations.some((c) => c.channel === m.channel)
        ) {
          setState({
            ...s,
            conversations: [{ channel: m.channel, at: m.createdAt }, ...s.conversations],
          });
        }
        if (!mine && !muted && viewing.current !== m.channel) {
          setUnread((u) => ({ ...u, [m.channel]: (u[m.channel] ?? 0) + 1 }));
          if (!s?.me.dnd) incoming.current?.(m);
        }
      } else if (event.t === 'dnd') {
        setState((s) =>
          s
            ? {
                ...s,
                me: s.me.id === event.userId ? { ...s.me, dnd: event.dnd } : s.me,
                people: s.people.map((p) => (p.id === event.userId ? { ...p, dnd: event.dnd } : p)),
              }
            : s,
        );
      }
    });
    void loadState();
    return () => {
      off();
      unwatch();
      releaseLive();
    };
  }, [add, load, loadState]);

  const open = useCallback(
    (channel: string | null) => {
      viewing.current = channel;
      if (!channel) return;
      setUnread((u) => (u[channel] ? { ...u, [channel]: 0 } : u));
      if (!threadsRef.current[channel]) void load(channel);
    },
    [load],
  );

  const send = useCallback(
    async (channel: string, body: string) => {
      const m = await (live.current as LiveConnection).send(channel, body);
      add(m);
    },
    [add],
  );

  const setDnd = useCallback(async (dnd: boolean) => {
    setState((s) => (s ? { ...s, me: { ...s.me, dnd } } : s));
    await api('/api/chat/dnd', { method: 'PUT', json: { dnd } });
  }, []);

  const setMuted = useCallback(async (channel: string, muted: boolean) => {
    setState((s) =>
      s ? { ...s, muted: muted ? [...s.muted, channel] : s.muted.filter((c) => c !== channel) } : s,
    );
    await api('/api/chat/mute', { method: 'PUT', json: { channel, muted } });
  }, []);

  const setBlocked = useCallback(async (userId: string, blocked: boolean) => {
    await api('/api/chat/block', { method: 'PUT', json: { userId, blocked } });
    setState((s) =>
      s
        ? {
            ...s,
            blocked: blocked ? [...s.blocked, userId] : s.blocked.filter((b) => b !== userId),
          }
        : s,
    );
    // Their messages disappear from every open conversation.
    if (blocked) {
      setThreads((t) =>
        Object.fromEntries(
          Object.entries(t).map(([c, th]) => [
            c,
            { ...th, messages: th.messages.filter((m) => m.senderId !== userId) },
          ]),
        ),
      );
    }
  }, []);

  const report = useCallback(
    (messageId: string, reason?: string) =>
      api('/api/chat/report', { method: 'POST', json: { messageId, reason } }),
    [],
  );

  const totalUnread = useMemo(() => Object.values(unread).reduce((a, b) => a + b, 0), [unread]);

  return {
    state,
    threads,
    unread,
    totalUnread,
    connected,
    open,
    load,
    send,
    setDnd,
    setMuted,
    setBlocked,
    report,
  };
}

function mergeById(current: ChatMessage[], loaded: ChatMessage[]) {
  const seen = new Set(loaded.map((m) => m.id));
  return [...loaded, ...current.filter((m) => !seen.has(m.id))].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
}
