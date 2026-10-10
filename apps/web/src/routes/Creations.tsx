import { Button, Icon, IconButton, Notice, Section } from '@ats/ui';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { BackLink } from '../components/BackLink.tsx';
import { RepositoryForm, RepositoryPanel } from '../components/Repository.tsx';
import { placeCreation } from '../lib/places.ts';
import {
  createFromRepository,
  linkSource,
  loadSourceHosts,
  type SourceHostInfo,
  short,
  unlinkSource,
} from '../lib/sources.ts';
import {
  approveConnectors,
  byForm,
  type FieldPerf,
  loadFieldPerf,
  loadStudio,
  makeLive,
  reportFile,
  type Studio,
  type StudioBuild,
  type StudioCreation,
  type StudioVersion,
  type StudioVersionConnector,
  smoothness,
} from '../lib/studio.ts';
import { creationExportUrl, importFile } from '../lib/transfer.ts';
// The Studio's shared pieces (the wide page, the file button, rows of actions), then this page's.
import './studio.css';
import './creations.css';

const MODE_WORDS = { solo: 'On your own', shared: 'Together', invite: 'By invitation' } as const;
const size = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const date = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

/**
 * Architects' view of a space's creations: every version with how it did in its checks, what's
 * being built right now, and trying, publishing or going back to a version.
 */
