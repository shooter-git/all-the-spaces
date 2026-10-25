import {
  BrandMark,
  Button,
  Confirm,
  Icon,
  IconButton,
  type IconName,
  Notice,
  Section,
  Tag,
  WashiCorner,
} from '@ats/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import '../routes/manage.css';
import { InstallCard } from '../components/InstallCard.tsx';
import { NotificationBell } from '../components/NotificationBell.tsx';
import { UpdateBanner } from '../components/UpdateBanner.tsx';
import { api, type Me } from '../lib/api.ts';
import { authClient } from '../lib/auth-client.ts';
import { disablePush } from '../lib/notifications.tsx';
import { discardPlace } from '../lib/places.ts';
import { clearPrivateCaches } from '../lib/pwa.ts';
import { requestQueue } from '../lib/requests.ts';
import { importFile } from '../lib/transfer.ts';
import { loadAssistants } from '../lib/workbench.ts';
import './home.css';

/** Your own requests, and (for Architects) what's waiting in the queue. */
function RequestsCard({ isArchitect }: { isArchitect: boolean }) {
  const navigate = useNavigate();
  const [waiting, setWaiting] = useState<number | null>(null);
  useEffect(() => {
    if (!isArchitect) return;
    requestQueue().then(
      (list) =>
        setWaiting(list.filter((r) => ['submitted', 'not_quite'].includes(r.status)).length),
      () => {},
    );
  }, [isArchitect]);
  return (
    <Section title="Requests">
      <p className="ats-muted">
        {isArchitect
          ? 'What members have asked you to build, and what you asked for yourself.'
          : 'Ask for something by drawing a box around it in a space. Follow what you asked for here.'}
      </p>
      <div className="ats-row" style={{ gap: 8, flexWrap: 'wrap' }}>
        {isArchitect && (
          <Button variant="primary" onClick={() => navigate('/studio/requests')}>
            Requests to build{waiting ? ` (${waiting} new)` : ''}
          </Button>
        )}
        <Button onClick={() => navigate('/requests')}>My requests</Button>
      </div>
    </Section>
  );
}

function HomeLink({
  to,
  icon,
  title,
  hint,
  attention,
}: {
  to: string;
  icon: IconName;
  title: string;
  hint: string;
  attention?: boolean;
}) {
  return (
    <li>
      <Link to={to}>
        <Icon name={icon} />
        <strong>{title}</strong>
        <span data-tone={attention ? 'attention' : undefined}>{hint}</span>
        <Icon name="chevronRight" size={16} className="home-link-chevron" />
      </Link>
    </li>
  );
}

/** Where an Architect runs the group, with a word on anything that needs them. */
function ManageLinks({ isArchitect }: { isArchitect: boolean }) {
  const [assistants, setAssistants] = useState<string | null>(null);
  useEffect(() => {
    if (!isArchitect) return;
    loadAssistants().then(
      ({ available, assistants: list }) => {
        if (!available) return setAssistants('Not set up on this server');
        const ready = list.filter((a) => a.apiKey || (a.installed && a.signedIn));
        if (list.some((a) => !a.installed && a.installedVersion !== null))
          return setAssistants('Install again');
        if (list.some((a) => a.installed && a.installedVersion !== a.version))
          return setAssistants('Update ready');
        setAssistants(ready.length ? ready.map((a) => a.name).join(', ') : 'Connect one');
      },
      () => {},
    );
  }, [isArchitect]);
  const attention =
    assistants === 'Update ready' || assistants === 'Install again' || assistants === 'Connect one';
  return (
    <>
      {isArchitect && (
        <Section title="Your group">
          <ul className="home-links">
            <HomeLink to="/group/people" icon="people" title="People" hint="Invite, roles" />
            <HomeLink
              to="/studio/assistants"
              icon="sparkles"
              title="AI assistants"
              hint={assistants ?? ''}
              attention={attention}
            />
            <HomeLink
              to="/group/settings"
              icon="settings"
              title="Group settings"
              hint="Chat, Studio"
            />
            <HomeLink to="/group/activity" icon="activity" title="Activity" hint="Who did what" />
            <HomeLink to="/group/server" icon="server" title="Server" hint="Version, backups" />
          </ul>
        </Section>
      )}
      <Section title="You">
        <ul className="home-links">
          <HomeLink to="/account" icon="account" title="Your account" hint="Password, devices" />
        </ul>
      </Section>
    </>
  );
}

