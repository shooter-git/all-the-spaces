import { PROTOCOL_VERSION } from '@allthespaces/bridge-protocol';
import { Icon, IconButton, Spinner } from '@ats/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CreationHost } from '../../components/CreationHost.tsx';
import { Pictures } from '../../components/Pictures.tsx';
import type { Me } from '../../lib/api.ts';
import { asPerson, type OpenedCreation } from '../../lib/creations.ts';
import { type AssistantPicture, loadPictures, loadPreview } from '../../lib/workbench.ts';

/** A creation that hasn't said it's ready by now is shown as it is, veil or not. */
const READY_WITHIN_MS = 20_000;

/** The live preview: the latest build, played in the same sealed frame people will use. */
export function Preview({
  workspaceId,
  title,
  me,
}: {
  workspaceId: string;
  title: string;
  me: Me;
}) {
  const [state, setState] = useState<Awaited<ReturnType<typeof loadPreview>> | null>(null);
  const [device, setDevice] = useState<'phone' | 'laptop'>(
    matchMedia('(max-width: 900px)').matches ? 'laptop' : 'phone',
  );
  // The phone on its side: how most games are played.
  const [turned, setTurned] = useState(false);
  const person = useMemo(() => asPerson(me), [me]);
  const [reloads, setReloads] = useState(0);
  // The assistant's model previews, instead of the live creation (which keeps running behind).
  const [showPictures, setShowPictures] = useState(false);
  const [pictures, setPictures] = useState<AssistantPicture[] | null>(null);
  useEffect(() => {
    if (!showPictures) return;
    const look = () =>
      loadPictures(workspaceId).then(
        (r) => setPictures(r.pictures),
        () => {},
      );
    void look();
    const t = setInterval(look, 10_000);
    return () => clearInterval(t);
  }, [showPictures, workspaceId]);
  const stamp = useRef(0);
  useEffect(() => {
    let live = true;
    const poll = () =>
      loadPreview(workspaceId).then(
        (s) => {
          if (!live) return;
          // Only swap in a new build when there is one (a stable URL keeps the frame steady).
          if (s.state !== 'ready' || s.stamp !== stamp.current) {
            stamp.current = s.stamp ?? 0;
            setState(s);
          }
        },
        () => {},
      );
    void poll();
    const t = setInterval(poll, 2000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [workspaceId]);
  // The same object until there's a new build: a new one would restart the creation.
  const opened = useMemo<OpenedCreation | null>(
    () =>
      state?.state === 'ready' && state.url
        ? {
            creation: {
              id: 'preview',
              title,
              version: state.stamp ?? 0,
              versionId: 'preview',
              protocolVersion: PROTOCOL_VERSION,
              defaultMode: 'solo',
              saveVersion: null,
            },
            url: state.url,
            playOrigin: new URL(state.url).origin,
            ticket: '',
            trial: true,
          }
        : null,
    [state, title],
  );
  // How far the creation in the frame has loaded (it says, through the SDK), until it's ready.
  // A new build or a reload is a new creation: `key` tells them apart.
  const key = opened ? `${opened.url}-${reloads}` : '';
  const [load, setLoad] = useState({ key, progress: 0, label: '', ready: false, slow: false });
  useEffect(() => {
    if (!key) return;
    setLoad({ key, progress: 0, label: '', ready: false, slow: false });
    const t = setTimeout(
      () => setLoad((l) => (l.key === key && !l.ready ? { ...l, slow: true } : l)),
      READY_WITHIN_MS,
    );
    return () => clearTimeout(t);
  }, [key]);
  const current = load.key === key ? load : { progress: 0, label: '', ready: false, slow: false };
  const loading = Boolean(opened) && !current.ready && !current.slow;
  // Over the screen while there's nothing to see yet (not when the build failed: that shows).
  const veil = opened
    ? loading
      ? current.label || (reloads > 0 ? 'Reloading the preview…' : 'Loading the preview…')
      : null
    : !state || state.state === 'off'
      ? 'Starting the preview…'
      : state.state === 'building'
        ? 'Building…'
        : null;
  return (
    <div className="preview">
      <div className="preview-bar">
        <span className="studio-small preview-status" aria-live="polite">
          {(!state || state.state === 'off' || state.state === 'building' || loading) && (
            <Spinner />
          )}
          {!state || state.state === 'off'
            ? 'Starting the preview…'
            : state.state === 'building'
              ? 'Building…'
              : state.state === 'error'
                ? 'The last change didn’t build'
                : `${loading ? 'Loading' : 'Up to date'} · build ${state.stamp}${
                    current.slow ? ' · it hasn’t said it’s ready yet' : ''
                  }`}
        </span>
        <div className="studio-actions-row">
          <fieldset className="preview-devices">
            <legend className="visually-hidden">Show</legend>
            <button
              type="button"
              aria-pressed={!showPictures}
              onClick={() => setShowPictures(false)}
            >
              <Icon name="play" size={16} />
              Live
            </button>
            <button type="button" aria-pressed={showPictures} onClick={() => setShowPictures(true)}>
              <Icon name="image" size={16} />
              Pictures
            </button>
          </fieldset>
          <fieldset className="preview-devices" hidden={showPictures}>
            <legend className="visually-hidden">Screen</legend>
            {(['phone', 'laptop'] as const).map((d) => (
              <button
                key={d}
                type="button"
                aria-pressed={device === d}
                onClick={() => setDevice(d)}
              >
                <Icon name={d} size={16} />
                {d === 'phone' ? 'Phone' : 'Laptop'}
              </button>
            ))}
          </fieldset>
          {device === 'phone' && !showPictures && (
            <IconButton
              icon="rotate"
              label="Phone on its side"
              aria-pressed={turned}
              onClick={() => setTurned((t) => !t)}
            />
          )}
          <IconButton
            icon="refresh"
            label="Reload the preview"
            onClick={() => setReloads((n) => n + 1)}
            busy={loading}
          />
        </div>
      </div>
      {state?.state === 'error' && <pre className="studio-log preview-error">{state.error}</pre>}
      {showPictures && (
        <div className="plan-view plan-view--pictures">
          <Pictures workspaceId={workspaceId} pictures={pictures} />
        </div>
      )}
      <div
        className="preview-stage"
        data-device={device}
        data-turned={device === 'phone' && turned}
        hidden={showPictures}
      >
        <div className="preview-screen">
          {opened && person && (
            <CreationHost
              key={`${opened.url}-${reloads}`}
              opened={opened}
              mode="solo"
              me={person}
              tier={device === 'phone' ? 'low' : 'mid'}
              leaving={false}
              onProgress={(progress, label) =>
                setLoad((l) => (l.key === key ? { ...l, progress, label: label ?? l.label } : l))
              }
              onReady={() => setLoad((l) => (l.key === key ? { ...l, ready: true } : l))}
              onLeft={() => setReloads((n) => n + 1)}
              onToast={() => {}}
              offline
              embedded
            />
          )}
          {veil && (
            <div className="preview-loading">
              <Spinner />
              <span>{veil}</span>
              {loading && current.progress > 0 && (
                <span className="preview-loading-bar">
                  <span style={{ width: `${Math.round(Math.min(1, current.progress) * 100)}%` }} />
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
