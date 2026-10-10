import type { SpaceManifest } from '@ats/space-format';
import { Button, Icon, IconButton, Notice, Segmented } from '@ats/ui';
import type { SpaceViewer } from '@ats/viewer-core';
import { type RefObject, useEffect, useId, useRef, useState } from 'react';
import type { CreationInfo } from '../lib/creations.ts';
import {
  addDocument,
  addPicture,
  askFor,
  MAX_DOCUMENT_CHARS,
  MAX_PROMPT_CHARS,
  type ObjectRequests,
  type RequestKind,
  titleFrom,
} from '../lib/requests.ts';
import { SketchPad } from './SketchPad.tsx';
import './ask.css';

/** What the request is about. */
export type AskTarget =
  | { kind: 'new'; objectKey: string; label: string; roomKey: string; roomName: string }
  | { kind: 'new'; objectKey: null; label: null; roomKey: string; roomName: string }
  | {
      kind: 'improve' | 'bug';
      creation: CreationInfo;
      label: string | null;
      roomKey: string;
      roomName: string;
    };

type Box = { left: number; top: number; width: number; height: number };

const MAX_PHOTOS = 3;
const MAX_DOCUMENTS = 3;
/** What the document picker offers: Markdown, or plain text. */
const DOCUMENT_TYPES = '.md,.markdown,.txt,text/markdown,text/plain';
/** Counts documents picked, to tell them apart in the list (even two of the same name). */
let documentsPicked = 0;

/**
 * Asking for something: draw a box around it (or tap it), say which thing you meant if the box
 * caught several, then say what you'd like. Only writes a request: an Architect takes it from
 * there.
 */
export function AskFlow({
  viewer,
  spaceId,
  manifest,
  byObject,
  requested,
  start,
  onDone,
  onClose,
}: {
  viewer: RefObject<SpaceViewer | null>;
  spaceId: string;
  manifest: SpaceManifest;
  byObject: Map<string, CreationInfo>;
  requested: ObjectRequests;
  /** Straight to writing (a change to, or a problem with, a creation). */
  start?: AskTarget;
  onDone: (message: string) => void;
  onClose: () => void;
}) {
  const [stage, setStage] = useState<'select' | 'which' | 'write'>(start ? 'write' : 'select');
  const [candidates, setCandidates] = useState<string[]>([]);
  const [target, setTarget] = useState<AskTarget | null>(start ?? null);
  const [snapshot, setSnapshot] = useState<Blob | null>(null);

  const roomOf = (key: string) => manifest.rooms.find((r) => r.objects.some((o) => o.key === key));
  const here = () => viewer.current?.currentRoom ?? manifest.rooms[0] ?? null;

  const targetFor = (key: string | null): AskTarget | null => {
    if (!key) {
      const room = here();
      return room
        ? { kind: 'new', objectKey: null, label: null, roomKey: room.key, roomName: room.name }
        : null;
    }
    const room = roomOf(key);
    const label = room?.objects.find((o) => o.key === key)?.label ?? key;
    if (!room) return null;
    const creation = byObject.get(key);
    return creation
      ? { kind: 'improve', creation, label, roomKey: room.key, roomName: room.name }
      : { kind: 'new', objectKey: key, label, roomKey: room.key, roomName: room.name };
  };

  const selected = async (box: Box) => {
    const v = viewer.current;
    if (!v) return;
    const tap = box.width < 14 && box.height < 14;
    const keys = tap
      ? [v.pickObject(box.left + box.width / 2, box.top + box.height / 2)].filter(
          (k): k is string => Boolean(k),
        )
      : v.objectsInBox(box);
    const around = tap ? { left: box.left - 90, top: box.top - 90, width: 180, height: 180 } : box;
    setSnapshot(await v.snapshot(around).catch(() => null));
    setCandidates(keys.slice(0, 6));
    if (keys.length === 1) {
      setTarget(targetFor(keys[0] as string));
      setStage('write');
    } else setStage('which');
  };

  if (stage === 'select') return <BoxSelect onBox={(b) => void selected(b)} onCancel={onClose} />;

  if (stage === 'which') {
    const room = here();
    return (
      <Sheet label="Which one?" onClose={onClose}>
        <h2>{candidates.length ? 'Which one did you mean?' : 'Nothing to pick there'}</h2>
        {candidates.length === 0 && (
          <p className="ats-muted">
            That box didn't catch anything that can be picked. Try again, closer, or ask for
            something new{room ? ` in the ${room.name.toLowerCase()}` : ''}.
          </p>
        )}
        <div className="ats-stack" style={{ gap: 8 }}>
          {candidates.map((key) => {
            const t = targetFor(key);
            if (!t) return null;
            const holds = byObject.get(key);
            const state = requested[key];
            return (
              <Button
                key={key}
                block
                onClick={() => {
                  setTarget(t);
                  setStage('write');
                }}
              >
                {t.label}
                <span className="ask-aside">
                  {holds
                    ? ` · holds ${holds.title}`
                    : state
                      ? ` · ${state.state === 'building' ? 'being built' : 'already asked for'}`
                      : ''}
                </span>
              </Button>
            );
          })}
          {room && (
            <Button
              block
              variant={candidates.length ? 'ghost' : 'primary'}
              onClick={() => {
                setTarget(targetFor(null));
                setStage('write');
              }}
            >
              <Icon name="plus" size={16} />
              Something new, not here yet
            </Button>
          )}
          <Button variant="ghost" onClick={() => setStage('select')}>
            <Icon name="boxSelect" size={16} />
            Draw again
          </Button>
        </div>
      </Sheet>
    );
  }

  if (!target) return null;
  return (
    <WriteRequest
      spaceId={spaceId}
      target={target}
      setTarget={setTarget}
      snapshot={snapshot}
      requested={
        target.kind === 'new' && target.objectKey ? requested[target.objectKey] : undefined
      }
      onDone={onDone}
      onClose={onClose}
    />
  );
}

