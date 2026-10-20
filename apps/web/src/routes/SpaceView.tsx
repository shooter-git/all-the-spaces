import type { SpaceManifest } from '@ats/space-format';
import { BrandMark, Button, Icon } from '@ats/ui';
import type { Quality, SpaceViewer, ViewerStats } from '@ats/viewer-core';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { AskFlow } from '../components/AskFlow.tsx';
import { ChatPanel } from '../components/ChatPanel.tsx';
import { CreationMenu } from '../components/CreationMenu.tsx';
import { ModePicker } from '../components/ModePicker.tsx';
import { NotificationSheet } from '../components/NotificationBell.tsx';
import { Passage, type PassagePhase } from '../components/Passage.tsx';
import { VoiceButton } from '../components/VoiceButton.tsx';
import type { Me } from '../lib/api.ts';
import { useChat } from '../lib/chat.ts';
import { useChatShortcut } from '../lib/chat-shortcut.ts';
import {
  clearLinkFlags,
  linkCheckWords,
  loadConnectors,
  readLinkReturn,
} from '../lib/connectors.ts';
import {
  asPerson,
  type CreationInfo,
  DEFAULT_COLOR,
  listCreations,
  type OpenedCreation,
  openCreation,
  type SessionMode,
} from '../lib/creations.ts';
import { type ChatMessage, dmChannel } from '../lib/live.ts';
import { useModal } from '../lib/modal.ts';
import { type AppNotification, useNotifications } from '../lib/notifications.tsx';
import { refreshAdvice, sendSample } from '../lib/perf.ts';
import { joinPresence, type OnlinePerson, type Presence } from '../lib/presence.ts';
import { isStandalone, useUpdateReady } from '../lib/pwa.ts';
import { objectRequests } from '../lib/requests.ts';
import { sound, useSoundPrefs } from '../lib/sound.ts';
import { useStillPage } from '../lib/turns.ts';
import { Joystick } from './space-view/Joystick.tsx';
import { PeopleSheet } from './space-view/PeopleSheet.tsx';
import { PerfPanel } from './space-view/PerfPanel.tsx';
import { isTouch, pickQuality } from './space-view/quality.ts';
import { RoomTitle } from './space-view/RoomTitle.tsx';
import { SpaceSettings } from './space-view/SpaceSettings.tsx';
import { TouchLook } from './space-view/TouchLook.tsx';
import { TravelMenu } from './space-view/TravelMenu.tsx';
import { useRequestsOverlay } from './space-view/useRequestsOverlay.ts';
import { useSpaceViewer } from './space-view/useSpaceViewer.ts';
import { type SessionVoice, useVoiceInSpace } from './space-view/useVoiceInSpace.ts';
import './space.css';

export { OPEN_TIMEOUT_MS } from './space-view/useSpaceViewer.ts';

// Running a creation (and its live connection) is only fetched when someone goes into one; it's
// asked for early, as soon as a creation is pointed at, so it's usually there by the door.
const loadCreationHost = () => import('../components/CreationHost.tsx');
const CreationHost = lazy(() => loadCreationHost().then((m) => ({ default: m.CreationHost })));

/** Taken out of the group: a fresh start at home, which says so (nothing here is theirs now). */
const removedFromGroup = () => window.location.replace('/');

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SIGNED_OUT = "You're signed out. Sign in again to come back in.";

/** Phones with little memory, and iPhones (which allow only one 3D view at a time). */
const releaseWhileAway = (quality: Quality) =>
  quality === 'low' ||
  /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  (navigator.userAgent.includes('Mac') && navigator.maxTouchPoints > 1);

