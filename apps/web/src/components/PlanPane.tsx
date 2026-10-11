import { Button, Icon, IconButton } from '@ats/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.ts';
import {
  type FloorTrace,
  inputUrl,
  type PlanProblem,
  redrawOverlay,
  savePlan,
  traceFor,
  workspaceFile,
} from '../lib/places.ts';
import { loadPictures } from '../lib/workbench.ts';
import { BuildPanel } from './BuildPanel.tsx';
import { Pictures } from './Pictures.tsx';
import '../routes/creations.css';

interface Room {
  key: string;
  name: string;
  floor: string;
  /** A stairwell: it rises to this floor too. */
  spansTo?: string;
  rect: [number, number, number, number];
}
/** The rooms drawn on a floor: its own, and stairwells rising to it. */
const onFloor = (r: Room, floor: string) => r.floor === floor || r.spansTo === floor;
interface Plan {
  floors: { key: string; name: string }[];
  rooms: Room[];
  openings: (
    | { kind: 'door' | 'open'; at: [number, number]; rooms: [string, string] }
    | { kind: 'window' }
  )[];
  [key: string]: unknown;
}

/**
 * A place's plan in its workspace: the assistant's overlay (the plan drawn over the floor plan),
 * an editor for moving walls by hand, and building, walking through and publishing it.
 */