/** What's in the middle of the view, as a tap there (for keyboards, and without drawing). */
const middle = (): Box => ({
  left: window.innerWidth / 2 - 1,
  top: window.innerHeight / 2 - 1,
  width: 2,
  height: 2,
});

/** Draw a box (drag) or tap, over the space; or pick what's in the middle of the view. */
function BoxSelect({ onBox, onCancel }: { onBox: (box: Box) => void; onCancel: () => void }) {
  const [box, setBox] = useState<Box | null>(null);
  const from = useRef<{ x: number; y: number; id: number } | null>(null);
  const first = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLDivElement>(null);
  // Keyboard focus starts here, so the overlay can be used without a pointer; everything behind
  // it is out of reach meanwhile (as for a modal dialog).
  useEffect(() => {
    first.current?.focus();
    const behind: Element[] = [];
    for (let el: Element | null = root.current; el?.parentElement; el = el.parentElement)
      for (const sibling of el.parentElement.children)
        if (sibling !== el && !sibling.hasAttribute('inert')) {
          sibling.setAttribute('inert', '');
          behind.push(sibling);
        }
    return () => {
      for (const el of behind) el.removeAttribute('inert');
    };
  }, []);
  useEffect(() => {
    if (document.pointerLockElement) document.exitPointerLock();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      if (e.key === 'Enter' && (e.target as Element | null)?.tagName !== 'BUTTON') onBox(middle());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, onBox]);
  const rectOf = (x: number, y: number): Box => {
    const f = from.current as { x: number; y: number };
    return {
      left: Math.min(f.x, x),
      top: Math.min(f.y, y),
      width: Math.abs(x - f.x),
      height: Math.abs(y - f.y),
    };
  };
  return (
    <div
      ref={root}
      className="ask-select"
      role="application"
      aria-label="Draw a box around something, or tap it"
      onPointerDown={(e) => {
        if (from.current) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        from.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
        setBox({ left: e.clientX, top: e.clientY, width: 0, height: 0 });
      }}
      onPointerMove={(e) => {
        if (from.current?.id === e.pointerId) setBox(rectOf(e.clientX, e.clientY));
      }}
      onPointerUp={(e) => {
        if (from.current?.id !== e.pointerId) return;
        const b = rectOf(e.clientX, e.clientY);
        from.current = null;
        setBox(null);
        onBox(b);
      }}
      onPointerCancel={() => {
        from.current = null;
        setBox(null);
      }}
    >
      <div className="ask-select-tip" onPointerDown={(e) => e.stopPropagation()}>
        <span>Draw a box around something, or tap it</span>
        <button
          type="button"
          className="ats-button ats-button--ghost"
          onClick={() => onBox(middle())}
          ref={first}
        >
          <Icon name="crosshair" size={16} />
          What's in the middle
        </button>
        <IconButton icon="close" label="Cancel" onClick={onCancel} />
      </div>
      {box && (
        <div
          className="ask-box"
          style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
        />
      )}
    </div>
  );
}

