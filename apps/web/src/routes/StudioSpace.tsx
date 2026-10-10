import { Button, Field, Icon, IconButton, Notice, Section } from '@ats/ui';
import { type ReactNode, useEffect, useId, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import {
  type AssistantDefaults,
  AssistantPicker,
  type Picked,
  useAssistantDefaults,
} from '../components/AssistantPicker.tsx';
import { BackLink } from '../components/BackLink.tsx';
import { EarlierToggle } from '../components/EarlierToggle.tsx';
import { LightingLine } from '../components/LightingLine.tsx';
import { ago } from '../components/NotificationBell.tsx';
import {
  makePlaceVersionLive,
  type PlaceVersion,
  placeVersions,
  startPlaceWorkspace,
} from '../lib/places.ts';
import { byForm, loadFieldPerf } from '../lib/studio.ts';
import { placeExportUrl } from '../lib/transfer.ts';
import {
  type Assistant,
  createWorkspace,
  loadAssistants,
  loadWorkspaces,
  type WorkspaceSummary,
} from '../lib/workbench.ts';
import './studio.css';

type Loaded = Awaited<ReturnType<typeof loadWorkspaces>>;

/** A label (and hint) for a select or text area, styled like the shared fields. */
function Labelled({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="ats-field">
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {hint && <span className="ats-hint">{hint}</span>}
    </div>
  );
}

/** The Studio for one space: workspaces, a new creation, and how the Studio behaves. */
export function StudioSpace() {
  const { spaceId } = useParams();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [data, setData] = useState<Loaded | null>(null);
  const [assistants, setAssistants] = useState<Assistant[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!spaceId) return;
    loadWorkspaces(spaceId).then(setData, (e: Error) => setError(e.message));
    loadAssistants().then(
      (r) => setAssistants(r.assistants),
      () => {},
    );
  }, [spaceId]);
  const ready = assistants.filter((a) => a.installed && a.signedIn);
  const defaults = useAssistantDefaults(data?.space.groupId);

  return (
    <main className="ats-screen">
      <div className="ats-container ats-stack studio-wide">
        <header className="ats-stack" style={{ gap: 6 }}>
          <div className="studio-actions-row" style={{ justifyContent: 'space-between' }}>
            <BackLink to="/" label="Your spaces" />
            <div className="studio-actions-row">
              <Link
                className="ats-button ats-button--ghost"
                to={`/studio/requests?space=${spaceId}`}
              >
                <Icon name="inbox" size={16} />
                Requests
              </Link>
              <Link className="ats-button ats-button--ghost" to={`/space/${spaceId}/creations`}>
                <Icon name="box" size={16} />
                Creations
              </Link>
            </div>
          </div>
          <h1>Studio{data ? ` · ${data.space.name}` : ''}</h1>
          <p className="ats-muted">
            Build creations with your AI assistant. Each one gets its own workspace: a terminal
            where you talk to your assistant, and a live preview that updates as it works.
          </p>
        </header>
        {error && <Notice tone="error">{error}</Notice>}
        {data && !data.available && <Notice>The Studio isn’t set up on this server yet.</Notice>}

        <p className="studio-status" data-state={ready.length ? 'connected' : 'new'}>
          <span className="studio-dot" aria-hidden="true" />
          {ready.length
            ? `Your assistant: ${ready.map((a) => a.name).join(' and ')}`
            : 'Connect your AI assistant to start building.'}{' '}
          <Link to="/studio/assistants">{ready.length ? 'AI assistants' : 'Connect one'}</Link>
        </p>

        {data && (
          <>
            <Section title="Workspaces">
              {data.workspaces.length === 0 ? (
                <p className="ats-muted">None yet: start one below.</p>
              ) : (
                <ul className="studio-list">
                  {data.workspaces.map((w) => (
                    <WorkspaceRow key={w.id} w={w} spaceId={spaceId ?? ''} />
                  ))}
                </ul>
              )}
            </Section>
            <ChangePlace
              spaceId={spaceId ?? ''}
              assistants={ready}
              defaults={defaults}
              workspaces={data.workspaces.filter((w) => w.kind === 'space' && w.mine)}
              onStarted={(id) => navigate(`/space/${spaceId}/studio/${id}`)}
            />
            <NewCreation
              spaceId={spaceId ?? ''}
              objects={data.objects}
              assistants={ready}
              defaults={defaults}
              improve={params.get('improve')}
              improveTitle={params.get('title')}
              onCreated={(id) => navigate(`/space/${spaceId}/studio/${id}`)}
            />
            <p className="ats-muted studio-small">
              When workspaces sleep, the model and effort they start with, and what a creation needs
              before it goes live: <Link to="/group/settings">Group settings</Link>.
            </p>
          </>
        )}
      </div>
    </main>
  );
}

