import { Button, Icon, type IconName, Notice, Section } from '@ats/ui';
import { type ReactNode, useCallback, useEffect, useId, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { BackLink } from '../components/BackLink.tsx';
import { ago } from '../components/NotificationBell.tsx';
import {
  acceptRequest,
  addNote,
  declineRequest,
  documentUrl,
  finishRequest,
  KIND_WORDS,
  loadRequest,
  myRequests,
  notQuite,
  pictureUrl,
  type RequestDetail,
  type RequestEvent,
  type RequestSummary,
  requestQueue,
  STEPS,
  startRequestWorkspace,
  stepOf,
  updateRequest,
  whereOf,
  withdrawRequest,
} from '../lib/requests.ts';
import { type Assistant, loadAssistants, type Provider } from '../lib/workbench.ts';
import './requests.css';
import './studio.css';
import {
  AssistantPicker,
  type Picked,
  useAssistantDefaults,
} from '../components/AssistantPicker.tsx';

function Page({ back, title, children }: { back: ReactNode; title: string; children: ReactNode }) {
  return (
    <main className="ats-screen">
      <div className="ats-container ats-stack studio-wide">
        <header className="ats-stack" style={{ gap: 6 }}>
          <div className="studio-actions-row">{back}</div>
          <h1>{title}</h1>
        </header>
        {children}
      </div>
    </main>
  );
}

function StatusPill({ r }: { r: Pick<RequestSummary, 'status' | 'statusWords'> }) {
  return (
    <span className="req-pill" data-status={r.status}>
      {r.statusWords}
    </span>
  );
}

/** Where a request is up to: Sent → Accepted → Being built → Ready to try. */
function Steps({ r }: { r: RequestSummary }) {
  const at = stepOf(r.status);
  if (at < 0) return <StatusPill r={r} />;
  return (
    <ol className="req-steps" aria-label={`Where it's up to: ${r.statusWords}`}>
      {STEPS.map((s, i) => (
        <li key={s} data-state={i < at ? 'done' : i === at ? 'now' : 'later'}>
          {s}
        </li>
      ))}
    </ol>
  );
}

const KIND_ICON: Record<RequestSummary['kind'], IconName> = {
  new: 'sparkles',
  improve: 'edit',
  bug: 'alert',
};

function RequestRow({ r, to, architect }: { r: RequestSummary; to: string; architect?: boolean }) {
  return (
    <li>
      <Link className="req-row" to={to}>
        <Icon name={KIND_ICON[r.kind]} className="req-kind" />
        <div className="studio-grow">
          <strong>{r.title}</strong>
          <div className="ats-muted studio-small">
            {KIND_WORDS[r.kind]} · {whereOf(r)}
            {architect && r.requesterName ? ` · from ${r.requesterName}` : ''} · {ago(r.createdAt)}
          </div>
        </div>
        {architect && r.open && r.priority !== 'normal' && (
          <span className="req-priority" data-priority={r.priority}>
            {r.priority === 'high' ? 'High' : 'Low'}
          </span>
        )}
        <StatusPill
          r={architect && r.status === 'submitted' ? { status: r.status, statusWords: 'New' } : r}
        />
        <Icon name="chevronRight" size={16} className="req-open" />
      </Link>
    </li>
  );
}

// ---- Members ------------------------------------------------------------------------------------

/** Everything you've asked for, and where each is up to. */
export function MyRequests() {
  const [list, setList] = useState<RequestSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    myRequests().then(setList, (e: Error) => setError(e.message));
  }, []);
  const toTry = list?.filter((r) => r.status === 'published') ?? [];
  const open = list?.filter((r) => r.open) ?? [];
  const closed = list?.filter((r) => !r.open && r.status !== 'published') ?? [];
  return (
    <Page back={<BackLink to="/" label="Your spaces" />} title="My requests">
      <p className="ats-muted">
        What you've asked the Architects for. To ask for something, go into a space, press{' '}
        <strong>Ask for something</strong> and draw a box around it.
      </p>
      {error && <Notice tone="error">{error}</Notice>}
      {list && list.length === 0 && <p className="ats-muted">Nothing yet.</p>}
      {toTry.length > 0 && (
        <Section title="Ready to try">
          <p className="ats-muted">Try each one, then say whether it's what you asked for.</p>
          <ul className="req-list">
            {toTry.map((r) => (
              <RequestRow key={r.id} r={r} to={`/requests/${r.id}`} />
            ))}
          </ul>
        </Section>
      )}
      {open.length > 0 && (
        <Section title="Waiting">
          <ul className="req-list">
            {open.map((r) => (
              <RequestRow key={r.id} r={r} to={`/requests/${r.id}`} />
            ))}
          </ul>
        </Section>
      )}
      {closed.length > 0 && (
        <Section title="Done">
          <ul className="req-list">
            {closed.map((r) => (
              <RequestRow key={r.id} r={r} to={`/requests/${r.id}`} />
            ))}
          </ul>
        </Section>
      )}
    </Page>
  );
}