function Sheet({
  label,
  onClose,
  children,
}: {
  label: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog ref={dialog} className="ats-sheet ask-sheet" onClose={onClose} aria-label={label}>
      <div className="ats-stack">{children}</div>
    </dialog>
  );
}

const PROMPTS: Record<RequestKind, { question: string; hint: string; send: string }> = {
  new: {
    question: 'What would you like it to become?',
    hint: 'A game, a place to explore, a toy, a journal… anything. Say it in your own words.',
    send: 'Send to the Architects',
  },
  improve: {
    question: 'What would you change?',
    hint: 'What you’d add, take away or do differently.',
    send: 'Suggest it',
  },
  bug: {
    question: 'What went wrong?',
    hint: 'What you were doing, what happened, and what you expected. Which device helps too.',
    send: 'Report it',
  },
};

function WriteRequest({
  spaceId,
  target,
  setTarget,
  snapshot,
  requested,
  onDone,
  onClose,
}: {
  spaceId: string;
  target: AskTarget;
  setTarget: (t: AskTarget) => void;
  snapshot: Blob | null;
  requested?: { state: 'requested' | 'building'; mine: boolean } | undefined;
  onDone: (message: string) => void;
  onClose: () => void;
}) {
  const ids = { prompt: useId(), title: useId(), photos: useId(), documents: useId() };
  const [prompt, setPrompt] = useState('');
  const [title, setTitle] = useState('');
  const [withSnapshot, setWithSnapshot] = useState(Boolean(snapshot));
  const [photos, setPhotos] = useState<File[]>([]);
  const [documents, setDocuments] = useState<{ key: string; file: string; text: string }[]>([]);
  const [sketch, setSketch] = useState<Blob | null>(null);
  const [sketching, setSketching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const text = PROMPTS[target.kind];
  const urls = useObjectUrls([snapshot, sketch, ...photos]);

  /** Reads the documents picked, keeping those that are text and not too long. */
  const pickDocuments = async (files: File[]) => {
    const picked: { key: string; file: string; text: string }[] = [];
    const refused: string[] = [];
    for (const f of files) {
      if (!/\.(md|markdown|txt)$/i.test(f.name)) {
        refused.push(`${f.name} isn’t a Markdown or text file.`);
        continue;
      }
      const text = (await f.text()).replace(/^\uFEFF/, '');
      if (text.length > MAX_DOCUMENT_CHARS)
        refused.push(
          `${f.name} is too long: a document can be up to ${MAX_DOCUMENT_CHARS.toLocaleString()} characters.`,
        );
      else if (!text.trim() || text.includes('\0'))
        refused.push(`${f.name} isn’t a Markdown or text file.`);
      else picked.push({ key: `${f.name}-${++documentsPicked}`, file: f.name, text });
    }
    setDocuments((had) => [...had, ...picked].slice(0, MAX_DOCUMENTS));
    setError(refused.length ? refused.join(' ') : null);
  };

  const what =
    target.kind === 'new'
      ? target.label
        ? `${target.label} · ${target.roomName}`
        : `Something new · ${target.roomName}`
      : `${target.creation.title} · ${target.label ?? target.roomName}`;

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { id } = await askFor(spaceId, {
        kind: target.kind,
        ...(target.kind === 'new'
          ? target.objectKey
            ? { objectKey: target.objectKey }
            : { roomKey: target.roomKey }
          : { creationId: target.creation.id }),
        title: title.trim() || titleFrom(prompt),
        prompt,
      });
      // Documents and pictures follow; the request stands even if one of them doesn't make it.
      const failed: string[] = [];
      for (const [i, d] of documents.entries())
        await addDocument(id, `doc-${i + 1}`, d.file, d.text).catch(() => failed.push(d.file));
      const upload = (name: string, blob: Blob) =>
        addPicture(id, name, blob).catch(() => failed.push(name));
      if (withSnapshot && snapshot) await upload('snapshot', snapshot);
      if (sketch) await upload('sketch', sketch);
      for (const [i, p] of photos.entries()) await upload(`image-${i + 1}`, p);
      onDone(
        failed.length
          ? 'Sent, but a document or picture didn’t make it. Follow it in My requests.'
          : 'Sent. You can follow it in My requests.',
      );
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  if (sketching)
    return (
      <SketchPad
        onDone={(blob) => {
          if (blob) setSketch(blob);
          setSketching(false);
        }}
      />
    );

  return (
    <Sheet
      label={
        target.kind === 'bug'
          ? 'Say what’s wrong'
          : target.kind === 'improve'
            ? 'Suggest a change'
            : 'Ask for something'
      }
      onClose={onClose}
    >
      <form className="ats-stack" onSubmit={(e) => void send(e)}>
        <div className="ask-what">
          {withSnapshot && urls[0] && <img src={urls[0]} alt="What you picked" />}
          <div>
            <span className="ats-muted ask-small">
              {target.kind === 'bug'
                ? 'Something’s wrong with'
                : target.kind === 'improve'
                  ? 'A change to'
                  : 'Asking for'}
            </span>
            <strong>{what}</strong>
          </div>
        </div>
        {(target.kind === 'improve' || target.kind === 'bug') && (
          <div className="ask-kinds">
            <Segmented
              label="What kind of request"
              value={target.kind}
              onChange={(kind) => setTarget({ ...target, kind })}
              options={[
                { value: 'improve', label: 'Suggest a change', icon: 'edit' },
                { value: 'bug', label: 'Something’s wrong', icon: 'alert' },
              ]}
            />
          </div>
        )}
        {requested && (
          <Notice>
            {requested.mine
              ? 'You’ve already asked for something here. This adds another request.'
              : requested.state === 'building'
                ? 'Something is already being built here. Your idea goes to the Architects too.'
                : 'Someone has already asked for something here. Your idea goes to the Architects too.'}
          </Notice>
        )}
        <div className="ats-field">
          <label htmlFor={ids.prompt}>{text.question}</label>
          <textarea
            id={ids.prompt}
            className="ats-input ask-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            required
            maxLength={MAX_PROMPT_CHARS}
            rows={5}
            // biome-ignore lint/a11y/noAutofocus: the one thing to do in this sheet
            autoFocus
          />
          <span className="ats-hint">
            {text.hint}
            {prompt.length > MAX_PROMPT_CHARS * 0.8 &&
              ` ${prompt.length.toLocaleString()} of ${MAX_PROMPT_CHARS.toLocaleString()} characters: a longer plan can go in a document below.`}
          </span>
        </div>
        <div className="ats-field">
          <label htmlFor={ids.title}>A name for it (optional)</label>
          <input
            id={ids.title}
            className="ats-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={80}
            placeholder={prompt ? titleFrom(prompt) : ''}
          />
        </div>

        <div className="ask-pictures">
          {snapshot && (
            <label className="ask-check">
              <input
                type="checkbox"
                checked={withSnapshot}
                onChange={(e) => setWithSnapshot(e.target.checked)}
              />
              Include the picture of what I picked
            </label>
          )}
          <div className="ask-thumbs">
            {sketch && urls[1] && (
              <figure>
                <img src={urls[1]} alt="Your sketch" />
                <button
                  type="button"
                  onClick={() => setSketch(null)}
                  aria-label="Remove the sketch"
                >
                  <Icon name="close" size={14} />
                </button>
              </figure>
            )}
            {photos.map((p, i) =>
              urls[i + 2] ? (
                <figure key={`${p.name}-${p.lastModified}`}>
                  <img
                    src={urls[i + 2] ?? undefined}
                    alt={`What you added (${i + 1})`}
                    // Some browsers can't show iPhone (HEIC) photos: it's still sent, and works.
                    onError={(e) => {
                      e.currentTarget.dataset.unshown = 'true';
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => setPhotos(photos.filter((x) => x !== p))}
                    aria-label={`Remove picture ${i + 1}`}
                  >
                    <Icon name="close" size={14} />
                  </button>
                </figure>
              ) : null,
            )}
          </div>
          {documents.length > 0 && (
            <ul className="ask-documents">
              {documents.map((d) => (
                <li key={d.key}>
                  <span>{d.file}</span>
                  <button
                    type="button"
                    onClick={() => setDocuments(documents.filter((x) => x !== d))}
                    aria-label={`Remove ${d.file}`}
                  >
                    <Icon name="close" size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="ats-row" style={{ gap: 8, flexWrap: 'wrap' }}>
            {photos.length < MAX_PHOTOS && (
              <label className="ats-button ats-button--ghost ask-file" htmlFor={ids.photos}>
                <Icon name="camera" size={16} />
                Add a picture
                <input
                  id={ids.photos}
                  type="file"
                  accept="image/*,.heic,.heif"
                  multiple
                  onChange={(e) => {
                    const files = [...(e.target.files ?? [])].filter(
                      (f) => f.type.startsWith('image/') || /\.hei[cf]$/i.test(f.name),
                    );
                    setPhotos([...photos, ...files].slice(0, MAX_PHOTOS));
                    e.target.value = '';
                  }}
                />
              </label>
            )}
            <Button type="button" variant="ghost" onClick={() => setSketching(true)}>
              <Icon name="sketch" size={16} />
              {sketch ? 'Draw it again' : 'Draw a sketch'}
            </Button>
            {documents.length < MAX_DOCUMENTS && (
              <label className="ats-button ats-button--ghost ask-file" htmlFor={ids.documents}>
                <Icon name="upload" size={16} />
                Attach a document
                <input
                  id={ids.documents}
                  type="file"
                  accept={DOCUMENT_TYPES}
                  multiple
                  onChange={(e) => {
                    void pickDocuments([...(e.target.files ?? [])]);
                    e.target.value = '';
                  }}
                />
              </label>
            )}
          </div>
          <span className="ats-hint">
            A document can be a Markdown (.md) or text file with your whole plan, up to{' '}
            {MAX_DOCUMENT_CHARS.toLocaleString()} characters. Only you and the Architects see these.
            Nothing in them is shown in the space.
          </span>
        </div>

        {error && <Notice tone="error">{error}</Notice>}
        <div className="ats-stack" style={{ gap: 8 }}>
          <Button variant="primary" block type="submit" disabled={busy || !prompt.trim()}>
            <Icon name="send" size={16} />
            {busy ? 'Sending…' : text.send}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            Not now
          </Button>
        </div>
        <p className="ats-muted ask-small">
          An Architect reads it and decides what to build. You'll hear when it moves on.
        </p>
      </form>
    </Sheet>
  );
}

/** Object URLs for blobs (for showing them), revoked when they change. */
function useObjectUrls(blobs: (Blob | null)[]) {
  const [urls, setUrls] = useState<(string | null)[]>([]);
  const key = blobs.map((b) => (b ? `${b.size}:${b.type}` : '-')).join('|');
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the blobs themselves
  useEffect(() => {
    const made = blobs.map((b) => (b ? URL.createObjectURL(b) : null));
    setUrls(made);
    return () => {
      for (const u of made) if (u) URL.revokeObjectURL(u);
    };
  }, [key]);
  return urls;
}