export function PlanPane({
  workspaceId,
  spaceId,
  awake,
}: {
  workspaceId: string;
  spaceId: string;
  awake: boolean;
}) {
  const [mode, setMode] = useState<'plan' | 'edit' | 'pictures'>('plan');
  // The assistant's pictures, and whether the place has changed since its last build: looked at
  // again every few seconds while the workspace is awake.
  const [seen, setSeen] = useState<Awaited<ReturnType<typeof loadPictures>> | null>(null);
  useEffect(() => {
    const look = () => loadPictures(workspaceId).then(setSeen, () => {});
    void look();
    if (!awake) return;
    const t = setInterval(look, 10_000);
    return () => clearInterval(t);
  }, [workspaceId, awake]);
  const [stamp, setStamp] = useState(0);
  // The plan's floors (the assistant may add some), and which one is on screen.
  const [floors, setFloors] = useState<{ key: string; name: string }[]>([]);
  const [floor, setFloor] = useState<string | null>(null);
  // The overlay changes when the assistant redraws it: look again every few seconds.
  useEffect(() => {
    if (mode !== 'plan') return;
    const t = setInterval(() => setStamp((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, [mode]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-read the floors as the plan changes
  useEffect(() => {
    // Nothing yet (204) is fine: the assistant hasn't written the plan.
    api<Partial<Plan>>(`${workspaceFile(workspaceId, 'plan.json')}?ifexists=1`).then(
      (p) => setFloors(p.floors ?? []),
      () => {},
    );
  }, [workspaceId, stamp]);
  const shown = floor && floors.some((f) => f.key === floor) ? floor : (floors[0]?.key ?? null);
  const overlay =
    floors.length > 1 && shown ? `preview/overlay-${shown}.png` : 'preview/overlay.png';
  return (
    <div className="preview">
      <div className="preview-bar">
        <fieldset className="preview-devices">
          <legend className="visually-hidden">Plan</legend>
          <button type="button" aria-pressed={mode === 'plan'} onClick={() => setMode('plan')}>
            <Icon name="map" size={16} />
            Plan
          </button>
          <button type="button" aria-pressed={mode === 'edit'} onClick={() => setMode('edit')}>
            <Icon name="move" size={16} />
            Move walls
          </button>
          <button
            type="button"
            aria-pressed={mode === 'pictures'}
            onClick={() => setMode('pictures')}
          >
            <Icon name="image" size={16} />
            Pictures
            {seen?.pictures.length ? (
              <span className="pictures-count">{seen.pictures.length}</span>
            ) : null}
          </button>
        </fieldset>
        {floors.length > 1 && mode !== 'pictures' && (
          <fieldset className="preview-devices">
            <legend className="visually-hidden">Floor</legend>
            {floors.map((f) => (
              <button
                key={f.key}
                type="button"
                aria-pressed={shown === f.key}
                onClick={() => setFloor(f.key)}
              >
                {f.name}
              </button>
            ))}
          </fieldset>
        )}
        {mode === 'plan' && awake && (
          <IconButton
            icon="refresh"
            label="Draw the plan again"
            onClick={() => {
              void redrawOverlay(workspaceId).then(() => setStamp((n) => n + 1));
            }}
          />
        )}
      </div>
      {mode === 'pictures' ? (
        <div className="plan-view plan-view--pictures">
          <Pictures workspaceId={workspaceId} pictures={seen?.pictures ?? null} />
        </div>
      ) : mode === 'plan' ? (
        <div className="plan-view">
          {/* A new floor starts afresh. */}
          <OverlayImage key={overlay} src={workspaceFile(workspaceId, overlay)} stamp={stamp} />
        </div>
      ) : (
        <PlanEditor
          workspaceId={workspaceId}
          spaceId={spaceId}
          floor={shown}
          onSaved={() => {
            setStamp((n) => n + 1);
            setMode('plan');
          }}
        />
      )}
      <BuildPanel workspaceId={workspaceId} spaceId={spaceId} changed={seen?.build ?? null} />
    </div>
  );
}

/**
 * The overlay, looked at again on each `stamp`. Only a changed picture is downloaded (the server
 * answers "unchanged" by its ETag), and it's swapped in once loaded, so it never flickers.
 */
function OverlayImage({ src, stamp }: { src: string; stamp: number }) {
  const [shown, setShown] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const etag = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: look again on every stamp
  useEffect(() => {
    let cancelled = false;
    fetch(`${src}?ifexists=1`, {
      credentials: 'include',
      headers: etag.current ? { 'if-none-match': etag.current } : {},
    })
      .then(async (res) => {
        if (cancelled || res.status === 304) return;
        if (res.status === 204 || !res.ok) return setMissing(true);
        etag.current = res.headers.get('etag');
        const url = URL.createObjectURL(await res.blob());
        if (cancelled) return URL.revokeObjectURL(url);
        setMissing(false);
        setShown((old) => {
          if (old) URL.revokeObjectURL(old);
          return url;
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [src, stamp]);
  // Let go of the last picture when leaving.
  useEffect(
    () => () =>
      setShown((old) => {
        if (old) URL.revokeObjectURL(old);
        return null;
      }),
    [],
  );
  if (missing && !shown)
    return (
      <p className="ats-muted plan-empty">
        Your assistant hasn't drawn the plan yet. Ask it to start (Suggestions), and it will appear
        here.
      </p>
    );
  if (!shown) return null;
  return <img className="plan-image" src={shown} alt="The plan drawn over the floor plan" />;
}

// ---- Moving walls by hand ------------------------------------------------------------------------

const SNAP = 0.01;
/** One step of a wall moved with the keyboard or buttons (Shift: ten). */
const STEP = 0.05;
const same = (a: number, b: number) => Math.abs(a - b) < 1e-3;

function PlanEditor({
  workspaceId,
  spaceId,
  floor: chosen,
  onSaved,
}: {
  workspaceId: string;
  spaceId: string;
  floor: string | null;
  onSaved: () => void;
}) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [traces, setTraces] = useState<unknown>(null);
  const [size, setSize] = useState<[number, number] | null>(null);
  const [problems, setProblems] = useState<PlanProblem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ axis: 'x' | 'z'; from: number; now: number; start: Plan } | null>(null);
  /** The wall picked (by tap, click or keyboard) to move a step at a time: no dragging needed. */
  const [picked, setPicked] = useState<{ axis: 'x' | 'z'; at: number; name: string } | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setPlan(await api<Plan>(workspaceFile(workspaceId, 'plan.json')));
    } catch {
      setError("There's no plan to edit yet.");
    }
    setTraces(await api<unknown>(workspaceFile(workspaceId, 'trace.json')).catch(() => null));
    setDirty(false);
  }, [workspaceId]);
  useEffect(() => {
    void load();
  }, [load]);
  const firstFloor = plan?.floors[0]?.key ?? '';
  const floor = chosen ?? firstFloor;
  const trace: FloorTrace | null = plan ? traceFor(traces, floor, firstFloor) : null;
  // The drawing: a floor plan the Architect gave (inputs/plan-1.jpg), or one the assistant made
  // (an aerial view turned straight, preview/plan-aerial.png).
  const imageUrl = !trace
    ? null
    : /^inputs\/(plan|photo)-\d+\.jpg$/.test(trace.image)
      ? inputUrl(spaceId, trace.image.replace(/^inputs\//, '').replace(/\.jpg$/, ''))
      : /^preview\/[\w.-]{1,64}\.png$/.test(trace.image)
        ? workspaceFile(workspaceId, trace.image)
        : null;
  // The floor's drawing, once its size is known.
  useEffect(() => {
    setSize(null);
    if (!imageUrl) return;
    const img = new Image();
    img.onload = () => setSize([img.naturalWidth, img.naturalHeight]);
    img.src = imageUrl;
  }, [imageUrl]);

  if (error) return <p className="ats-muted plan-empty">{error}</p>;
  if (!plan) return <p className="ats-muted plan-empty">Loading…</p>;
  const rooms = plan.rooms.filter((r) => onFloor(r, floor));
  // Metres to picture coordinates: the calibration, or a fit to the rooms.
  let toPx: (x: number, z: number) => [number, number];
  let ppm: number;
  let box: [number, number];
  if (trace && size) {
    ppm = 1 / trace.metresPerPixel;
    toPx = (x, z) => [trace.origin[0] + x * ppm, trace.origin[1] + z * ppm];
    box = size;
  } else {
    const xs = rooms.flatMap((r) => [r.rect[0], r.rect[2]]);
    const zs = rooms.flatMap((r) => [r.rect[1], r.rect[3]]);
    const minX = Math.min(...xs, 0);
    const minZ = Math.min(...zs, 0);
    ppm = 800 / Math.max(Math.max(...xs, 1) - minX, Math.max(...zs, 1) - minZ);
    toPx = (x, z) => [40 + (x - minX) * ppm, 40 + (z - minZ) * ppm];
    box = [(Math.max(...xs, 1) - minX) * ppm + 80, (Math.max(...zs, 1) - minZ) * ppm + 80];
  }

  const metresAt = (e: React.PointerEvent) => {
    const el = svg.current;
    const m = el?.getScreenCTM();
    if (!el || !m) return 0;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return drag.current?.axis === 'x' ? p.x / ppm : p.y / ppm;
  };
  /** Moves every wall at `from` on this axis (so shared walls stay shared), and doors in it. */
  const moved = (start: Plan, axis: 'x' | 'z', from: number, to: number): Plan => {
    const i0 = axis === 'x' ? 0 : 1;
    const i1 = axis === 'x' ? 2 : 3;
    return {
      ...start,
      rooms: start.rooms.map((r) => {
        if (!onFloor(r, floor)) return r;
        const rect = [...r.rect] as Room['rect'];
        if (same(rect[i0], from)) rect[i0] = to;
        if (same(rect[i1], from)) rect[i1] = to;
        return { ...r, rect };
      }),
      openings: start.openings.map((o) => {
        if (o.kind === 'window' || !same(o.at[i0], from)) return o;
        const at = [...o.at] as [number, number];
        at[i0] = to;
        return { ...o, at };
      }),
    };
  };
  const startDrag = (axis: 'x' | 'z', value: number, name: string) => (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    drag.current = { axis, from: value, now: value, start: plan };
    setPicked({ axis, at: value, name });
  };
  /** Moves the picked wall by `metres` (keyboard, or the step buttons). */
  const nudge = (metres: number) => {
    if (!picked) return;
    const to = Number((picked.at + metres).toFixed(2));
    setPlan(moved(plan, picked.axis, picked.at, to));
    setPicked({ ...picked, at: to });
    setDirty(true);
  };
  const onWallKey = (e: React.KeyboardEvent) => {
    const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];
    if (!step || !picked) return;
    const along = e.key === 'ArrowLeft' || e.key === 'ArrowRight' ? 'x' : 'z';
    if (along !== picked.axis) return;
    e.preventDefault();
    nudge(step * STEP * (e.shiftKey ? 10 : 1));
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const origin = d.axis === 'x' ? toPx(0, 0)[0] : toPx(0, 0)[1];
    const m = Math.round((metresAt(e) - origin / ppm) / SNAP) * SNAP;
    if (same(m, d.now)) return;
    d.now = m;
    setPlan(moved(d.start, d.axis, d.from, Number(m.toFixed(2))));
    setPicked((p) => p && { ...p, at: Number(m.toFixed(2)) });
    setDirty(true);
  };
  const endDrag = () => {
    drag.current = null;
  };
  const save = async () => {
    setSaving(true);
    try {
      const r = await savePlan(workspaceId, plan);
      setProblems(r.problems);
      setDirty(false);
      if (!r.problems.some((p) => p.level === 'error')) onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="plan-editor">
      <p className="ats-muted studio-small">
        Drag a wall to move it, or tap it (or Tab to it) and move it a step at a time with the
        buttons or arrow keys. Walls two rooms share move together. Your assistant sees your changes
        as soon as you save.
      </p>
      <div className="plan-view">
        <svg
          ref={svg}
          viewBox={`0 0 ${box[0]} ${box[1]}`}
          className="plan-svg"
          onPointerMove={onMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          role="application"
          aria-label="Plan editor"
        >
          {trace && size && imageUrl && (
            <image href={imageUrl} width={size[0]} height={size[1]} opacity={0.55} />
          )}
          {rooms.map((r) => {
            const [x0, y0] = toPx(r.rect[0], r.rect[1]);
            const [x1, y1] = toPx(r.rect[2], r.rect[3]);
            return (
              <g key={r.key}>
                <rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} className="plan-room" />
                <text x={x0 + 6} y={y0 + 16} className="plan-label">
                  {r.name} · {(r.rect[2] - r.rect[0]).toFixed(2)} ×{' '}
                  {(r.rect[3] - r.rect[1]).toFixed(2)} m
                </text>
                {/* Wide, invisible handles on each wall. */}
                <line
                  x1={x0}
                  y1={y0}
                  x2={x1}
                  y2={y0}
                  className={`plan-handle plan-handle--z${picked?.axis === 'z' && same(picked.at, r.rect[1]) ? ' plan-handle--picked' : ''}`}
                  onPointerDown={startDrag('z', r.rect[1], `${r.name}, north wall`)}
                  onFocus={() =>
                    setPicked({ axis: 'z', at: r.rect[1], name: `${r.name}, north wall` })
                  }
                  onKeyDown={onWallKey}
                  tabIndex={0}
                  role="slider"
                  aria-valuenow={r.rect[1]}
                  aria-valuemin={-100}
                  aria-valuemax={1000}
                  aria-valuetext={`${r.rect[1].toFixed(2)} m`}
                  aria-label={`${r.name}, north wall`}
                />
                <line
                  x1={x0}
                  y1={y1}
                  x2={x1}
                  y2={y1}
                  className={`plan-handle plan-handle--z${picked?.axis === 'z' && same(picked.at, r.rect[3]) ? ' plan-handle--picked' : ''}`}
                  onPointerDown={startDrag('z', r.rect[3], `${r.name}, south wall`)}
                  onFocus={() =>
                    setPicked({ axis: 'z', at: r.rect[3], name: `${r.name}, south wall` })
                  }
                  onKeyDown={onWallKey}
                  tabIndex={0}
                  role="slider"
                  aria-valuenow={r.rect[3]}
                  aria-valuemin={-100}
                  aria-valuemax={1000}
                  aria-valuetext={`${r.rect[3].toFixed(2)} m`}
                  aria-label={`${r.name}, south wall`}
                />
                <line
                  x1={x0}
                  y1={y0}
                  x2={x0}
                  y2={y1}
                  className={`plan-handle plan-handle--x${picked?.axis === 'x' && same(picked.at, r.rect[0]) ? ' plan-handle--picked' : ''}`}
                  onPointerDown={startDrag('x', r.rect[0], `${r.name}, west wall`)}
                  onFocus={() =>
                    setPicked({ axis: 'x', at: r.rect[0], name: `${r.name}, west wall` })
                  }
                  onKeyDown={onWallKey}
                  tabIndex={0}
                  role="slider"
                  aria-valuenow={r.rect[0]}
                  aria-valuemin={-100}
                  aria-valuemax={1000}
                  aria-valuetext={`${r.rect[0].toFixed(2)} m`}
                  aria-label={`${r.name}, west wall`}
                />
                <line
                  x1={x1}
                  y1={y0}
                  x2={x1}
                  y2={y1}
                  className={`plan-handle plan-handle--x${picked?.axis === 'x' && same(picked.at, r.rect[2]) ? ' plan-handle--picked' : ''}`}
                  onPointerDown={startDrag('x', r.rect[2], `${r.name}, east wall`)}
                  onFocus={() =>
                    setPicked({ axis: 'x', at: r.rect[2], name: `${r.name}, east wall` })
                  }
                  onKeyDown={onWallKey}
                  tabIndex={0}
                  role="slider"
                  aria-valuenow={r.rect[2]}
                  aria-valuemin={-100}
                  aria-valuemax={1000}
                  aria-valuetext={`${r.rect[2].toFixed(2)} m`}
                  aria-label={`${r.name}, east wall`}
                />
              </g>
            );
          })}
        </svg>
      </div>
      {picked && (
        <div className="studio-actions-row plan-nudge" aria-live="polite">
          <span className="studio-small">
            <strong>{picked.name}</strong> at {picked.at.toFixed(2)} m
          </span>
          <IconButton
            icon={picked.axis === 'x' ? 'back' : 'arrowUp'}
            label={`${picked.axis === 'x' ? 'Left' : 'Up'} 5 cm`}
            onClick={() => nudge(-STEP)}
          />
          <IconButton
            icon={picked.axis === 'x' ? 'arrowRight' : 'arrowDown'}
            label={`${picked.axis === 'x' ? 'Right' : 'Down'} 5 cm`}
            onClick={() => nudge(STEP)}
          />
        </div>
      )}
      {problems.length > 0 && (
        <ul className="plan-problems">
          {problems.map((p) => (
            <li key={p.message} data-level={p.level}>
              {p.message}
            </li>
          ))}
        </ul>
      )}
      <div className="studio-actions-row">
        <Button variant="primary" onClick={() => void save()} disabled={!dirty} busy={saving}>
          <Icon name="save" size={16} />
          {saving ? 'Saving…' : 'Save changes'}
        </Button>
        <Button variant="ghost" onClick={() => void load()} disabled={!dirty || saving}>
          <Icon name="undo" size={16} />
          Undo all
        </Button>
      </div>
    </div>
  );
}