export function SpaceView({ me }: { me: Me }) {
  const { spaceId } = useParams();
  // Architects can walk through a version that isn't live yet (a candidate to review).
  const reviewing = new URLSearchParams(window.location.search).get('version');
  const spaceBase = reviewing
    ? `/api/spaces/${spaceId}/versions/${reviewing}/`
    : `/api/spaces/${spaceId}/`;
  const navigate = useNavigate();
  const host = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<SpaceViewer | null>(null);
  const [manifest, setManifest] = useState<SpaceManifest | null>(null);
  /** A sheet opened from the menu: the rooms to go to, or sound and settings. */
  const [sheet, setSheet] = useState<'rooms' | 'settings' | null>(null);
  const [showPerf, setShowPerf] = useState(() =>
    new URLSearchParams(window.location.search).has('perf'),
  );
  const [stats, setStats] = useState<ViewerStats | null>(null);
  const touch = useMemo(isTouch, []);
  const [people, setPeople] = useState<OnlinePerson[]>([]);
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [live, setLive] = useState<'connected' | 'reconnecting' | 'offline' | null>(null);
  // A new version of the app, downloaded and waiting: offered here too, not only on Home.
  const update = useUpdateReady();
  const [chatOpen, setChatOpen] = useState(false);
  const [chatChannel, setChatChannel] = useState<string | null>(null);
  const [toast, setToast] = useState<ChatMessage | null>(null);
  const soundPrefs = useSoundPrefs();
  const chat = useChat((m) => {
    setToast(m);
    sound.chime(m.channel.startsWith('dm:') ? 'direct' : 'message');
  });
  const openChat = useCallback((channel: string | null = null) => {
    setChatChannel(channel);
    setChatOpen(true);
    setToast(null);
    if (document.pointerLockElement) document.exitPointerLock();
  }, []);
  // A pop-up for a new message fades after a few seconds.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(t);
  }, [toast]);
  const closeChat = useCallback(() => setChatOpen(false), []);

  // The page under the space never scrolls, and goes back to its top after the phone turns.
  useStillPage();

  // In the installed app on a phone, a space takes the whole screen (the app's other pages keep
  // the status bar). Browsers allow that only from a tap: the first touch on the 3D view itself.
  // Never from a touch on a control or a pop-up: going full screen moves everything up by the
  // status bar's height under the finger, so that tap would land beside what it was meant for.
  useEffect(() => {
    const page = document.documentElement;
    if (!touch || !isStandalone() || !page.requestFullscreen) return;
    const go = (e: PointerEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest('.space-look, .space-canvas')) return;
      window.removeEventListener('pointerup', go);
      if (!document.fullscreenElement)
        page.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
    };
    window.addEventListener('pointerup', go);
    return () => {
      window.removeEventListener('pointerup', go);
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    };
  }, [touch]);

  // ---- Creations: what's here, stepping in and out ----------------------------------------------
  const [creations, setCreations] = useState<CreationInfo[]>([]);
  const [picker, setPicker] = useState<CreationInfo | null>(null);
  const [focus, setFocus] = useState<CreationInfo | null>(null);
  useEffect(() => {
    if (focus || picker) loadCreationHost().catch(() => {});
  }, [focus, picker]);
  const { requested, setRequested, pointed, setPointed, ask, setAsk, requestedRef } =
    useRequestsOverlay();
  // Enter opens the chat, Escape closes it (keyboards). Asking for something has Enter of its own.
  useChatShortcut({ chatOpen, paused: ask !== null, open: openChat, close: closeChat });
  const [alert, setAlert] = useState<AppNotification | null>(null);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const notifications = useNotifications();
  const [presence, setPresence] = useState<Presence | null>(null);
  const [journey, setJourney] = useState<{
    creation: CreationInfo;
    opened: OpenedCreation;
    mode: SessionMode;
    leaving: boolean;
  } | null>(null);
  const [passage, setPassage] = useState<{
    phase: PassagePhase;
    title: string;
    progress: number | null;
  }>({ phase: 'off', title: '', progress: null });
  const [notice, setNotice] = useState<string | null>(null);
  /** A newer version of the open creation has saved data it can't use. */
  const [outdated, setOutdated] = useState(false);
  /** Open this again once the way out is done (rejoining the newer version). */
  const rejoinAfter = useRef<{ creation: CreationInfo; mode: SessionMode } | null>(null);
  // Your colour comes with the chat settings, which may arrive after you've gone into a creation:
  // the creation hears about it without its session restarting.
  const myColor = chat.state?.people.find((p) => p.id === me.user?.id)?.color ?? DEFAULT_COLOR;
  const person = useMemo(() => asPerson(me, myColor), [me, myColor]);
  /** On phones the 3D view is let go while you're in a creation (only one can run at a time). */
  const [released, setReleased] = useState(false);
  const heldSince = useRef(0);
  const readyWaiters = useRef<(() => void)[]>([]);

  // Also re-read whenever the space is re-read (a new version can move creations).
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-read with the manifest
  useEffect(() => {
    if (!spaceId) return;
    const load = () => {
      listCreations(spaceId).then(setCreations, () => {});
      if (!reviewing) objectRequests(spaceId).then(setRequested, () => {});
    };
    void load();
    // "n inside" stays fresh.
    const t = window.setInterval(load, 15_000);
    return () => window.clearInterval(t);
  }, [spaceId, reviewing, manifest]);
  const byObject = useMemo(
    () => new Map(creations.flatMap((c) => (c.objectKey ? [[c.objectKey, c] as const] : []))),
    [creations],
  );

  const enter = useCallback(async (creation: CreationInfo, mode: SessionMode) => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    setPicker(null);
    setFocus(null);
    if (document.pointerLockElement) document.exitPointerLock();
    const opening = openCreation(creation.id, mode);
    // Step up to the object as a soft veil and chord come in.
    sound.enter();
    setPassage({ phase: 'in', title: creation.title, progress: null });
    const center = creation.objectKey ? viewer.objectCenter(creation.objectKey) : null;
    await Promise.all([center ? viewer.approach(center, 0.9) : null, wait(750)]);
    let opened: OpenedCreation;
    try {
      opened = await opening;
    } catch (err) {
      setNotice((err as Error).message);
      setPassage((p) => ({ ...p, phase: 'out' }));
      await viewer.retreat(0.6);
      setPassage((p) => ({ ...p, phase: 'off' }));
      return;
    }
    viewer.pause();
    if (releaseWhileAway(pickQuality())) setReleased(true);
    heldSince.current = performance.now();
    setJourney({ creation, opened, mode, leaving: false });
    setPassage((p) => ({ ...p, phase: 'held' }));
  }, []);

  // For automated checks: open a creation by id, the way a click would.
  useEffect(() => {
    (window as unknown as { __atsOpenCreation?: unknown }).__atsOpenCreation = (
      id: string,
      mode?: SessionMode,
    ) => {
      const c = creations.find((x) => x.id === id);
      if (c) void enter(c, mode ?? c.defaultMode);
      return Boolean(c);
    };
  }, [creations, enter]);

  // Every creation opens on its door, even one meant for one person (it just has "Go in").
  const choose = useCallback((creation: CreationInfo) => setPicker(creation), []);

  const revealCreation = useCallback(async () => {
    // Keep the veil up for a moment at least, so it never flickers.
    await wait(Math.max(0, 900 - (performance.now() - heldSince.current)));
    sound.reveal();
    setPassage((p) => ({ ...p, phase: 'out' }));
    await wait(850);
    setPassage((p) => (p.phase === 'out' ? { ...p, phase: 'off' } : p));
  }, []);

  /** When the veil started coming in on the way out (0 while not leaving). */
  const leavingSince = useRef(0);
  /** The way out begins: veil and sound come in at once, while the creation saves behind it. */
  const beginLeaving = useCallback(() => {
    if (leavingSince.current) return;
    leavingSince.current = performance.now();
    sound.leave();
    setPassage({ phase: 'in', title: journey?.creation.title ?? '', progress: null });
  }, [journey]);

  const creationLeft = useCallback(async () => {
    // The creation may have asked to go itself, or stopped responding.
    beginLeaving();
    // Let the veil cover the frame before it goes.
    await wait(Math.max(0, 550 - (performance.now() - leavingSince.current)));
    leavingSince.current = 0;
    setJourney(null);
    setSessionVoice(null);
    let easing: Promise<void> | undefined;
    if (released) {
      // Bring the space back (it picks up where you stood) and wait until it's there.
      const back = new Promise<void>((r) => readyWaiters.current.push(r));
      setReleased(false);
      await back;
    } else {
      viewerRef.current?.resume();
      easing = viewerRef.current?.retreat(0.9);
    }
    // The veil lifts as the view eases back from the object.
    setPassage((p) => ({ ...p, phase: 'out' }));
    await Promise.all([easing, wait(850)]);
    setPassage((p) => (p.phase === 'out' ? { ...p, phase: 'off' } : p));
    setOutdated(false);
    const again = rejoinAfter.current;
    rejoinAfter.current = null;
    if (again) void enter(again.creation, again.mode);
  }, [released, beginLeaving, enter]);

  useEffect(() => {
    if (!notice) return;
    // Longer notes stay long enough to read.
    const t = setTimeout(() => setNotice(null), notice.length > 80 ? 8000 : 4000);
    return () => clearTimeout(t);
  }, [notice]);

  const { error, ready, progress, room, lift, locked, loadManifest, tryAgain } = useSpaceViewer({
    spaceBase,
    touch,
    released,
    host,
    viewerRef,
    readyWaiters,
    manifest,
    setManifest,
  });

  // Objects that hold creations shimmer.
  useEffect(() => {
    if (ready) viewerRef.current?.setHighlighted(byObject.keys());
  }, [ready, byObject]);

  const labelOf = useCallback(
    (key: string) =>
      manifest?.rooms.flatMap((r) => r.objects).find((o) => o.key === key)?.label ?? null,
    [manifest],
  );

  // What you're pointing at (or looking at, with the mouse captured): a gentle prompt.
  // biome-ignore lint/correctness/useExhaustiveDependencies: setPointed and requestedRef are stable
  useEffect(() => {
    if (!ready || journey || ask) return;
    let mouse: { x: number; y: number } | null = null;
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') mouse = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener('pointermove', onMove);
    const t = window.setInterval(() => {
      const v = viewerRef.current;
      if (!v) return;
      const key = document.pointerLockElement
        ? v.lookingAt()
        : mouse
          ? v.pickObject(mouse.x, mouse.y)
          : null;
      const found = (key && byObject.get(key)) || null;
      setFocus((f) => (f?.id === found?.id ? f : found));
      const asked = !found && key && requestedRef.current[key] ? key : null;
      setPointed((p) =>
        p?.key === asked ? p : asked ? { key: asked, label: labelOf(asked) ?? asked } : null,
      );
      host.current?.style.setProperty(
        'cursor',
        found && !document.pointerLockElement ? 'pointer' : '',
      );
    }, 150);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.clearInterval(t);
    };
  }, [ready, journey, byObject, ask, labelOf]);

  // Opening what you're pointing at: a click (or E with the mouse captured).
  useEffect(() => {
    const el = host.current;
    if (!el || !ready || journey || ask) return;
    const onClick = (e: MouseEvent) => {
      const v = viewerRef.current;
      if (!v) return;
      const key = document.pointerLockElement ? v.lookingAt() : v.pickObject(e.clientX, e.clientY);
      const c = key ? byObject.get(key) : undefined;
      if (!c) return;
      // Handled here: don't also capture the mouse.
      e.stopPropagation();
      e.preventDefault();
      choose(c);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'KeyE' || (e.target as HTMLElement | null)?.closest('input, textarea')) return;
      const key = viewerRef.current?.lookingAt();
      const c = key ? byObject.get(key) : undefined;
      if (c) choose(c);
    };
    el.addEventListener('click', onClick, true);
    window.addEventListener('keydown', onKey);
    return () => {
      el.removeEventListener('click', onClick, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [ready, journey, byObject, choose, ask]);

  // Arriving from a notification ("Ready to try"): go to the object and offer to go in.
  const arrivedFor = useRef(false);
  useEffect(() => {
    if (!ready || arrivedFor.current || !manifest) return;
    const key = new URLSearchParams(window.location.search).get('object');
    if (!key) return;
    const creation = byObject.get(key);
    if (!creation) return;
    arrivedFor.current = true;
    const room = manifest.rooms.find((r) => r.objects.some((o) => o.key === key));
    if (room && viewerRef.current?.currentRoom?.key !== room.key)
      viewerRef.current?.travelTo(room.key);
    setPicker(creation);
    const url = new URL(window.location.href);
    url.searchParams.delete('object');
    window.history.replaceState(null, '', url);
  }, [ready, manifest, byObject]);

  // Back from linking an account at a connector's service (a creation asked): say how it went.
  useEffect(() => {
    const back = readLinkReturn(window.location.search);
    if (!back) return;
    clearLinkFlags();
    if (back.outcome === 'refused' || back.outcome === 'unconfirmed') {
      // These name the service.
      void loadConnectors()
        .then((list) => list.find((c) => c.id === back.connector)?.displayName ?? null)
        .catch(() => null)
        .then((name) => {
          const words = linkCheckWords(back.outcome, name) as string;
          setNotice(
            back.outcome === 'refused' ? words : `${words} Open the creation again to carry on.`,
          );
        });
      return;
    }
    setNotice(
      back.outcome === 'linked'
        ? 'Your account is linked. Open the creation again to carry on.'
        : back.outcome === 'cancelled'
          ? 'Linking was cancelled. You can try again from the creation.'
          : 'Linking didn’t work this time. You can try again from the creation.',
    );
  }, []);

  // Notifications pop up while you're here (tap to see).
  useEffect(
    () =>
      notifications.onArrive((n) => {
        setAlert(n);
        window.setTimeout(() => setAlert((a) => (a?.id === n.id ? null : a)), 8000);
      }),
    [notifications.onArrive],
  );

  // Live presence starts once the space is on screen (not while reviewing a version nobody else
  // can walk yet).
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!ready || !viewer || !spaceId || reviewing) return;
    let joined: Presence | null = null;
    let cancelled = false;
    joinPresence(spaceId, viewer, setPeople, setLive, loadManifest, removedFromGroup).then(
      (p) => {
        if (cancelled) p.leave();
        else {
          joined = p;
          setPresence(p);
        }
      },
      () => setLive('offline'),
    );
    return () => {
      cancelled = true;
      joined?.leave();
      setPresence(null);
    };
  }, [ready, spaceId, loadManifest, reviewing]);

  // Voice chat: the room you're standing in, or the creation session you're in.
  const [sessionVoice, setSessionVoice] = useState<SessionVoice | null>(null);
  const voice = useVoiceInSpace({ journey, sessionVoice, presence, room, onProblem: setNotice });

  // How smoothly it runs, once a minute, from devices that share it (see the menu): the space
  // while walking, the creation while inside one. Also refreshes the advised starting quality.
  const creationPerf = useRef<{ fps: number; p50Ms?: number; p95Ms?: number } | null>(null);
  const journeyRef = useRef(journey);
  journeyRef.current = journey;
  useEffect(() => {
    if (!ready || !spaceId || reviewing) return;
    void refreshAdvice();
    const tier = pickQuality();
    const t = window.setInterval(() => {
      const inside = journeyRef.current;
      if (inside) {
        const p = creationPerf.current;
        creationPerf.current = null;
        if (p?.p50Ms && p.p95Ms && !inside.opened.trial)
          sendSample({
            kind: 'creation',
            spaceId,
            creationVersionId: inside.opened.creation.versionId,
            tier,
            fps: p.fps,
            p50Ms: p.p50Ms,
            p95Ms: p.p95Ms,
            scale: 1,
          });
        return;
      }
      const st = viewerRef.current?.stats();
      if (st)
        sendSample({
          kind: 'space',
          spaceId,
          tier,
          fps: st.fps,
          p50Ms: st.frameMsP50,
          p95Ms: st.frameMsP95,
          scale: st.resolutionScale,
        });
    }, 60_000);
    return () => window.clearInterval(t);
  }, [ready, spaceId, reviewing]);

  useEffect(() => {
    if (!showPerf) return;
    const t = setInterval(() => viewerRef.current && setStats(viewerRef.current.stats()), 500);
    return () => clearInterval(t);
  }, [showPerf]);

  const floorName = manifest?.floors.find((f) => f.key === room?.floorKey)?.name;
  const multiFloor = (manifest?.floors.length ?? 0) > 1;

  const shownError = error ?? (person ? null : { message: SIGNED_OUT, retry: false });
  if (shownError) {
    return (
      <main className="ats-screen">
        <div className="ats-center ats-stack" style={{ textAlign: 'center' }} role="alert">
          <p>{shownError.message}</p>
          <div className="ats-row" style={{ justifyContent: 'center', gap: 8 }}>
            <Button onClick={() => navigate('/')}>Back home</Button>
            {shownError.retry && (
              <Button variant="primary" onClick={tryAgain}>
                <Icon name="refresh" size={16} />
                Try again
              </Button>
            )}
          </div>
        </div>
      </main>
    );
  }

  return (
    <div
      className="space-root"
      data-chat={chatOpen ? 'open' : undefined}
      data-update={update.ready ? 'ready' : undefined}
    >
      <div className="space-canvas" ref={host} />
      {touch && ready && !journey && (
        <TouchLook
          viewer={viewerRef}
          onTap={(x, y) => {
            const key = viewerRef.current?.pickObject(x, y);
            const c = key ? byObject.get(key) : undefined;
            if (c) choose(c);
            return Boolean(c);
          }}
        />
      )}

      <div className="space-hud" hidden={Boolean(journey)}>
        {room && (
          <RoomTitle
            roomKey={room.key}
            name={room.name}
            under={(multiFloor ? floorName : manifest?.name) ?? null}
          />
        )}

        {/* Refreshing reloads the page: offered in the space, never inside a creation (the HUD
            is hidden there). */}
        {update.ready && (
          <div className="space-chip space-update" role="status">
            <span>A new version is ready.</span>
            <Button variant="primary" onClick={() => update.apply()}>
              <Icon name="refresh" size={16} />
              Refresh
            </Button>
          </div>
        )}

        <div className="space-bottom">
          {touch ? <Joystick viewer={viewerRef} /> : <span />}
          {!touch && ready && !locked && !focus && !pointed && !ask && (
            <div className="washi-glass space-hint">
              Click to look around · W A S D to walk · Shift to run · Esc to stop
            </div>
          )}
          {lift && (
            <div className="space-lift">
              <div className="space-chip">
                <strong>{lift.link.name}</strong>
              </div>
              {lift.link.stops.map((s, i) =>
                i === lift.stop ? null : (
                  <button
                    key={s.roomKey}
                    type="button"
                    className="space-icon-button"
                    onClick={() => viewerRef.current?.rideLift(lift.link, i)}
                  >
                    Go to {manifest?.floors.find((f) => f.key === s.floorKey)?.name}
                  </button>
                ),
              )}
            </div>
          )}
          {showPerf && stats && <PerfPanel stats={stats} />}
          {ready && !reviewing && !ask && (
            <button
              type="button"
              className="space-glass-button space-ask"
              onClick={() => setAsk({})}
            >
              <span className="washi-glass">
                <Icon name="plus" size={16} />
                Ask for something
              </span>
            </button>
          )}
        </div>
      </div>

      {/* Over the view (not the loading screen): the same corner menu as inside a creation. */}
      {ready && !journey && (
        <CreationMenu
          label="Menu"
          attention={chat.totalUnread > 0 || notifications.unread > 0 || voice.speaking.length > 0}
          aside={
            (voice.status === 'on' || voice.status === 'muted') && (
              <button
                type="button"
                className="creation-menu-mic"
                data-on={voice.status === 'on'}
                onClick={voice.toggleMic}
                aria-label={
                  voice.status === 'on' ? 'Mute your microphone' : 'Unmute your microphone'
                }
              >
                <span className="creation-menu-glass">
                  <Icon name={voice.status === 'on' ? 'mic' : 'micOff'} />
                </span>
              </button>
            )
          }
        >
          {room && (
            <div className="creation-menu-note">
              {[manifest?.name, room.name, multiFloor ? floorName : null]
                .filter(Boolean)
                .join(' · ')}
            </div>
          )}
          <button
            type="button"
            className="creation-menu-item"
            onClick={() => (chatOpen ? closeChat() : openChat())}
            aria-label={`${chatOpen ? 'Close chat' : 'Chat'}${chat.totalUnread ? `: ${chat.totalUnread} unread` : ''}`}
            aria-expanded={chatOpen}
          >
            <Icon name="chat" />
            {chatOpen ? 'Close chat' : 'Chat'}
            {chat.totalUnread > 0 && (
              <span className="creation-menu-count">
                {chat.totalUnread > 99 ? '99+' : chat.totalUnread}
              </span>
            )}
          </button>
          {!reviewing && (
            <button
              type="button"
              className="creation-menu-item"
              onClick={() => setPeopleOpen(true)}
              aria-label={
                live === 'reconnecting'
                  ? 'People here: reconnecting'
                  : `People here: ${live === 'offline' ? 'offline' : people.length}`
              }
              title={
                live === 'offline'
                  ? 'Live presence is offline'
                  : live === 'reconnecting'
                    ? 'Reconnecting to live presence…'
                    : undefined
              }
            >
              <Icon name="people" />
              People here
              <span className="creation-menu-aside">
                {live === 'offline' || live === 'reconnecting' ? 'Offline' : people.length}
              </span>
            </button>
          )}
          {!reviewing && presence?.voice && (
            <div data-keep-open>
              <VoiceButton voice={voice} />
            </div>
          )}
          {(manifest?.rooms.length ?? 0) > 1 && (
            <button type="button" className="creation-menu-item" onClick={() => setSheet('rooms')}>
              <Icon name="map" />
              Go to another room
            </button>
          )}
          <button
            type="button"
            className="creation-menu-item"
            onClick={() => setNotificationsOpen(true)}
            aria-label={`Notifications${notifications.unread ? `: ${notifications.unread} new` : ''}`}
          >
            <Icon name="bell" />
            Notifications
            {notifications.unread > 0 && (
              <span className="creation-menu-count">
                {notifications.unread > 99 ? '99+' : notifications.unread}
              </span>
            )}
          </button>
          <button
            type="button"
            className="creation-menu-item"
            onClick={() => navigate('/requests')}
          >
            <Icon name="list" />
            My requests
          </button>
          <button type="button" className="creation-menu-item" onClick={() => setSheet('settings')}>
            <Icon name="settings" />
            Sound and settings
          </button>
          <div className="creation-menu-rule" />
          <button
            type="button"
            className="creation-menu-item"
            data-wrap
            onClick={() => navigate('/')}
          >
            <Icon name="back" />
            Leave {manifest?.name ?? 'the space'}
          </button>
        </CreationMenu>
      )}

      <div className="space-loading" data-done={ready || Boolean(journey) || released}>
        <div className="ats-stack" style={{ alignItems: 'center', gap: 12 }}>
          <BrandMark size={48} />
          <span className="ats-muted">Opening {manifest?.name ?? 'the space'}…</span>
          <div
            className="space-loading-progress"
            role="progressbar"
            aria-label={`Opening ${manifest?.name ?? 'the space'}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress == null ? undefined : Math.round(progress * 100)}
          >
            {progress != null && (
              <span style={{ transform: `scaleX(${Math.max(0.04, Math.min(1, progress))})` }} />
            )}
          </div>
        </div>
      </div>

      {pointed && !focus && !journey && !picker && !ask && (
        <div className="space-focus" aria-live="polite">
          <strong>{pointed.label}</strong>{' '}
          <span className="space-focus-state">
            ·{' '}
            {requested[pointed.key]?.state === 'building'
              ? 'being built'
              : requested[pointed.key]?.mine
                ? 'you asked for something here'
                : 'someone asked for something here'}
          </span>
        </div>
      )}

      {focus && !journey && !picker && !ask && (
        <div className="space-focus" aria-live="polite">
          {touch ? 'Tap' : locked ? 'Press E or click' : 'Click'} to open{' '}
          <strong>{focus.title}</strong>
          {focus.playing > 0 && <span> · {focus.playing} inside</span>}
        </div>
      )}

      {journey && person && (
        <>
          <Suspense fallback={null}>
            <CreationHost
              onRemoved={removedFromGroup}
              opened={journey.opened}
              mode={journey.mode}
              me={person}
              // Back from linking an account: at the creation's object, offered to go in again.
              {...(journey.creation.objectKey
                ? {
                    linkReturnTo: `/space/${spaceId}?${new URLSearchParams({ object: journey.creation.objectKey })}`,
                  }
                : {})}
              tier={pickQuality()}
              leaving={journey.leaving}
              onProgress={(value) => setPassage((p) => ({ ...p, progress: value }))}
              onReady={() => void revealCreation()}
              onLeft={() => void creationLeft()}
              onToast={setNotice}
              onPerf={(p) => {
                creationPerf.current = p;
              }}
              onSession={(pass) => setSessionVoice((v) => ({ n: (v?.n ?? 0) + 1, pass }))}
              duck={voice.speaking.length > 0 ? 0.35 : 1}
              onOutdated={() => {
                // Only worth rejoining if a newer version is live (not after going back to an
                // older one, which can't use what the newer one saved).
                const opened = journey.opened.creation;
                listCreations(spaceId ?? '').then(
                  (list) => {
                    const now = list.find((c) => c.id === opened.id);
                    if (now && now.version > opened.version) setOutdated(true);
                    else
                      setNotice(
                        `Some of what's saved came from a newer ${opened.title}, so it can't be changed here.`,
                      );
                  },
                  () => {},
                );
              }}
            />
          </Suspense>
          <CreationMenu label="Menu" attention={chat.totalUnread > 0 || voice.speaking.length > 0}>
            <button
              type="button"
              className="creation-menu-item"
              onClick={() => {
                beginLeaving();
                setJourney((j) => (j ? { ...j, leaving: true } : j));
              }}
              disabled={journey.leaving}
            >
              <Icon name="back" />
              Back to {room?.name ?? 'the space'}
            </button>
            <button
              type="button"
              className="creation-menu-item"
              onClick={() => (chatOpen ? closeChat() : openChat())}
              aria-label={`${chatOpen ? 'Close chat' : 'Chat'}${chat.totalUnread ? `: ${chat.totalUnread} unread` : ''}`}
              aria-expanded={chatOpen}
            >
              <Icon name="chat" />
              {chatOpen ? 'Close chat' : 'Chat'}
              {chat.totalUnread > 0 && (
                <span className="creation-menu-count">
                  {chat.totalUnread > 99 ? '99+' : chat.totalUnread}
                </span>
              )}
            </button>
            {journey.opened.voice && (
              <div data-keep-open>
                <VoiceButton voice={voice} />
              </div>
            )}
          </CreationMenu>
        </>
      )}

      {journey && outdated && !journey.leaving && (
        <RejoinCard
          title={journey.creation.title}
          onNotNow={() => setOutdated(false)}
          onRejoin={() => {
            rejoinAfter.current = { creation: journey.creation, mode: journey.mode };
            beginLeaving();
            setJourney((j) => (j ? { ...j, leaving: true } : j));
          }}
        />
      )}

      {reviewing && !journey && (
        <div className="space-draft" role="status">
          A draft, only for Architects. Publish it from the Studio when it looks right.
        </div>
      )}

      <Passage phase={passage.phase} title={passage.title} progress={passage.progress} />

      {picker && (
        <ModePicker
          creation={picker}
          where={(() => {
            const room = manifest?.rooms.find((r) =>
              r.objects.some((o) => o.key === picker.objectKey),
            );
            const label = picker.objectKey ? labelOf(picker.objectKey) : null;
            return room ? [label, room.name].filter(Boolean).join(' · ') : null;
          })()}
          onPick={(mode) => void enter(picker, mode)}
          onClose={() => setPicker(null)}
          onAsk={
            reviewing || !manifest
              ? undefined
              : (kind) => {
                  const room = manifest.rooms.find((r) =>
                    r.objects.some((o) => o.key === picker.objectKey),
                  );
                  if (!room) return;
                  setAsk({
                    start: {
                      kind,
                      creation: picker,
                      label: picker.objectKey ? labelOf(picker.objectKey) : null,
                      roomKey: room.key,
                      roomName: room.name,
                    },
                  });
                }
          }
        />
      )}

      {ask && manifest && spaceId && (
        <AskFlow
          viewer={viewerRef}
          spaceId={spaceId}
          manifest={manifest}
          byObject={byObject}
          requested={requested}
          {...(ask.start ? { start: ask.start } : {})}
          onClose={() => setAsk(null)}
          onDone={(message) => {
            setAsk(null);
            setNotice(message);
            objectRequests(spaceId).then(setRequested, () => {});
          }}
        />
      )}

      {notice && (
        <div className="chat-toast" role="status">
          {notice}
        </div>
      )}

      {alert && !notice && !journey && (
        <button
          type="button"
          className="chat-toast"
          onClick={() => {
            void notifications.markRead([alert.id]);
            setAlert(null);
            if (alert.url) navigate(alert.url);
          }}
        >
          <strong>{alert.title}</strong>
          {alert.body ? ` · ${alert.body}` : ''}
        </button>
      )}

      {notificationsOpen && <NotificationSheet onClose={() => setNotificationsOpen(false)} />}

      {toast && !chatOpen && (
        <button type="button" className="chat-toast" onClick={() => openChat(toast.channel)}>
          <strong>{toast.senderName}</strong>
          {toast.channel.startsWith('dm:') ? ' (to you)' : ''}: {toast.body}
        </button>
      )}

      {chatOpen && spaceId && (
        <ChatPanel
          chat={chat}
          spaceId={spaceId}
          room={room ? { key: room.key, name: room.name } : null}
          channel={chatChannel}
          onClose={closeChat}
        />
      )}

      {peopleOpen && manifest && (
        <PeopleSheet
          people={people}
          reconnecting={live === 'reconnecting'}
          manifest={manifest}
          chatPeople={chat.state?.people ?? []}
          myId={chat.state?.me.id ?? null}
          speaking={voice.speaking}
          onGoTo={(roomKey) => viewerRef.current?.travelTo(roomKey)}
          onMessage={(userId) => {
            const myId = chat.state?.me.id;
            if (myId) openChat(dmChannel(myId, userId));
          }}
          onClose={() => setPeopleOpen(false)}
        />
      )}

      {sheet === 'rooms' && manifest && (
        <TravelMenu viewer={viewerRef} onClose={() => setSheet(null)} />
      )}
      {sheet === 'settings' && (
        <SpaceSettings
          sound={soundPrefs}
          onSound={(prefs) => sound.setPrefs(prefs)}
          showPerf={showPerf}
          onTogglePerf={() => setShowPerf((v) => !v)}
          onClose={() => setSheet(null)}
        />
      )}
    </div>
  );
}

/** A newer version of the creation you're in is live: rejoin it, or carry on. */
export function RejoinCard({
  title,
  onNotNow,
  onRejoin,
}: {
  title: string;
  onNotNow: () => void;
  onRejoin: () => void;
}) {
  const dialog = useModal();
  return (
    <dialog
      ref={dialog}
      className="creation-rejoin"
      onClose={onNotNow}
      aria-label="A newer version is here"
    >
      <p>
        <strong>{title}</strong> has been updated. Rejoin to carry on with the new version — nothing
        you've saved is lost.
      </p>
      <div className="creation-rejoin-actions">
        <button
          type="button"
          className="ats-button ats-button--ghost"
          onClick={() => dialog.current?.close()}
        >
          Not now
        </button>
        <button type="button" className="ats-button ats-button--primary" onClick={onRejoin}>
          Rejoin
        </button>
      </div>
    </dialog>
  );
}