function Pictures({ r }: { r: RequestSummary }) {
  if (r.images.length === 0) return null;
  const names: Record<string, string> = { snapshot: 'What was picked', sketch: 'Sketch' };
  return (
    <div className="req-pictures">
      {r.images.map((name) => (
        <a key={name} href={pictureUrl(r.id, name)} target="_blank" rel="noreferrer">
          <img src={pictureUrl(r.id, name)} alt={names[name] ?? 'Added by the member'} />
          <span>{names[name] ?? 'Added'}</span>
        </a>
      ))}
    </div>
  );
}

/** Documents that came with it: each opens as plain text. */
function Documents({ r }: { r: RequestSummary }) {
  if (r.documents.length === 0) return null;
  return (
    <ul className="req-documents">
      {r.documents.map((d) => (
        <li key={d.name}>
          <a href={documentUrl(r.id, d.name)} target="_blank" rel="noreferrer">
            <Icon name="list" size={16} />
            {d.file}
          </a>
        </li>
      ))}
    </ul>
  );
}

function Timeline({ events }: { events: RequestEvent[] }) {
  return (
    <ol className="req-timeline">
      {events.map((e) => (
        <li key={e.id} data-architect={e.byArchitect || undefined}>
          <div className="req-timeline-head">
            <strong>{e.statusWords ?? 'A note'}</strong>
            <span className="ats-muted">
              {e.by ? ` · ${e.by}` : ''} · <time dateTime={e.at}>{ago(e.at)}</time>
            </span>
          </div>
          {e.note && <p>{e.note}</p>}
        </li>
      ))}
    </ol>
  );
}