function WorkspaceRow({ w, spaceId }: { w: WorkspaceSummary; spaceId: string }) {
  return (
    <li className="studio-build">
      <span
        className={`studio-dot studio-dot--${w.status === 'running' ? 'good' : 'idle'}`}
        aria-hidden="true"
      />
      <div className="studio-grow">
        <strong>{w.title}</strong>
        <div className="ats-muted studio-small">
          {w.kind === 'space' ? 'The place itself' : (w.where ?? 'Not placed')} ·{' '}
          {w.status === 'running' ? 'Awake' : w.status === 'ready' ? 'Not started yet' : 'Asleep'}
          {w.mine ? '' : ' · another Architect’s'}
        </div>
      </div>
      {w.mine && (
        <Link
          className="ats-icon-button"
          to={`/space/${spaceId}/studio/${w.id}`}
          aria-label={`Open ${w.title}`}
          title={`Open ${w.title}`}
        >
          <Icon name="chevronRight" />
        </Link>
      )}
    </li>
  );
}

function NewCreation({
  spaceId,
  objects,
  assistants,
  improve,
  improveTitle,
  onCreated,
  defaults,
}: {
  spaceId: string;
  objects: { key: string; label: string; room: string }[];
  assistants: Assistant[];
  defaults: AssistantDefaults | null;
  improve: string | null;
  improveTitle: string | null;
  onCreated: (id: string) => void;
}) {
  const [title, setTitle] = useState(improveTitle ?? '');
  const [brief, setBrief] = useState('');
  const [objectKey, setObjectKey] = useState('');
  const [picked, setPicked] = useState<Picked>({ provider: '', model: null, effort: null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rooms = useMemo(() => [...new Set(objects.map((o) => o.room))], [objects]);
  const chosen = picked.provider || assistants[0]?.provider || '';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      const { id } = await createWorkspace(spaceId, {
        title,
        brief,
        objectKey: improve ? null : objectKey || null,
        provider: chosen,
        model: picked.model,
        effort: picked.effort,
        ...(improve ? { creationId: improve } : {}),
      });
      onCreated(id);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <Section title={improve ? `Improve ${improveTitle ?? 'a creation'}` : 'A new creation'}>
      <form className="ats-stack" onSubmit={(e) => void submit(e)}>
        <Field
          label="What’s it called?"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          maxLength={80}
        />
        <Labelled
          label={improve ? 'What should change?' : 'What should it be?'}
          hint="In your own words, as much or as little as you like. Your assistant reads this first."
        >
          {(id) => (
            <textarea
              id={id}
              className="ats-input studio-brief"
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              required
              maxLength={10000}
              rows={6}
            />
          )}
        </Labelled>
        {!improve && (
          <Labelled label="Where does it live?">
            {(id) => (
              <select
                id={id}
                className="ats-input"
                value={objectKey}
                onChange={(e) => setObjectKey(e.target.value)}
              >
                <option value="">Not placed yet</option>
                {rooms.map((room) => (
                  <optgroup key={room} label={room}>
                    {objects
                      .filter((o) => o.room === room)
                      .map((o) => (
                        <option key={o.key} value={o.key}>
                          {o.label}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </select>
            )}
          </Labelled>
        )}
        <AssistantPicker
          assistants={assistants}
          value={picked}
          onChange={setPicked}
          defaults={defaults}
        />
        {error && <Notice tone="error">{error}</Notice>}
        <div>
          <Button variant="primary" type="submit" disabled={!chosen} busy={busy}>
            {busy ? 'Preparing the workspace…' : 'Create workspace'}
          </Button>
          {!chosen && (
            <span className="ats-muted studio-small"> Connect your assistant first.</span>
          )}
        </div>
      </form>
    </Section>
  );
}

/** Changing the place itself (rooms, furniture, floors), and going back to an earlier version. */
function ChangePlace({
  spaceId,
  assistants,
  workspaces,
  onStarted,
  defaults,
}: {
  spaceId: string;
  assistants: Assistant[];
  defaults: AssistantDefaults | null;
  /** This Architect's workspaces for the place itself. */
  workspaces: WorkspaceSummary[];
  onStarted: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [what, setWhat] = useState('');
  const [versions, setVersions] = useState<PlaceVersion[] | null>(null);
  const [allVersions, setAllVersions] = useState(false);
  // Folded to the newest version (and the live one, if that's an earlier one).
  const folded = versions?.filter((v, i) => i === 0 || v.live) ?? [];
  const [liveSince, setLiveSince] = useState<string | null>(null);
  const [field, setField] = useState<ReturnType<typeof byForm>>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () =>
    placeVersions(spaceId).then(
      (r) => {
        setVersions(r.versions);
        setLiveSince(r.liveSince ?? r.versions.find((v) => v.live)?.publishedAt ?? null);
      },
      () => setVersions([]),
    );
  // biome-ignore lint/correctness/useExhaustiveDependencies: load once per space
  useEffect(() => {
    void load();
    loadFieldPerf(spaceId).then(
      (r) => setField(byForm(r.space)),
      () => {},
    );
  }, [spaceId]);
  const [picked, setPicked] = useState<Picked>({ provider: '', model: null, effort: null });
  const provider = picked.provider || assistants[0]?.provider;
  // A change under way: a workspace opened since the live version went live, or was gone back
  // to (older ones, like the one the place was first built in, are out of date).
  const changing = liveSince
    ? (workspaces.find((w) => new Date(w.createdAt) > new Date(liveSince)) ?? null)
    : null;

  const start = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!provider) return;
    setBusy('start');
    setError(null);
    try {
      const { id } = await startPlaceWorkspace(spaceId, provider, what, {
        model: picked.model,
        effort: picked.effort,
      });
      onStarted(id);
    } catch (err) {
      setError((err as Error).message);
      setBusy(null);
    }
  };
  const goBack = async (v: PlaceVersion) => {
    setBusy(v.id);
    setError(null);
    try {
      const r = await makePlaceVersionLive(spaceId, v.id);
      setNote(
        `Version ${v.number} is live again${r.shelved ? `; ${r.shelved} creation${r.shelved === 1 ? '' : 's'} went on the shelf (their object isn’t in it)` : ''}.`,
      );
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(null);
  };

  return (
    <Section title="The place itself">
      <p className="ats-muted">
        Add a room or a floor, move furniture, or rebuild a room: your assistant changes the plan,
        you walk through the new version, then publish it. Rooms you don’t change stay exactly as
        they are, and creations stay on their objects.
      </p>
      <LightingLine report={versions?.find((v) => v.live)?.lighting ?? null} />
      {changing ? (
        <div className="studio-actions-row">
          <Link
            className="ats-button ats-button--primary"
            to={`/space/${spaceId}/studio/${changing.id}`}
          >
            Carry on changing it
          </Link>
        </div>
      ) : !open ? (
        <div className="studio-actions-row">
          <Button onClick={() => setOpen(true)} disabled={!provider}>
            <Icon name="edit" size={16} />
            Change this place…
          </Button>
          {versions?.some((v) => v.live) && (
            <a className="ats-button ats-button--ghost" href={placeExportUrl(spaceId)} download>
              <Icon name="download" size={16} />
              Download this place
            </a>
          )}
          {!provider && (
            <span className="ats-muted studio-small"> Connect your assistant first.</span>
          )}
        </div>
      ) : (
        <form className="ats-stack" onSubmit={(e) => void start(e)}>
          <Labelled
            label="What should change?"
            hint="In your own words: “Add the attic as a new floor”, “The sofa moved to the window”."
          >
            {(id) => (
              <textarea
                id={id}
                className="ats-input studio-brief"
                rows={4}
                maxLength={10000}
                value={what}
                onChange={(e) => setWhat(e.target.value)}
                required
              />
            )}
          </Labelled>
          <AssistantPicker
            assistants={assistants}
            value={picked}
            onChange={setPicked}
            defaults={defaults}
          />
          <div className="studio-actions-row">
            <Button variant="primary" type="submit" disabled={!what.trim()} busy={busy === 'start'}>
              {busy === 'start' ? 'Preparing the workspace…' : 'Start changing it'}
            </Button>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy === 'start'}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {versions && versions.length > 1 && (
        <div className="ats-stack" style={{ gap: 8 }}>
          <h3 className="studio-subhead">Versions</h3>
          <ul className="studio-list">
            {(allVersions ? versions : folded).map((v) => (
              <li key={v.id} className="studio-build">
                <span
                  className={`studio-dot ${v.live ? 'studio-dot--good' : ''}`}
                  aria-hidden="true"
                />
                <div className="studio-grow">
                  <strong>Version {v.number}</strong>
                  <div className="ats-muted studio-small">
                    {v.live ? 'Live · ' : ''}
                    {v.rooms} rooms, {v.objects} objects · {ago(v.publishedAt)}
                    {v.lighting && v.lighting.rooms > 0
                      ? v.lighting.baked
                        ? ' · lighting baked'
                        : ' · lighting not baked'
                      : ''}
                  </div>
                </div>
                {!v.live &&
                  (v.number < (versions.find((x) => x.live)?.number ?? 0) ? (
                    <IconButton
                      icon="revert"
                      label={
                        busy === v.id
                          ? `Going back to version ${v.number}…`
                          : `Go back to version ${v.number}`
                      }
                      onClick={() => void goBack(v)}
                      disabled={busy !== null}
                      busy={busy === v.id}
                    />
                  ) : (
                    <Button
                      variant="ghost"
                      onClick={() => void goBack(v)}
                      disabled={busy !== null}
                      busy={busy === v.id}
                    >
                      {busy === v.id ? 'Making it live…' : 'Make this live'}
                    </Button>
                  ))}
              </li>
            ))}
          </ul>
          {versions.length > folded.length && (
            <EarlierToggle
              open={allVersions}
              count={versions.length - folded.length}
              onToggle={() => setAllVersions((v) => !v)}
            />
          )}
        </div>
      )}
      {field.length > 0 && (
        <div className="ats-stack" style={{ gap: 4 }}>
          <h3 className="studio-subhead">How smoothly it runs</h3>
          {field.map((f) => (
            <div key={f.form} className="studio-small">
              <span className={`studio-dot studio-dot--${f.tone}`} aria-hidden="true" /> {f.word} on
              people's {f.form.toLowerCase()} ({f.samples} reports, last 30 days)
            </div>
          ))}
        </div>
      )}
      {note && <Notice>{note}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
    </Section>
  );
}