/** A little plan of a space: the rooms of its lowest floor you may see, from above (metres). */
interface SpaceSketch {
  floors: number;
  rooms: number;
  width: number;
  depth: number;
  ground: [number, number, number, number, 0 | 1][];
}

interface SpaceSummary {
  id: string;
  name: string;
  spaceType: string;
  sample: string | null;
  /** Imported from another server and not changed since (so it can still be removed). */
  imported?: boolean;
  groupId: string;
  status: 'draft' | 'building' | 'ready' | 'failed';
  /** For a place being set up: the workspace it's being built in. */
  workspaceId?: string | null;
  /** For a place being set up: where it's up to. */
  stage?: DraftStage;
  /** For a ready space; null when nothing in it has been shared with you yet. */
  sketch?: SpaceSketch | null;
}

interface SpacesResponse {
  spaces: SpaceSummary[];
  samples: { key: string; description: string }[];
}

const KIND: Record<string, string> = {
  apartment: 'Apartment',
  condo: 'Condo',
  house: 'House',
  office: 'Office',
  building: 'Building',
};

function Sketch({ sketch }: { sketch: SpaceSketch }) {
  const size = Math.max(sketch.width, sketch.depth, 1);
  // Upper floors show as sheets behind the ground floor.
  const step = size * 0.05;
  const behind = Math.min(sketch.floors - 1, 2);
  const pad = size * 0.04;
  const w = sketch.width + behind * step;
  const d = sketch.depth + behind * step;
  return (
    <svg
      viewBox={`${-pad} ${-pad - behind * step} ${w + pad * 2} ${d + pad * 2}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      {Array.from({ length: behind }, (_, i) => behind - i).map((n) => (
        <rect
          key={n}
          className="space-sketch-sheet"
          x={n * step}
          y={-n * step}
          width={sketch.width}
          height={sketch.depth}
          rx={size * 0.01}
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {sketch.ground.map(([x, z, rw, rd, outdoor]) => (
        <rect
          key={`${x},${z},${rw},${rd}`}
          className="space-sketch-room"
          data-outdoor={outdoor === 1}
          x={x}
          y={z}
          width={rw}
          height={rd}
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
}

type DraftStage = 'details' | 'start' | 'asleep' | 'working' | 'building' | 'review' | 'failed';

/** What a place being set up shows: where it's up to, what's next, and the button for it. */
const STAGES: Record<DraftStage, { title: string; next: string; button: string; icon: IconName }> =
  {
    details: {
      title: 'Being set up',
      next: 'Add its floor plan or photos, then press Start building.',
      button: 'Continue',
      icon: 'edit',
    },
    start: {
      title: 'Ready to start',
      next: 'Wake its workspace, then start your assistant.',
      button: 'Start',
      icon: 'play',
    },
    asleep: {
      title: 'Waiting for you to start your assistant',
      next: 'Its workspace is asleep, with everything kept: open it to carry on.',
      button: 'Continue',
      icon: 'moon',
    },
    working: {
      title: 'Your assistant is working on it',
      next: 'Open its workspace to see how it’s going.',
      button: 'Open',
      icon: 'sparkles',
    },
    building: {
      title: 'Building…',
      next: 'Every room is being built and lit: a few minutes a room.',
      button: 'Open',
      icon: 'hourglass',
    },
    review: {
      title: 'Ready for you to check',
      next: 'Walk through it, then publish it.',
      button: 'Check it',
      icon: 'eye',
    },
    failed: {
      title: 'The last build didn’t work',
      next: 'Open its workspace to see why.',
      button: 'Open',
      icon: 'alert',
    },
  };

function describe(s: SpaceSummary) {
  const kind = KIND[s.spaceType] ?? 'Place';
  if (!s.sketch) return kind;
  const rooms = `${s.sketch.rooms} room${s.sketch.rooms === 1 ? '' : 's'}`;
  return [kind, rooms, s.sketch.floors > 1 ? `${s.sketch.floors} floors` : null]
    .filter(Boolean)
    .join(' · ');
}

function SpaceCard({
  space: s,
  isArchitect,
  groupId,
  onChanged,
}: {
  space: SpaceSummary;
  isArchitect: boolean;
  groupId: string;
  onChanged: () => Promise<unknown>;
}) {
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draft = s.status === 'draft';
  // Samples and places that couldn't be built can go; a place being set up is discarded.
  const removable =
    isArchitect &&
    (draft || s.status === 'failed' || ((s.sample || s.imported) && s.status === 'ready'));

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await discardPlace(s.id);
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const plate =
    s.status === 'ready' ? (
      s.sketch ? (
        <Sketch sketch={s.sketch} />
      ) : (
        <span>Nothing here is shared with you yet</span>
      )
    ) : draft ? (
      <span className="space-card-stage">
        <Icon name={STAGES[s.stage ?? 'details'].icon} size={20} />
        {STAGES[s.stage ?? 'details'].title}
      </span>
    ) : (
      <span>
        {s.status === 'building' ? 'Building… a few minutes a room' : 'Couldn’t be built'}
      </span>
    );

  return (
    <li className="space-card" data-status={s.status}>
      <div className="space-card-plate">{plate}</div>
      <div className="space-card-body">
        <div className="space-card-title">
          <h3>
            {s.name}
            {s.sample && <Tag>Sample</Tag>}
            {s.imported && <Tag>Imported</Tag>}
          </h3>
          {removable && !confirming && (
            <IconButton
              icon="trash"
              tone="danger"
              label={`${draft ? 'Discard' : 'Remove'} ${s.name}`}
              className="space-card-remove"
              onClick={() => setConfirming(true)}
            />
          )}
        </div>
        <p className="ats-muted space-card-meta">
          {s.status === 'failed' && s.sample
            ? 'Remove it and try the sample again.'
            : draft
              ? STAGES[s.stage ?? 'details'].next
              : describe(s)}
        </p>
        {confirming ? (
          <Confirm
            confirm={draft ? 'Discard it' : 'Remove it'}
            cancel="Keep it"
            busy={busy}
            onConfirm={remove}
            onCancel={() => setConfirming(false)}
          >
            {draft
              ? 'Its floor plans and photos go with it.'
              : s.sample
                ? 'It goes from your spaces. You can add a sample again any time.'
                : 'It goes from your spaces. You can import its file again any time.'}
          </Confirm>
        ) : (
          <div className="space-card-actions">
            {s.status === 'ready' && s.sketch && (
              <Button variant="primary" onClick={() => navigate(`/space/${s.id}`)}>
                <Icon name="enter" size={16} />
                Enter
              </Button>
            )}
            {draft && (
              <Button
                variant="primary"
                onClick={() =>
                  navigate(
                    s.workspaceId
                      ? `/space/${s.id}/studio/${s.workspaceId}`
                      : `/studio/new-place?group=${groupId}&space=${s.id}`,
                  )
                }
              >
                {STAGES[s.stage ?? 'details'].button}
              </Button>
            )}
          </div>
        )}
        {isArchitect && s.status === 'ready' && !confirming && (
          <nav className="space-card-links" aria-label={`${s.name}: for Architects`}>
            <Link to={`/space/${s.id}/studio`}>
              <Icon name="hammer" size={15} />
              Studio
            </Link>
            <Link to={`/space/${s.id}/creations`}>
              <Icon name="box" size={15} />
              Creations
            </Link>
            <Link to={`/space/${s.id}/privacy`}>
              <Icon name="lock" size={15} />
              Privacy
            </Link>
          </nav>
        )}
        {error && (
          <p className="space-card-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </li>
  );
}

function SpacesSection({
  groupId,
  isArchitect,
  onReady,
}: {
  groupId: string;
  isArchitect: boolean;
  /** How many spaces people can walk into (for the welcome at the top). */
  onReady: (count: number) => void;
}) {
  const navigate = useNavigate();
  const [data, setData] = useState<SpacesResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [imported, setImported] = useState<string | null>(null);

  const load = useCallback(
    () =>
      api<SpacesResponse>('/api/spaces').then(
        (d) => {
          setData(d);
          onReady(d.spaces.filter((s) => s.status === 'ready').length);
        },
        (e: Error) => setError(e.message),
      ),
    [onReady],
  );
  useEffect(() => {
    load();
  }, [load]);
  // While a space is being built, check on it every few seconds.
  const building =
    data?.spaces.some(
      (s) => s.status === 'building' || s.stage === 'building' || s.stage === 'working',
    ) ?? false;
  useEffect(() => {
    if (!building) return;
    const timer = setInterval(load, 4000);
    return () => clearInterval(timer);
  }, [building, load]);

  // A double tap shouldn't add two (the button only disables once React has re-rendered).
  const adding = useRef(false);
  const addSample = async (sample: string) => {
    if (adding.current) return;
    adding.current = true;
    setBusy(sample);
    setError(null);
    try {
      await api<{ spaceId: string }>(`/api/groups/${groupId}/sample-spaces`, { json: { sample } });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
    adding.current = false;
    setBusy(null);
  };

  const importPlace = async (file: File) => {
    setBusy('import');
    setError(null);
    setImported(null);
    try {
      const r = await importFile<{ name: string; rooms: number }>(
        `/api/groups/${groupId}/places/import`,
        file,
      );
      setImported(
        `${r.name} is here (${r.rooms} rooms). Every room is private to Architects until you share it: Privacy, on its card.`,
      );
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(null);
  };

  if (!data) return error ? <Notice tone="error">{error}</Notice> : null;
  // Each sample once: one you already have isn't offered again.
  const samples = data.samples.filter(
    (k) => !data.spaces.some((s) => s.sample === k.key && s.status !== 'failed'),
  );
  if (data.spaces.length === 0 && !isArchitect) return null;
  return (
    <section aria-labelledby="home-spaces">
      <div className="home-spaces-head">
        <h2 id="home-spaces">Spaces</h2>
      </div>
      <ul className="space-cards">
        {data.spaces.map((s) => (
          <SpaceCard
            key={s.id}
            space={s}
            isArchitect={isArchitect}
            groupId={groupId}
            onChanged={load}
          />
        ))}
        {isArchitect && (
          <li style={{ display: 'contents' }}>
            <button
              type="button"
              className="space-card space-card--add"
              onClick={() => navigate(`/studio/new-place?group=${groupId}`)}
            >
              <strong>Add your own place</strong>
              <span>
                Your AI assistant builds a 3D model of your home or workplace from its floor plan
                and a few photos, or from photos of the outside. You check it, and share each room
                only with the people you choose.
              </span>
            </button>
          </li>
        )}
        {isArchitect && (
          <li style={{ display: 'contents' }}>
            <label className="space-card space-card--add space-card--import">
              <strong>
                <Icon name="upload" size={16} />
                {busy === 'import' ? 'Importing…' : 'Import a place'}
              </strong>
              <span>
                From a .atspace file downloaded from another All the Spaces server (Download this
                place, in a place’s Studio).
              </span>
              <input
                type="file"
                accept=".atspace,application/zip"
                disabled={busy !== null}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) void importPlace(file);
                }}
              />
            </label>
          </li>
        )}
      </ul>
      {isArchitect && samples.length > 0 && (
        <div className="home-samples">
          <span className="ats-muted">Try a sample while yours is built:</span>
          {samples.map((s) => (
            <Button key={s.key} onClick={() => addSample(s.key)} disabled={busy !== null}>
              {busy === s.key ? 'Starting…' : s.description}
            </Button>
          ))}
        </div>
      )}
      {imported && <Notice>{imported}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
    </section>
  );
}

export function Home({ me, onSignedOut }: { me: Me; onSignedOut: () => void }) {
  const membership = me.groups[0];
  const name = membership?.groupName ?? 'All the Spaces';
  const isArchitect = membership?.role === 'architect';

  // The welcome at the top is for before there's anywhere to go.
  const [readySpaces, setReadySpaces] = useState<number | null>(null);

  const [signOutFailed, setSignOutFailed] = useState(false);
  const signOut = async () => {
    setSignOutFailed(false);
    // This device stops getting their notifications.
    await disablePush().catch(() => {});
    try {
      const res = await authClient.signOut();
      if (res?.error) throw new Error(res.error.message);
    } catch {
      setSignOutFailed(true);
      return;
    }
    await clearPrivateCaches().catch(() => {});
    onSignedOut();
  };

  return (
    <main className="ats-screen">
      <div className="home">
        <header className="home-header">
          <div className="ats-row" style={{ gap: 12, flexWrap: 'nowrap' }}>
            <BrandMark size={32} />
            <div>
              <h1>{name}</h1>
              <span className="ats-muted" style={{ fontSize: '0.85rem' }}>
                {me.user?.name} · {isArchitect ? 'Architect' : 'Member'}
              </span>
            </div>
          </div>
          <div className="ats-row" style={{ gap: 4, flexWrap: 'nowrap' }}>
            <NotificationBell />
            <Button variant="ghost" onClick={signOut} aria-label="Sign out" title="Sign out">
              <Icon name="signOut" size={16} />
              <span className="home-wide-only">Sign out</span>
            </Button>
          </div>
        </header>
        <UpdateBanner />
        {signOutFailed && (
          <Notice tone="error">
            Couldn't sign out: the server didn't answer. Check you're online and try again.
          </Notice>
        )}

        <div className="home-grid">
          <div className="home-main">
            {!membership ? (
              <Notice>You're not part of a space yet. Ask an Architect for an invite link.</Notice>
            ) : readySpaces === 0 ? (
              <section
                className="ats-stack"
                style={{
                  gap: 10,
                  padding: 'var(--ats-space-5)',
                  borderRadius: 'var(--ats-radius-lg)',
                  position: 'relative',
                  overflow: 'hidden',
                  background: 'var(--ats-hero)',
                }}
              >
                <WashiCorner className="ats-hero-washi" />
                <h2>{isArchitect ? 'Build your space' : 'Your space is on its way'}</h2>
                <p className="ats-muted">
                  {isArchitect
                    ? "Next, you'll upload floor plans and photos, and your AI assistant will build a 3D version of your place that everyone can walk around in."
                    : `The Architect of ${name} is building a 3D version of your place. You'll be able to walk around in it here soon.`}
                </p>
              </section>
            ) : null}
            {membership && (
              <SpacesSection
                groupId={membership.groupId}
                isArchitect={isArchitect}
                onReady={setReadySpaces}
              />
            )}
          </div>

          <aside className="home-aside" aria-label="Requests, sharing and settings">
            {membership && <RequestsCard isArchitect={isArchitect} />}
            {membership && <ManageLinks isArchitect={isArchitect} />}
            <InstallCard name={name} />
          </aside>
        </div>
      </div>
    </main>
  );
}