function NoteForm({
  label,
  onSend,
  onCancel,
}: {
  label: string;
  onSend: (note: string) => Promise<void>;
  onCancel?: () => void;
}) {
  const id = useId();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="ats-stack"
      style={{ gap: 8 }}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await onSend(note);
          setNote('');
        } catch (err) {
          setError((err as Error).message);
        }
        setBusy(false);
      }}
    >
      <div className="ats-field">
        <label htmlFor={id}>{label}</label>
        <textarea
          id={id}
          className="ats-input"
          rows={3}
          maxLength={2000}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          required
        />
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="studio-actions-row">
        <Button type="submit" disabled={busy || !note.trim()}>
          {busy ? 'Sending…' : 'Send'}
        </Button>
        {onCancel && (
          <Button variant="ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

/** One request: for the person who asked (or, at /space/…/requests/…, for Architects). */
export function RequestPage() {
  const { requestId, spaceId } = useParams();
  const architectView = Boolean(spaceId);
  const navigate = useNavigate();
  const [data, setData] = useState<{ request: RequestDetail; events: RequestEvent[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(
    () => loadRequest(requestId ?? '').then(setData, (e: Error) => setError(e.message)),
    [requestId],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const back = architectView ? (
    <BackLink to="/studio/requests" label="All requests" />
  ) : (
    <BackLink to="/requests" label="My requests" />
  );
  if (!data)
    return (
      <Page back={back} title="Request">
        {error ? <Notice tone="error">{error}</Notice> : <p className="ats-muted">Loading…</p>}
      </Page>
    );
  const r = data.request;
  const isArchitect = architectView && r.priority !== undefined;

  return (
    <Page back={back} title={r.title}>
      <p className="ats-muted">
        {KIND_WORDS[r.kind]} · {whereOf(r)}
        {isArchitect && r.requesterName ? ` · from ${r.requesterName}` : ''}
      </p>
      <Steps r={r} />
      {(r.status === 'published' || r.status === 'done') && (
        <div>
          <Button
            variant={r.status === 'published' ? 'primary' : 'secondary'}
            onClick={() =>
              navigate(
                `/space/${r.spaceId}${r.objectKey ? `?object=${encodeURIComponent(r.objectKey)}` : ''}`,
              )
            }
          >
            {r.status === 'published' ? 'Go and try it' : 'Go to it'}
          </Button>
        </div>
      )}
      {r.canFinish && <TriedIt r={r} onChanged={load} />}

      <Section title={r.mine ? 'What you asked' : 'In their words'}>
        <blockquote className="req-words">{r.prompt}</blockquote>
        <Documents r={r} />
        <Pictures r={r} />
      </Section>

      {isArchitect && <ArchitectPanel r={r} onChanged={load} />}

      <Section title="What's happened">
        <Timeline events={data.events} />
        {r.open && (
          <NoteForm
            label={
              isArchitect ? 'A note for the person who asked' : 'Add more detail for the Architects'
            }
            onSend={async (note) => {
              await addNote(r.id, note);
              await load();
            }}
          />
        )}
        {r.canWithdraw && (
          <div>
            <Button
              variant="ghost"
              onClick={async () => {
                await withdrawRequest(r.id).catch((e: Error) => setError(e.message));
                await load();
              }}
            >
              <Icon name="close" size={16} />I don't need this any more
            </Button>
          </div>
        )}
        {error && <Notice tone="error">{error}</Notice>}
      </Section>
    </Page>
  );
}

/** Ready to try, for the person who asked: that's it (done), or not quite (back, saying why). */
function TriedIt({ r, onChanged }: { r: RequestDetail; onChanged: () => Promise<unknown> }) {
  const [saying, setSaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Section title="Is it what you asked for?">
      <p className="ats-muted">
        Once you've tried it, tell the Architects. If it isn't right yet, say what's missing and it
        goes back to them.
      </p>
      {saying ? (
        <NoteForm
          label="What isn't right yet? (the Architects will see this)"
          onSend={async (note) => {
            await notQuite(r.id, note);
            await onChanged();
          }}
          onCancel={() => setSaying(false)}
        />
      ) : (
        <div className="studio-actions-row">
          <Button
            busy={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              await finishRequest(r.id).then(onChanged, (e: Error) => setError(e.message));
              setBusy(false);
            }}
          >
            <Icon name="check" size={16} />
            {busy ? 'Marking it done…' : "That's it"}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => setSaying(true)}>
            Not quite…
          </Button>
        </div>
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </Section>
  );
}

// ---- Architects ---------------------------------------------------------------------------------

/** Every request in your groups: open ones first, most important first. */
export function RequestQueue() {
  const [params] = useSearchParams();
  const only = params.get('space');
  const [list, setList] = useState<RequestSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    requestQueue().then(setList, (e: Error) => setError(e.message));
  }, []);
  const shown = (list ?? []).filter((r) => !only || r.spaceId === only);
  const open = shown.filter((r) => r.open);
  const closed = shown.filter((r) => !r.open);
  const spaceName = only ? shown[0]?.spaceName : null;
  // Back to where this list is reached from: a place's Studio (one space's), or home.
  const back = only ? (
    <BackLink to={`/space/${only}/studio`} label="Studio" />
  ) : (
    <BackLink to="/" label="Your spaces" />
  );
  return (
    <Page back={back} title={`Requests${spaceName ? ` · ${spaceName}` : ''}`}>
      <p className="ats-muted">
        What members have asked for. Nothing is built until you start it: accept a request (or
        decline it with a word of why), then start building it with your assistant.
      </p>
      {error && <Notice tone="error">{error}</Notice>}
      {list && open.length === 0 && <p className="ats-muted">No requests waiting.</p>}
      {open.length > 0 && (
        <Section title={`Waiting (${open.length})`}>
          <ul className="req-list">
            {open.map((r) => (
              <RequestRow key={r.id} r={r} to={`/space/${r.spaceId}/requests/${r.id}`} architect />
            ))}
          </ul>
        </Section>
      )}
      {closed.length > 0 && (
        <Section title="Recently done">
          <ul className="req-list">
            {closed.map((r) => (
              <RequestRow key={r.id} r={r} to={`/space/${r.spaceId}/requests/${r.id}`} architect />
            ))}
          </ul>
        </Section>
      )}
    </Page>
  );
}

function ArchitectPanel({ r, onChanged }: { r: RequestDetail; onChanged: () => Promise<unknown> }) {
  const navigate = useNavigate();
  const ids = { title: useId(), brief: useId(), priority: useId(), effort: useId() };
  const [title, setTitle] = useState(r.title);
  const [brief, setBrief] = useState(r.brief ?? r.prompt);
  const [priority, setPriority] = useState(r.priority ?? 'normal');
  const [effort, setEffort] = useState(r.effort ?? '');
  const [saved, setSaved] = useState<string | null>(null);
  const [declining, setDeclining] = useState(false);
  const [assistants, setAssistants] = useState<Assistant[]>([]);
  const [picked, setPicked] = useState<Picked>({ provider: '', model: null, effort: null });
  const defaults = useAssistantDefaults(r.groupId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    loadAssistants().then(
      (a) => setAssistants(a.assistants.filter((x) => x.installed && x.signedIn)),
      () => {},
    );
  }, []);
  const chosen = picked.provider || assistants[0]?.provider || '';

  const save = async () => {
    setError(null);
    await updateRequest(r.id, {
      title,
      brief: brief.trim() === r.prompt.trim() ? null : brief,
      priority,
      effort: effort ? (effort as 'small' | 'medium' | 'large') : null,
    }).then(
      () => setSaved('Saved.'),
      (e: Error) => setError(e.message),
    );
  };
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };

  return (
    <Section title="For the Architects">
      {r.open && (
        <div className="ats-stack">
          <div className="req-fields">
            <div className="ats-field">
              <label htmlFor={ids.priority}>Priority</label>
              <select
                id={ids.priority}
                className="ats-input"
                value={priority}
                onChange={(e) => setPriority(e.target.value as 'low' | 'normal' | 'high')}
              >
                <option value="high">High</option>
                <option value="normal">Normal</option>
                <option value="low">Low</option>
              </select>
            </div>
            <div className="ats-field">
              <label htmlFor={ids.effort}>How big is it?</label>
              <select
                id={ids.effort}
                className="ats-input"
                value={effort}
                onChange={(e) => setEffort(e.target.value)}
              >
                <option value="">Not sure yet</option>
                <option value="small">Small (an evening)</option>
                <option value="medium">Medium (a few sessions)</option>
                <option value="large">Large (a project)</option>
              </select>
            </div>
          </div>
          <div className="ats-field">
            <label htmlFor={ids.title}>Name</label>
            <input
              id={ids.title}
              className="ats-input"
              value={title}
              maxLength={80}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="ats-field">
            <label htmlFor={ids.brief}>The brief your assistant reads</label>
            <textarea
              id={ids.brief}
              className="ats-input studio-brief"
              rows={6}
              maxLength={10000}
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
            />
            <span className="ats-hint">
              Starts as their words; add what you know. Their words, documents and pictures always
              go in too.
            </span>
          </div>
          <div className="studio-actions-row">
            <Button onClick={() => void save()}>Save</Button>
            {saved && <span className="ats-muted studio-small">{saved}</span>}
          </div>
        </div>
      )}

      {r.status === 'submitted' && !declining && (
        <div className="studio-actions-row">
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => void act(() => acceptRequest(r.id))}
          >
            Accept
          </Button>
          <Button variant="ghost" onClick={() => setDeclining(true)}>
            Decline…
          </Button>
        </div>
      )}
      {declining && (
        <NoteForm
          label="Why not? (they'll see this)"
          onSend={async (note) => {
            await declineRequest(r.id, note);
            setDeclining(false);
            await onChanged();
          }}
          onCancel={() => setDeclining(false)}
        />
      )}

      {r.open && !r.workspace && !declining && (
        <div className="ats-stack req-start">
          <h3>Build it</h3>
          <p className="ats-muted studio-small">
            Makes a workspace with the brief, their words and pictures
            {r.kind === 'new' && r.status !== 'not_quite' ? '' : ', and the creation as it is now'}.
            Nothing runs until you start your assistant there.
          </p>
          <AssistantPicker
            assistants={assistants}
            value={picked}
            onChange={setPicked}
            defaults={defaults}
          />
          <div className="studio-actions-row">
            <Button
              variant="primary"
              disabled={busy || !chosen || !brief.trim()}
              onClick={() =>
                void act(async () => {
                  const { id } = await startRequestWorkspace(r.spaceId, {
                    requestId: r.id,
                    title,
                    brief,
                    provider: chosen as Provider,
                    model: picked.model,
                    effort: picked.effort,
                  });
                  navigate(`/space/${r.spaceId}/studio/${id}`);
                })
              }
            >
              {busy ? 'Preparing the workspace…' : 'Start building'}
            </Button>
            {!chosen && (
              <span className="ats-muted studio-small">
                <Link to="/studio/assistants">Connect your assistant</Link> first.
              </span>
            )}
          </div>
        </div>
      )}
      {r.workspace && (
        <div className="studio-actions-row">
          {r.workspace.mine ? (
            <Link
              className="ats-button ats-button--primary"
              to={`/space/${r.spaceId}/studio/${r.workspace.id}`}
            >
              Open its workspace
            </Link>
          ) : (
            <span className="ats-muted">Another Architect is building it.</span>
          )}
        </div>
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </Section>
  );
}
