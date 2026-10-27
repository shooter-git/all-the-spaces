import type { PlaceVisits, VisitDevice } from '@ats/api-types';
import { Icon, Notice } from '@ats/ui';
import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { Link, useSearchParams } from 'react-router';
import { loadVisits } from '../lib/studio.ts';
import { timeSpent } from '../lib/time-spent.ts';
import { ago } from './NotificationBell.tsx';
import { type Tab, Tabs, tabPanel } from './Tabs.tsx';
import '../routes/studio.css';
import './time-spent.css';

type View = 'overview' | 'rooms' | 'creations' | 'people';
const VIEWS: Tab<View>[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'rooms', label: 'Rooms' },
  { id: 'creations', label: 'Creations' },
  { id: 'people', label: 'People' },
];
const PERIODS = [7, 30, 90] as const;
/** Rows shown before "more". */
const FOLDED = 6;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const share = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : 0);
/** A share in words: "under 1%" rather than a 0% that isn't nothing. */
const percent = (part: number, whole: number) =>
  part > 0 && share(part, whole) === 0 ? 'under 1%' : `${share(part, whole)}%`;
/** A YYYY-MM-DD day as a date here. */
const dayOf = (ymd: string) => {
  const [y = 0, m = 1, d = 1] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const shortDay = (ymd: string) =>
  dayOf(ymd).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
// 1 January 2024 was a Monday.
const WEEKDAYS = Array.from({ length: 7 }, (_, i) =>
  new Date(2024, 0, 1 + i).toLocaleDateString(undefined, { weekday: 'short' }),
);
const WEEKDAYS_LONG = Array.from({ length: 7 }, (_, i) =>
  new Date(2024, 0, 1 + i).toLocaleDateString(undefined, { weekday: 'long' }),
);
const hourOf = (h: number) =>
  new Date(2024, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' });
const hours = (h: number) => `${hourOf(h)}–${hourOf((h + 1) % 24)}`;
const DEVICES: Record<VisitDevice | 'unknown', string> = {
  phone: 'Phones',
  tablet: 'Tablets',
  computer: 'Computers',
  headset: 'Headsets',
  unknown: 'Not known',
};
/** How strongly to shade a value, 0 (none) to 4, against the most there is. */
const level = (value: number, most: number) =>
  value > 0 && most > 0 ? Math.max(1, Math.ceil((value / most) * 4)) : 0;

/**
 * Where people spend time in a place, for its Architects: when they come, how long they stay,
 * which rooms and creations, on what, and each person's own picture. The period and the part
 * shown are in the address, so a link opens the same view.
 */
export function TimeSpent({ spaceId }: { spaceId: string }) {
  const [params, setParams] = useSearchParams();
  const days = PERIODS.find((d) => String(d) === params.get('days')) ?? 30;
  const view = VIEWS.find((v) => v.id === params.get('see'))?.id ?? 'overview';
  const set = (key: string, value: string) =>
    setParams(
      (p) => {
        p.set(key, value);
        return p;
      },
      { replace: true },
    );
  const [data, setData] = useState<PlaceVisits | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let gone = false;
    setLoading(true);
    setError(null);
    loadVisits(spaceId, days).then(
      (r) => {
        if (gone) return;
        setData(r);
        setLoading(false);
      },
      (e: Error) => {
        if (gone) return;
        setError(e.message);
        setLoading(false);
      },
    );
    return () => {
      gone = true;
    };
  }, [spaceId, days]);

  const names = useMemo(
    () =>
      new Map([
        ...(data?.rooms ?? []).map(
          (r) =>
            [
              r.key,
              r.name ? (r.floor ? `${r.name}, ${r.floor}` : r.name) : 'A room since removed',
            ] as const,
        ),
        ...(data?.creations ?? []).map((c) => [c.id, c.title] as const),
      ]),
    [data],
  );

  if (data && !data.recording) {
    return (
      <section className="ats-stack ts">
        <h2>Where people spend time</h2>
        <p className="ats-muted">
          Your group doesn’t record where people spend time: it’s turned off in{' '}
          <Link to="/group/settings">Group settings</Link>.
        </p>
      </section>
    );
  }
  const summary = data?.summary;
  return (
    <section className="ats-stack ts" aria-busy={loading}>
      <div className="ts-head">
        <h2>Where people spend time</h2>
        {/* biome-ignore lint/a11y/useSemanticElements: a group of toggle buttons, not a form */}
        <div className="ats-tabs ats-tabs--segmented" role="group" aria-label="How far back">
          {PERIODS.map((d) => (
            <button
              key={d}
              type="button"
              className="ats-tab"
              aria-pressed={d === days}
              onClick={() => set('days', String(d))}
            >
              {d} days
            </button>
          ))}
        </div>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {!data ? (
        !error && <p className="ats-muted">Adding it up…</p>
      ) : summary && summary.people === 0 ? (
        <p className="ats-muted ts-body" data-busy={loading || undefined}>
          Nobody has spent time here in the last {days} days.
        </p>
      ) : (
        <div className="ats-stack ts-body" data-busy={loading || undefined}>
          {summary && (
            <>
              <dl className="ts-tiles">
                <Tile label="Time here" value={timeSpent(summary.seconds)} />
                <Tile label="People" value={String(summary.people)} />
                <Tile label="Visits" value={String(summary.visits)} />
                <Tile label="Typical visit" value={timeSpent(summary.typicalSeconds)} />
              </dl>
              <p className="ats-muted studio-small ts-lede">
                {summary.cameBack} of {plural(summary.people, 'person', 'people')} came back on
                another day
                {summary.roomSeconds > 0 &&
                  (summary.togetherSeconds
                    ? ` · ${percent(summary.togetherSeconds, summary.roomSeconds)} of time in rooms was with someone else`
                    : ' · nobody shared a room')}
              </p>
            </>
          )}
          <Tabs
            label="What to show"
            idPrefix="ts"
            tabs={VIEWS}
            value={view}
            onChange={(v) => set('see', v)}
            segmented
          />
          <div {...tabPanel('ts', view)} className="ats-stack ts-panel">
            {view === 'overview' && (
              <>
                <Trend trend={data.trend} weekly={data.days > 31} />
                <Week week={data.week} days={data.days} />
                <Devices devices={data.devices} />
              </>
            )}
            {view === 'rooms' && <Rooms data={data} names={names} />}
            {view === 'creations' && <Creations data={data} />}
            {view === 'people' && <People data={data} names={names} />}
          </div>
        </div>
      )}
      <p className="ats-muted studio-small">
        Time counts while the app is open and in sight: a room once someone has stayed a few
        seconds, and time in a creation is also time in its room. Back within a few minutes is the
        same visit. Only Architects see this, and <Link to="/group/settings">Group settings</Link>{' '}
        can turn it off.
      </p>
    </section>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="ts-tile">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/**
 * Time per day (or per week), as columns. The chart is one control, a slider over the days, so
 * it's an easy target on a phone: hover, tap or drag across it, or move along with the arrow keys.
 */
function Trend({ trend, weekly }: { trend: PlaceVisits['trend']; weekly: boolean }) {
  const [at, setAt] = useState<number | null>(null);
  const most = Math.max(0, ...trend.map((b) => b.seconds));
  const busiest = trend.findIndex((b) => b.seconds === most && most > 0);
  const label = (b: PlaceVisits['trend'][number]) =>
    weekly
      ? `Week of ${shortDay(b.from)}`
      : dayOf(b.from).toLocaleDateString(undefined, {
          weekday: 'short',
          day: 'numeric',
          month: 'short',
        });
  const say = (b: PlaceVisits['trend'][number]) =>
    b.seconds
      ? `${label(b)}: ${timeSpent(b.seconds)} · ${plural(b.people, 'person', 'people')}`
      : `${label(b)}: nobody`;
  const now = at ?? Math.max(0, busiest);
  const shown = at !== null ? trend[at] : trend[busiest];
  const title = weekly ? 'Week by week' : 'Day by day';
  const point = (e: PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const i = Math.floor(((e.clientX - box.left) / box.width) * trend.length);
    setAt(Math.min(trend.length - 1, Math.max(0, i)));
  };
  const step = (e: KeyboardEvent) => {
    const to = {
      ArrowLeft: now - 1,
      ArrowDown: now - 1,
      ArrowRight: now + 1,
      ArrowUp: now + 1,
      Home: 0,
      End: trend.length - 1,
    }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    setAt(Math.min(trend.length - 1, Math.max(0, to)));
  };
  return (
    <figure className="ts-figure">
      <figcaption className="ts-caption">
        <h3 className="studio-subhead">{title}</h3>
        <span className="ats-muted studio-small">
          {shown ? `${at === null ? 'Busiest · ' : ''}${say(shown)}` : 'Nobody yet'}
        </span>
      </figcaption>
      <div className="ts-plot">
        {most > 0 && <span className="ts-tick">{timeSpent(most)}</span>}
        <div
          className="ts-columns"
          role="slider"
          tabIndex={0}
          aria-label={title}
          aria-valuemin={0}
          aria-valuemax={trend.length - 1}
          aria-valuenow={now}
          aria-valuetext={trend[now] ? say(trend[now]) : 'Nobody yet'}
          onKeyDown={step}
          onPointerDown={point}
          onPointerMove={point}
          onPointerLeave={(e) => e.pointerType === 'mouse' && setAt(null)}
          onBlur={() => setAt(null)}
        >
          {trend.map((b, i) => (
            <span key={b.from} className="ts-column" data-on={at === i || undefined}>
              {b.seconds > 0 && (
                <span
                  className="ts-column-bar"
                  style={{ height: `${Math.max(2, (b.seconds / most) * 100)}%` }}
                />
              )}
            </span>
          ))}
        </div>
      </div>
      <div className="ts-axis ats-muted" aria-hidden="true">
        <span>{trend[0] && shortDay(trend[0].from)}</span>
        <span>{weekly ? 'this week' : 'today'}</span>
      </div>
    </figure>
  );
}

/** Time by weekday and hour, shaded: when people tend to be here. */
function Week({ week, days }: { week: number[][]; days: number }) {
  const [at, setAt] = useState<[number, number] | null>(null);
  const most = Math.max(0, ...week.flat());
  const ranked = week
    .flatMap((row, d) => row.map((v, h) => ({ d, h, v })))
    .filter((c) => c.v > 0)
    .sort((a, b) => b.v - a.v);
  const say = (d: number, h: number) => {
    const v = week[d]?.[h] ?? 0;
    return `${WEEKDAYS_LONG[d]}, ${hours(h)}: ${v ? timeSpent(v) : 'nobody'} over ${days} days`;
  };
  const top = ranked[0];
  const pick = (e: PointerEvent) => {
    const cell = (e.target as HTMLElement).dataset.cell;
    if (cell) setAt(cell.split(':').map(Number) as [number, number]);
  };
  return (
    <figure className="ts-figure">
      <figcaption className="ts-caption">
        <h3 className="studio-subhead">When people come</h3>
        <span className="ats-muted studio-small">
          {at ? say(...at) : top ? `Busiest · ${say(top.d, top.h)}` : 'Nobody yet'}
        </span>
      </figcaption>
      <div
        className="ts-heat"
        role="img"
        aria-label={
          ranked.length
            ? `Busiest times: ${ranked
                .slice(0, 3)
                .map((c) => `${WEEKDAYS_LONG[c.d]} ${hours(c.h)}`)
                .join('; ')}`
            : 'Nobody yet'
        }
        onPointerOver={pick}
        onPointerDown={pick}
        onPointerLeave={(e) => e.pointerType === 'mouse' && setAt(null)}
      >
        {week.map((row, d) => (
          <div key={WEEKDAYS[d]} className="ts-heat-row">
            <span className="ts-heat-day">{WEEKDAYS[d]}</span>
            {row.map((v, h) => (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: the 24 hours of a day
                key={h}
                className="ts-cell"
                data-level={level(v, most)}
                data-cell={`${d}:${h}`}
                data-on={(at && at[0] === d && at[1] === h) || undefined}
              />
            ))}
          </div>
        ))}
        <HourAxis />
      </div>
      <Legend />
    </figure>
  );
}

/** Hours along the bottom (`days`: with the weekdays' column before them). */
function HourAxis({ days = true }: { days?: boolean }) {
  return (
    <div className="ts-heat-row ts-hour-axis ats-muted" aria-hidden="true">
      {days && <span className="ts-heat-day" />}
      {[0, 6, 12, 18].map((h) => (
        <span key={h} style={{ gridColumn: `${h + (days ? 2 : 1)} / span 6` }}>
          {hourOf(h)}
        </span>
      ))}
    </div>
  );
}

function Legend() {
  return (
    <div className="ts-legend ats-muted studio-small" aria-hidden="true">
      Less
      {[0, 1, 2, 3, 4].map((l) => (
        <span key={l} className="ts-cell" data-level={l} />
      ))}
      More
    </div>
  );
}

/** One person's time across the hours of the day. */
function HourStrip({ hours: byHour }: { hours: number[] }) {
  const most = Math.max(0, ...byHour);
  const top = byHour.indexOf(most);
  return (
    <div
      className="ts-heat ts-heat--strip"
      role="img"
      aria-label={most ? `Mostly ${hours(top)}` : 'Nobody yet'}
    >
      <div className="ts-heat-row">
        {byHour.map((v, h) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: the 24 hours of a day
            key={h}
            className="ts-cell"
            data-level={level(v, most)}
            title={`${hours(h)}: ${v ? timeSpent(v) : 'nobody'}`}
          />
        ))}
      </div>
      <HourAxis days={false} />
    </div>
  );
}

interface Row {
  key: string;
  name: ReactNode;
  seconds: number;
  /** Under the bar. */
  meta?: string;
  /** Instead of the time (a share, say). */
  value?: string;
}

/** Ranked rows, each with a bar against the most (or against `whole`, for shares): folded. */
function Ranked({ rows, label, whole }: { rows: Row[]; label: string; whole?: number }) {
  const [open, setOpen] = useState(false);
  const most = whole ?? rows[0]?.seconds ?? 0;
  const shown = open ? rows : rows.slice(0, FOLDED);
  return (
    <div className="ats-stack ts-ranked">
      <ol className="ts-rows" aria-label={label}>
        {shown.map((r) => (
          <li key={r.key} className="ts-row">
            <RowBody row={r} most={most} />
          </li>
        ))}
      </ol>
      {rows.length > FOLDED && (
        <Unfold open={open} more={rows.length - FOLDED} onToggle={setOpen} />
      )}
    </div>
  );
}

function RowBody({ row, most }: { row: Row; most: number }) {
  return (
    <>
      <span className="ts-row-line">
        <span className="ts-name">{row.name}</span>
        <span className="ts-value">{row.value ?? timeSpent(row.seconds)}</span>
      </span>
      <span className="ts-bar" aria-hidden="true">
        <span
          className="ts-bar-fill"
          style={{ width: `${most ? Math.max(1, (row.seconds / most) * 100) : 0}%` }}
        />
      </span>
      {row.meta && <span className="ts-meta ats-muted">{row.meta}</span>}
    </>
  );
}

function Unfold({
  open,
  more,
  onToggle,
}: {
  open: boolean;
  more: number;
  onToggle: (open: boolean) => void;
}) {
  return (
    <button
      type="button"
      className="studio-unfold"
      aria-expanded={open}
      onClick={() => onToggle(!open)}
    >
      <Icon name={open ? 'chevronUp' : 'chevronDown'} size={16} />
      {open ? 'Fewer' : `${more} more`}
    </button>
  );
}

function Devices({ devices }: { devices: PlaceVisits['devices'] }) {
  const total = devices.reduce((n, d) => n + d.seconds, 0);
  if (!total) return null;
  return (
    <div className="ats-stack ts-section">
      <h3 className="studio-subhead">On what</h3>
      <Ranked
        label="Time on each kind of device"
        whole={total}
        rows={devices.map((d) => ({
          key: d.device ?? 'unknown',
          name: DEVICES[d.device ?? 'unknown'],
          seconds: d.seconds,
          value: `${share(d.seconds, total)}%`,
          meta:
            d.device === null
              ? `${timeSpent(d.seconds)}, from before devices were recorded`
              : timeSpent(d.seconds),
        }))}
      />
    </div>
  );
}

function Rooms({ data, names }: { data: PlaceVisits; names: Map<string, string> }) {
  const used = data.rooms.filter((r) => r.seconds > 0);
  const unused = data.rooms.filter((r) => r.seconds === 0 && r.name);
  return (
    <>
      <Ranked
        label="Time in each room"
        rows={used.map((r) => ({
          key: r.key,
          name: names.get(r.key),
          seconds: r.seconds,
          meta: [
            plural(r.people, 'person', 'people'),
            plural(r.visits, 'visit'),
            r.visits ? `about ${timeSpent(r.seconds / r.visits)} each` : '',
            r.togetherSeconds ? `${percent(r.togetherSeconds, r.seconds)} with someone else` : '',
          ]
            .filter(Boolean)
            .join(' · '),
        }))}
      />
      {unused.length > 0 && (
        <p className="ats-muted studio-small">
          Nobody yet: {unused.map((r) => names.get(r.key)).join(', ')}
        </p>
      )}
      {data.moves.length > 0 && (
        <div className="ats-stack ts-section">
          <h3 className="studio-subhead">Moves between rooms</h3>
          <ol className="ts-moves">
            {data.moves.map((m) => (
              <li key={`${m.from}>${m.to}`}>
                <span>{names.get(m.from) ?? 'A room since removed'}</span>
                <Icon name="arrowRight" size={14} />
                <span>{names.get(m.to) ?? 'A room since removed'}</span>
                <span className="ats-muted"> · {plural(m.times, 'time')}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </>
  );
}

function Creations({ data }: { data: PlaceVisits }) {
  const used = data.creations.filter((c) => c.seconds > 0);
  if (!used.length)
    return (
      <p className="ats-muted">
        {data.creations.length
          ? `Nobody has opened a creation here in the last ${data.days} days.`
          : 'No creations here yet.'}
      </p>
    );
  return (
    <Ranked
      label="Time in each creation"
      rows={used.map((c) => ({
        key: c.id,
        name: c.title,
        seconds: c.seconds,
        meta: [
          plural(c.people, 'person', 'people'),
          `opened ${plural(c.visits, 'time')}`,
          c.togetherSeconds ? `${percent(c.togetherSeconds, c.seconds)} played together` : '',
        ]
          .filter(Boolean)
          .join(' · '),
      }))}
    />
  );
}

/** Everyone who spent time here; open one to see their own picture. */
function People({ data, names }: { data: PlaceVisits; names: Map<string, string> }) {
  const [open, setOpen] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const most = data.people[0]?.seconds ?? 0;
  const shown = all ? data.people : data.people.slice(0, FOLDED);
  return (
    <div className="ats-stack ts-ranked">
      <ul className="ts-rows" aria-label="Time each person spent here">
        {shown.map((p) => (
          <li
            key={p.userId}
            className="ts-row ts-row--person"
            data-open={open === p.userId || undefined}
          >
            <button
              type="button"
              className="ts-person-toggle"
              aria-expanded={open === p.userId}
              aria-controls={`ts-person-${p.userId}`}
              onClick={() => setOpen((o) => (o === p.userId ? null : p.userId))}
            >
              <RowBody
                most={most}
                row={{
                  key: p.userId,
                  name: (
                    <>
                      <span className="ts-dot" style={{ background: p.color }} aria-hidden="true" />
                      {p.name}
                    </>
                  ),
                  seconds: p.seconds,
                  meta: `${plural(p.visits, 'visit')} · ${plural(p.days, 'day')} · last here ${ago(p.lastAt)}`,
                }}
              />
              <Icon name={open === p.userId ? 'chevronUp' : 'chevronDown'} size={16} />
            </button>
            {open === p.userId && (
              <div id={`ts-person-${p.userId}`}>
                <Person person={p} names={names} />
              </div>
            )}
          </li>
        ))}
      </ul>
      {data.people.length > FOLDED && (
        <Unfold open={all} more={data.people.length - FOLDED} onToggle={setAll} />
      )}
    </div>
  );
}

function Person({
  person: p,
  names,
}: {
  person: PlaceVisits['people'][number];
  names: Map<string, string>;
}) {
  const onDevices = p.devices.reduce((n, d) => n + d.seconds, 0);
  return (
    <div className="ats-stack ts-person">
      <dl className="ts-tiles ts-tiles--small">
        <Tile label="Typical visit" value={timeSpent(p.typicalSeconds)} />
        <Tile label="In creations" value={p.inCreations ? timeSpent(p.inCreations) : 'none'} />
        <Tile label="With others" value={percent(p.togetherSeconds, p.seconds)} />
      </dl>
      {p.rooms.length > 0 && (
        <div className="ats-stack ts-section">
          <h4 className="ts-subhead">Rooms</h4>
          <Ranked
            label={`${p.name}'s time in each room`}
            rows={p.rooms.map((r) => ({
              key: r.key,
              name: names.get(r.key) ?? 'A room since removed',
              seconds: r.seconds,
            }))}
          />
        </div>
      )}
      {p.creations.length > 0 && (
        <div className="ats-stack ts-section">
          <h4 className="ts-subhead">Creations</h4>
          <Ranked
            label={`${p.name}'s time in each creation`}
            rows={p.creations.map((c) => ({
              key: c.id,
              name: names.get(c.id) ?? 'A creation since removed',
              seconds: c.seconds,
            }))}
          />
        </div>
      )}
      <div className="ats-stack ts-section">
        <h4 className="ts-subhead">Time of day</h4>
        <HourStrip hours={p.hours} />
      </div>
      {onDevices > 0 && (
        <p className="ats-muted studio-small">
          On{' '}
          {p.devices
            .map(
              (d) =>
                `${DEVICES[d.device ?? 'unknown'].toLowerCase()} ${share(d.seconds, onDevices)}%`,
            )
            .join(' · ')}
        </p>
      )}
    </div>
  );
}