export function Creations() {
  const { spaceId } = useParams();
  const [studio, setStudio] = useState<Studio | null>(null);
  const [field, setField] = useState<FieldPerf[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState<string | null>(null);
  // Repository hosts this server allows (none: creations come only from the Studio).
  const [hosts, setHosts] = useState<SourceHostInfo[]>([]);
  const [fromRepository, setFromRepository] = useState(false);
  useEffect(() => {
    loadSourceHosts().then(setHosts, () => setHosts([]));
  }, []);

  const importCreation = async (file: File) => {
    if (!spaceId) return;
    setImporting(true);
    setError(null);
    setImported(null);
    try {
      const r = await importFile<{ title: string; live?: boolean }>(
        `/api/spaces/${spaceId}/creations/import`,
        file,
      );
      setImported(
        r.live === false
          ? `${r.title} is on the shelf. It uses services this server connects to: approve them on its version, then make it live and put it on an object.`
          : `${r.title} is on the shelf: put it on an object to bring it into the place.`,
      );
      refresh();
    } catch (e) {
      setError((e as Error).message);
    }
    setImporting(false);
  };

  const refresh = useCallback(() => {
    if (!spaceId) return;
    loadStudio(spaceId).then(setStudio, (e: Error) => setError(e.message));
    loadFieldPerf(spaceId).then(
      (r) => setField(r.creations),
      () => {},
    );
  }, [spaceId]);
  useEffect(refresh, [refresh]);
  // Follow builds while any are in progress.
  const building = studio?.builds.some((b) => b.status === 'queued' || b.status === 'running');
  useEffect(() => {
    if (!building) return;
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [building, refresh]);

  const inProgress =
    studio?.builds.filter((b) => b.status === 'queued' || b.status === 'running') ?? [];
  // Failed builds that nothing newer has replaced.
  const failed =
    studio?.builds.filter(
      (b, i, all) =>
        (b.status === 'failed' || b.status === 'error') &&
        !all
          .slice(0, i)
          .some(
            (n) => n.objectKey === b.objectKey && n.status !== 'failed' && n.status !== 'error',
          ),
    ) ?? [];

  return (
    <main className="ats-screen">
      <div className="ats-container ats-stack studio-wide creations-page">
        <header className="ats-stack" style={{ gap: 6 }}>
          <div>
            <BackLink to="/" label="Your spaces" />
          </div>
          <h1>Creations{studio ? ` in ${studio.space.name}` : ''}</h1>
          <p className="ats-muted">
            Every version of every creation, and how it did in its checks. People always get the
            live version; try a new one on your own phone or computer before it goes live.
          </p>
        </header>

        {studio && (
          <div className="studio-actions-row">
            <label className="ats-button ats-button--ghost studio-file">
              <Icon name="upload" size={16} />
              {importing ? 'Importing…' : 'Import a creation'}
              <input
                type="file"
                accept=".atcreation,application/zip"
                disabled={importing}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) void importCreation(file);
                }}
              />
            </label>
            <span className="ats-muted studio-small">
              From a .atcreation file downloaded on another server. It arrives on the shelf.
            </span>
            {hosts.length > 0 && !fromRepository && (
              <Button variant="ghost" onClick={() => setFromRepository(true)}>
                <Icon name="link" size={16} />
                From a repository
              </Button>
            )}
          </div>
        )}
        {studio && fromRepository && (
          <NewFromRepository
            studio={studio}
            hosts={hosts}
            spaceId={spaceId ?? ''}
            onDone={(started) => {
              setFromRepository(false);
              if (started) {
                setImported(started);
                refresh();
              }
            }}
          />
        )}
        {imported && <Notice>{imported}</Notice>}
        {error && <Notice tone="error">{error}</Notice>}
        {!studio && !error && <p className="ats-muted">Loading…</p>}

        {inProgress.length > 0 && (
          <Section title="Being built">
            <ul className="studio-list">
              {inProgress.map((b) => (
                <li key={b.id} className="studio-build" aria-live="polite">
                  <span className="studio-pulse" aria-hidden="true" />
                  <div>
                    <strong>{b.title ?? 'A creation'}</strong>
                    <div className="ats-muted">{b.step ?? 'Waiting its turn'}…</div>
                  </div>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {failed.length > 0 && (
          <Section title="Didn't pass">
            <ul className="studio-list">
              {failed.map((b) => (
                <FailedBuild key={b.id} build={b} spaceId={spaceId ?? ''} />
              ))}
            </ul>
          </Section>
        )}

        {studio?.creations.some((c) => !c.objectKey) && (
          <Section title="On the shelf">
            <p className="ats-muted">
              These aren’t on anything in the place right now, so nobody can open them; everything
              saved in them is kept. Put one on a free object to bring it back.
            </p>
            <ul className="studio-list">
              {studio.creations
                .filter((c) => !c.objectKey)
                .map((c) => (
                  <ShelfItem key={c.id} creation={c} studio={studio} onChanged={refresh} />
                ))}
            </ul>
          </Section>
        )}

        {studio && (
          <Section title="Creations">
            {studio.creations.length === 0 ? (
              <p className="ats-muted">No creations yet.</p>
            ) : (
              <ul className="studio-list creations-grid">
                {studio.creations.map((c) => (
                  <CreationCard
                    key={c.id}
                    creation={c}
                    field={field}
                    studio={studio}
                    hosts={hosts}
                    spaceId={spaceId ?? ''}
                    onChanged={refresh}
                  />
                ))}
              </ul>
            )}
          </Section>
        )}
      </div>
    </main>
  );
}

function FailedBuild({ build, spaceId }: { build: StudioBuild; spaceId: string }) {
  const navigate = useNavigate();
  return (
    <li className="studio-build">
      <span className="studio-dot studio-dot--bad" aria-hidden="true" />
      <div className="studio-grow">
        <strong>{build.title ?? 'A creation'}</strong>
        <div className="ats-muted">
          {build.status === 'error'
            ? `The build itself went wrong: ${build.error ?? 'unknown error'}`
            : `${build.qa?.failed ?? 'Some'} thing${build.qa?.failed === 1 ? '' : 's'} to fix · ${date(build.createdAt)}`}
        </div>
      </div>
      {build.status === 'failed' && (
        <IconButton
          icon="list"
          label={`What to fix in ${build.title ?? 'it'}`}
          onClick={() => navigate(`/space/${spaceId}/builds/${build.id}`)}
        />
      )}
    </li>
  );
}

/** Choosing an object for a creation: a free one, or (for a placed creation) the shelf. */
function PlacePicker({
  creation,
  studio,
  onDone,
}: {
  creation: StudioCreation;
  studio: Studio;
  onDone: (changed: boolean) => void;
}) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async (to: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await placeCreation(creation.id, to);
      onDone(true);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  const rooms = [...new Set(studio.freeObjects.map((o) => o.room))];
  return (
    <section className="studio-confirm" aria-label={`Move ${creation.title}`}>
      {studio.freeObjects.length === 0 ? (
        <p className="ats-muted">
          Every object already has a creation. Change the place to add one, or move another creation
          to the shelf first.
        </p>
      ) : (
        <label className="studio-place">
          <span>Put it on</span>
          <select
            className="ats-input"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            disabled={busy}
          >
            <option value="">Choose an object…</option>
            {rooms.map((room) => (
              <optgroup key={room} label={room}>
                {studio.freeObjects
                  .filter((o) => o.room === room)
                  .map((o) => (
                    <option key={o.key} value={o.key}>
                      {o.label}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </label>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      <div className="studio-actions">
        <Button variant="ghost" onClick={() => onDone(false)} disabled={busy}>
          Cancel
        </Button>
        {creation.objectKey && (
          <Button variant="ghost" onClick={() => void go(null)} disabled={busy}>
            <Icon name="archive" size={16} />
            Put it on the shelf
          </Button>
        )}
        {studio.freeObjects.length > 0 && (
          <Button variant="primary" onClick={() => void go(key)} disabled={busy || !key}>
            <Icon name="pin" size={16} />
            {busy ? 'Moving…' : 'Put it there'}
          </Button>
        )}
      </div>
    </section>
  );
}

function ShelfItem({
  creation,
  studio,
  onChanged,
}: {
  creation: StudioCreation;
  studio: Studio;
  onChanged: () => void;
}) {
  const [placing, setPlacing] = useState(false);
  return (
    <li className="studio-shelf-item">
      <div className="studio-build">
        <span className="studio-dot" aria-hidden="true" />
        <div className="studio-grow">
          <strong>{creation.title}</strong>
          <div className="ats-muted studio-small">
            {creation.versions.length} version{creation.versions.length === 1 ? '' : 's'}, saves
            kept
          </div>
        </div>
        {!placing && (
          <IconButton
            icon="pin"
            label={`Put ${creation.title} on an object`}
            onClick={() => setPlacing(true)}
          />
        )}
      </div>
      {placing && (
        <PlacePicker
          creation={creation}
          studio={studio}
          onDone={(changed) => {
            setPlacing(false);
            if (changed) onChanged();
          }}
        />
      )}
    </li>
  );
}

/** A new creation on a free object, built from a repository it then follows. */
function NewFromRepository({
  studio,
  hosts,
  spaceId,
  onDone,
}: {
  studio: Studio;
  hosts: SourceHostInfo[];
  spaceId: string;
  onDone: (started: string | null) => void;
}) {
  const [objectKey, setObjectKey] = useState('');
  const rooms = [...new Set(studio.freeObjects.map((o) => o.room))];
  if (!studio.freeObjects.length)
    return (
      <Notice>
        Every object already has a creation. Change the place to add one, or move a creation to the
        shelf first.{' '}
        <Button variant="ghost" onClick={() => onDone(null)}>
          OK
        </Button>
      </Notice>
    );
  return (
    <Section title="A creation from a repository">
      <p className="ats-muted">
        It’s fetched, checked like any creation and built; from then on it follows the repository,
        and you’ll see when there’s something newer.
      </p>
      <RepositoryForm
        hosts={hosts}
        submitLabel="Fetch and build it"
        onCancel={() => onDone(null)}
        onSubmit={async (s) => {
          if (!objectKey) throw new Error('Choose an object to put it on.');
          const r = await createFromRepository(spaceId, { ...s, objectKey });
          onDone(
            `Building ${s.repository}${r.label ? ` (${r.label})` : ''}: it appears below once it’s been checked.`,
          );
        }}
      >
        <label>
          <span>Put it on</span>
          <select
            className="ats-input"
            value={objectKey}
            onChange={(e) => setObjectKey(e.target.value)}
            required
          >
            <option value="">Choose an object…</option>
            {rooms.map((room) => (
              <optgroup key={room} label={room}>
                {studio.freeObjects
                  .filter((o) => o.room === room)
                  .map((o) => (
                    <option key={o.key} value={o.key}>
                      {o.label}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </label>
      </RepositoryForm>
    </Section>
  );
}

function CreationCard({
  creation,
  field,
  studio,
  hosts,
  spaceId,
  onChanged,
}: {
  creation: StudioCreation;
  field: FieldPerf[];
  studio: Studio;
  hosts: SourceHostInfo[];
  spaceId: string;
  onChanged: () => void;
}) {
  const navigate = useNavigate();
  const [moving, setMoving] = useState(false);
  const [linking, setLinking] = useState(false);
  // Improving a creation that follows a repository: it stops following it first (ADR 0011).
  const [detaching, setDetaching] = useState(false);
  const [detachError, setDetachError] = useState<string | null>(null);
  const improve = () =>
    navigate(
      `/space/${spaceId}/studio?${new URLSearchParams({ improve: creation.id, title: creation.title })}`,
    );
  const live = creation.versions.find((v) => v.live);
  // Folded, a card is a line or two: the newest version (and the live one, when something newer
  // waits to be tried) and what it follows. Open, it has every version and all their details.
  const [open, setOpen] = useState(false);
  const folded = creation.versions.filter((v, i) => i === 0 || v.live);
  const earlier = creation.versions.length - folded.length;
  const shown = open ? creation.versions : folded;
  const picture = [live, ...creation.versions].find((v) => v?.buildId && v.qa?.thumbnail);
  return (
    <li className="studio-creation">
      <div className="studio-creation-head">
        {picture?.buildId && picture.qa?.thumbnail ? (
          <img
            className="studio-thumb"
            src={reportFile(picture.buildId, picture.qa.thumbnail)}
            alt=""
            loading="lazy"
          />
        ) : (
          <div className="studio-thumb studio-thumb--empty" aria-hidden="true" />
        )}
        <div className="studio-grow">
          <h3>{creation.title}</h3>
          <div className="ats-muted">
            {creation.object ? `${creation.object.label}, ${creation.object.room}` : 'On the shelf'}{' '}
            · {MODE_WORDS[creation.defaultMode]}
            {creation.playing > 0 ? ` · ${creation.playing} inside now` : ''}
          </div>
        </div>
        <div className="studio-icon-actions">
          {live && (
            <IconButton
              icon="edit"
              label={`Improve ${creation.title}`}
              onClick={() => (creation.source ? setDetaching(true) : improve())}
            />
          )}
          {live && (
            <a
              className="ats-icon-button"
              href={creationExportUrl(creation.id)}
              download
              aria-label={`Download ${creation.title} (to import on another server)`}
              title={`Download ${creation.title}`}
            >
              <Icon name="download" />
            </a>
          )}
          {creation.objectKey && (
            <IconButton
              icon="pin"
              label={`Move ${creation.title} to another object`}
              disabled={moving}
              onClick={() => setMoving(true)}
            />
          )}
          {!creation.source && hosts.length > 0 && (
            <IconButton
              icon="link"
              label={`Make ${creation.title} follow a repository`}
              disabled={linking}
              onClick={() => setLinking(true)}
            />
          )}
        </div>
      </div>
      <div className="studio-creation-body">
        {detaching && creation.source && (
          <section className="studio-confirm" aria-label={`Improve ${creation.title} here`}>
            <p>
              {creation.title} comes from {creation.source.repository}. Improving it here stops it
              following the repository: from then on it’s changed in the Studio, and the repository
              is left as it is.
            </p>
            {detachError && <Notice tone="error">{detachError}</Notice>}
            <div className="studio-actions">
              <Button variant="ghost" onClick={() => setDetaching(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={async () => {
                  try {
                    await unlinkSource(creation.id);
                    improve();
                  } catch (e) {
                    setDetachError((e as Error).message);
                  }
                }}
              >
                <Icon name="edit" size={16} />
                Stop following it and improve here
              </Button>
            </div>
          </section>
        )}
        {creation.source && (
          <RepositoryPanel
            creationId={creation.id}
            title={creation.title}
            source={creation.source}
            hosts={hosts}
            folded={!open}
            onChanged={onChanged}
          />
        )}
        {linking && (
          <RepositoryForm
            hosts={hosts}
            submitLabel="Follow it"
            onCancel={() => setLinking(false)}
            onSubmit={async (s) => {
              await linkSource(creation.id, s);
              setLinking(false);
              onChanged();
            }}
          >
            <p className="ats-muted">
              From then on {creation.title} is changed in the repository: Update builds the newest
              of it, through the same checks as any version.
            </p>
          </RepositoryForm>
        )}
        {moving && (
          <PlacePicker
            creation={creation}
            studio={studio}
            onDone={(changed) => {
              setMoving(false);
              if (changed) onChanged();
            }}
          />
        )}
        <ol className="studio-versions">
          {shown.map((v) => (
            <VersionRow
              key={v.id}
              creation={creation}
              field={field.filter((f) => f.creationVersionId === v.id)}
              version={v}
              liveVersion={live}
              details={open}
              spaceId={spaceId}
              onChanged={onChanged}
            />
          ))}
        </ol>
        <button
          type="button"
          className="studio-unfold"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <Icon name={open ? 'chevronUp' : 'chevronDown'} size={16} />
          {open
            ? 'Fewer details'
            : earlier > 0
              ? `Details and ${earlier} earlier version${earlier === 1 ? '' : 's'}`
              : 'Details'}
        </button>
      </div>
    </li>
  );
}

function VersionRow({
  creation,
  field,
  version: v,
  liveVersion,
  details,
  spaceId,
  onChanged,
}: {
  creation: StudioCreation;
  field: FieldPerf[];
  version: StudioVersion;
  liveVersion: StudioVersion | undefined;
  /** Everything about it, or (folded) just how its checks went. */
  details: boolean;
  spaceId: string;
  onChanged: () => void;
}) {
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = v.live ? 'Live' : v.status === 'candidate' ? 'Ready to try' : 'Earlier';
  const checks = !v.qa
    ? 'Not checked'
    : v.qa.unchecked === 'imported'
      ? 'Imported: not checked on this server'
      : v.qa.ok
        ? v.qa.warned
          ? `Passed, ${v.qa.warned} note${v.qa.warned === 1 ? '' : 's'}`
          : 'Passed its checks'
        : "Didn't pass";
  // Not if it failed its checks; an imported one (never checked here) may.
  const mayGoLive = v.qa?.ok !== false || v.qa.unchecked === 'imported';
  const older = liveVersion && v.number < liveVersion.number;
  // Going back past a change in how data is saved: the older version can't read newer saves.
  const dataRisk =
    liveVersion?.saveVersion != null &&
    v.saveVersion != null &&
    v.saveVersion < liveVersion.saveVersion;
  // Connectors it uses that aren't approved for this version yet: approved as it goes live.
  const waiting = v.connectors
    .map((c) => ({ ...c, missing: c.ops.filter((op) => !c.approvedOps.includes(op)) }))
    .filter((c) => c.missing.length);
  const cantApprove = waiting.some(
    (c) => !c.displayName || c.operations.some((o) => c.missing.includes(o.name) && !o.kind),
  );
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      if (waiting.length)
        await approveConnectors(
          creation.id,
          v.id,
          waiting.map((c) => ({ id: c.id, ops: c.missing })),
        );
      await makeLive(creation.id, v.id);
      setConfirming(false);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="studio-version" data-live={v.live}>
      <div className="studio-version-main">
        <div className="studio-grow">
          <strong>Version {v.number}</strong>{' '}
          <span className={`studio-tag studio-tag--${v.live ? 'live' : v.status}`}>{status}</span>
          {!details && <span className="ats-muted studio-small"> · {checks}</span>}
          {details && (
            <>
              <div className="ats-muted studio-small">
                {checks} · {date(v.createdAt)} · {size(v.bytes)}
                {v.sourceCommit ? ` · from ${short(v.sourceCommit)}` : ''}
              </div>
              {v.connectors.map((c) => (
                <ConnectorUse key={c.id} connector={c} />
              ))}
              {byForm(field).map((f) => (
                <div key={f.form} className="studio-small">
                  <span className={`studio-dot studio-dot--${f.tone}`} aria-hidden="true" />{' '}
                  {f.word} on people's {f.form.toLowerCase()} ({f.samples} reports)
                </div>
              ))}
              {v.deviceTests.slice(-3).map((t) => {
                const s = smoothness(t.p95Ms);
                return (
                  <div key={t.at} className="studio-small">
                    <span className={`studio-dot studio-dot--${s.tone}`} aria-hidden="true" />{' '}
                    {s.word} on {t.device} ({Math.round(t.fps)} fps)
                  </div>
                );
              })}
            </>
          )}
        </div>
        <div className="studio-icon-actions">
          {v.buildId && (
            <IconButton
              icon="list"
              label={`Version ${v.number}: its check report`}
              onClick={() => navigate(`/space/${spaceId}/builds/${v.buildId}`)}
            />
          )}
          <IconButton
            icon="play"
            label={`Try version ${v.number}`}
            onClick={() => navigate(`/space/${spaceId}/creations/${creation.id}/try/${v.id}`)}
          />
          {!v.live && mayGoLive && older && (
            <IconButton
              icon="revert"
              label={`Go back to version ${v.number}`}
              disabled={confirming}
              onClick={() => setConfirming(true)}
            />
          )}
          {!v.live && mayGoLive && !older && (
            <Button
              variant={v.status === 'candidate' ? 'primary' : 'ghost'}
              onClick={() => setConfirming(true)}
            >
              Make live
            </Button>
          )}
        </div>
      </div>
      {confirming && (
        <section className="studio-confirm" aria-label={`Make version ${v.number} live`}>
          <p>
            {older
              ? `Everyone who opens ${creation.title} from now on gets version ${v.number}.`
              : `Version ${v.number} goes live now.`}{' '}
            Anyone already inside carries on where they are.
          </p>
          {waiting.length > 0 && <ConnectorApproval connectors={waiting} title={creation.title} />}
          {dataRisk && older && (
            <Notice tone="error">
              Version {liveVersion?.number} saves things differently, and version {v.number} can't
              change what it saved. Some people's progress would stop saving until you make a newer
              version live again.
            </Notice>
          )}
          {error && <Notice tone="error">{error}</Notice>}
          <div className="studio-actions">
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void go()} disabled={busy || cantApprove}>
              {busy
                ? 'Working…'
                : waiting.length
                  ? 'Allow and make it live'
                  : older
                    ? `Go back to version ${v.number}`
                    : 'Make it live'}
            </Button>
          </div>
        </section>
      )}
    </li>
  );
}

/** A connected service a version uses, and whether that's approved; a long list folds away. */
function ConnectorUse({ connector: c }: { connector: StudioVersionConnector }) {
  const approved = c.ops.every((op) => c.approvedOps.includes(op));
  const dot = (
    <span className={`studio-dot studio-dot--${approved ? 'good' : 'ok'}`} aria-hidden="true" />
  );
  const state = approved ? 'approved' : 'needs approving';
  return c.ops.length > 3 ? (
    <details className="studio-small studio-uses">
      <summary>
        {dot} Uses {c.displayName ?? c.id} ({c.ops.length} operations) · {state}
      </summary>
      {c.ops.join(', ')}
    </details>
  ) : (
    <div className="studio-small">
      {dot} Uses {c.displayName ?? c.id} ({c.ops.join(', ')}) · {state}
    </div>
  );
}

/**
 * What a version asks to use of services the server's owner connected (connectors), for an
 * Architect to allow before it goes live: each operation, whether it reads or changes things, and
 * the creation's own reason. Everyone who uses it does so with their own linked account.
 */
function ConnectorApproval({
  connectors,
  title,
}: {
  connectors: (StudioVersionConnector & { missing: string[] })[];
  title: string;
}) {
  return (
    <div className="studio-approval">
      <p>
        {title} asks to use services this server connects to. Each person who opens it uses their
        own account there, and only for what you allow here.
      </p>
      {connectors.map((c) => (
        <section key={c.id} aria-label={c.displayName ?? c.id}>
          <h4>{c.displayName ?? c.id}</h4>
          {c.why && <p className="ats-muted">“{c.why}”</p>}
          {!c.displayName ? (
            <Notice tone="error">
              {c.id} isn’t set up on this server, so this version can’t go live here. Ask the
              server’s owner to install it.
            </Notice>
          ) : (
            <ul className="studio-approval-ops">
              {c.operations
                .filter((o) => c.missing.includes(o.name))
                .map((o) => (
                  <li key={o.name}>
                    <strong>{o.name}</strong>{' '}
                    {o.kind === null ? (
                      <span className="studio-small">: not on this server</span>
                    ) : (
                      <span className="ats-muted studio-small">
                        {o.kind === 'write' ? 'changes things' : 'reads'} · {o.scope}
                      </span>
                    )}
                  </li>
                ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}
