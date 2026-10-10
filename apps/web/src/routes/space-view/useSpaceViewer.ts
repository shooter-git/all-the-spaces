import type { Link, Room, SpaceManifest } from '@ats/space-format';
import { SpaceViewer } from '@ats/viewer-core';
import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { ApiError, api } from '../../lib/api.ts';
import { sound } from '../../lib/sound.ts';
import { pickQuality } from './quality.ts';

/**
 * How long a space may go without loading any more of itself, while it opens, before it says
 * something's wrong. A big place on a slow connection can take longer than this in all.
 */
export const OPEN_TIMEOUT_MS = 45_000;
const LOAD_FAILED = "Part of this space couldn't be loaded. Check you're online and try again.";
const TOO_SLOW = "This space is taking too long to open. Check you're online and try again.";

/**
 * Opening the space: reads its manifest, says so if it never finishes opening, and starts the 3D
 * view (and lets it go, keeping where you stood, when it's released or the space reloads).
 */
export function useSpaceViewer({
  spaceBase,
  touch,
  released,
  host,
  viewerRef,
  readyWaiters,
  manifest,
  setManifest,
}: {
  spaceBase: string;
  touch: boolean;
  /** On phones the 3D view is let go while you're in a creation. */
  released: boolean;
  host: RefObject<HTMLDivElement | null>;
  viewerRef: RefObject<SpaceViewer | null>;
  /** Called (and emptied) each time the view is ready. */
  readyWaiters: RefObject<(() => void)[]>;
  manifest: SpaceManifest | null;
  setManifest: Dispatch<SetStateAction<SpaceManifest | null>>;
}) {
  /** Why the space can't be shown, and whether trying again might help. */
  const [error, setError] = useState<{ message: string; retry: boolean } | null>(null);
  const [ready, setReady] = useState(false);
  /** How much of the place has loaded while it opens (0 to 1), once it's started. */
  const [progress, setProgress] = useState<number | null>(null);
  const [room, setRoom] = useState<Room | null>(null);
  const [lift, setLift] = useState<{ link: Link; stop: number } | null>(null);
  const [locked, setLocked] = useState(false);

  /** Where to carry on from when the space reloads (after a privacy change). */
  const resumeAt = useRef<{ x: number; y: number; z: number; yaw: number; room: string } | null>(
    null,
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: setManifest is a state setter (stable)
  const loadManifest = useCallback(() => {
    api<SpaceManifest>(`${spaceBase}manifest`).then(setManifest, (e: Error) =>
      setError({
        message: e.message,
        retry: !(e instanceof ApiError) || e.status === 0 || e.status >= 500,
      }),
    );
  }, [spaceBase]);
  useEffect(loadManifest, [loadManifest]);
  const tryAgain = () => {
    setManifest(null);
    setError(null);
    loadManifest();
  };

  // A space that stops getting any further while it opens (a room that won't load, a stalled
  // connection) says so. Each bit of progress starts the wait again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: progress restarts the wait
  useEffect(() => {
    if (ready || released || error) return;
    const t = window.setTimeout(
      () => setError({ message: TOO_SLOW, retry: true }),
      OPEN_TIMEOUT_MS,
    );
    return () => window.clearTimeout(t);
  }, [ready, released, error, progress]);

  const failed = error !== null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: host, viewerRef and readyWaiters are refs (stable)
  useEffect(() => {
    if (!manifest || !host.current || released || failed) return;
    let viewer: SpaceViewer;
    try {
      viewer = new SpaceViewer(host.current, {
        manifest,
        baseUrl: new URL(spaceBase, window.location.origin).toString(),
        quality: pickQuality(),
        touch,
        audio: sound.out(),
        soundsUrl: new URL('/audio/', window.location.origin).toString(),
        // Carry on from the same spot after a reload (or coming back from a creation).
        ...(resumeAt.current
          ? {
              start: {
                position: [resumeAt.current.x, resumeAt.current.y, resumeAt.current.z],
                yaw: resumeAt.current.yaw,
                roomKey: resumeAt.current.room,
              },
            }
          : {}),
      });
    } catch (err) {
      console.error('Could not start the 3D view:', err);
      setError({
        message:
          "This device couldn't start 3D graphics. Try another browser, or turn on hardware acceleration in your browser's settings.",
        retry: false,
      });
      return;
    }
    resumeAt.current = null;
    viewer.onReady = () => {
      setReady(true);
      for (const r of readyWaiters.current.splice(0)) r();
    };
    viewer.onProgress = setProgress;
    viewer.onError = () => setError({ message: LOAD_FAILED, retry: true });
    viewer.onRoomChange = setRoom;
    setRoom(viewer.currentRoom); // the starting room was chosen before we started listening
    viewer.onLift = (link, stop) => setLift(link ? { link, stop } : null);
    viewer.input.onPointerLockChange = setLocked;
    viewerRef.current = viewer;
    // Expose for automated checks (performance budgets, end-to-end tests).
    (window as unknown as { __atsViewer?: SpaceViewer }).__atsViewer = viewer;
    return () => {
      const p = viewer.pose();
      if (p.roomKey) resumeAt.current = { x: p.x, y: p.y, z: p.z, yaw: p.yaw, room: p.roomKey };
      viewer.dispose();
      viewerRef.current = null;
      setReady(false);
      setProgress(null);
    };
  }, [manifest, touch, released, spaceBase, failed]);

  return { error, ready, progress, room, lift, locked, loadManifest, tryAgain };
}
