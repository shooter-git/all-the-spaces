import { Button, Icon, IconButton, Notice } from '@ats/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { AddedFiles, AddFiles, namesOf } from '../components/AddFiles.tsx';
import { AssistantPicker, describeChoice } from '../components/AssistantPicker.tsx';
import { ChangedFiles } from '../components/ChangedFiles.tsx';
import { PlanPane } from '../components/PlanPane.tsx';
import { Terminal } from '../components/Terminal.tsx';
import type { Me } from '../lib/api.ts';
import { useModal } from '../lib/modal.ts';
import {
  type CheckResult,
  loadWorkspace,
  publishWorkspace,
  runChecks,
  setWorkspaceAssistant,
  stillHere,
  typeInto,
  type WorkspaceDetail,
  workspaceAction,
} from '../lib/workbench.ts';
import { Preview } from './workspace/Preview.tsx';
import './space.css';
import './studio.css';

/** Things to ask the assistant. Clicking one only types it: the Architect sends it (C9). */
const SUGGESTIONS = [
  'Read BRIEF.md and CLAUDE.md, then build it. When it works, run `ats qa` and fix everything it reports until it says Ready.',
  'Make it look great: model its characters and props in Blender with `ats model build` instead of simple shapes, check each preview, and use free library models and textures (`ats assets search`) where they fit.',
  'Make it feel great on a phone, both upright and on its side, and with a mouse and keyboard.',
  'Write qa/script.json so the checks try the main things a person would do, then run `ats qa`.',
  'Run `ats qa` and fix everything it reports until it says Ready.',
  'Tell me, in plain words, what you built, how to use it on a phone and on a laptop, and what you’d improve next.',
];
/** For a place being built from its floor plan (or from photos of the outside). */
const SPACE_SUGGESTIONS = [
  'Read BRIEF.md and CLAUDE.md, look at what’s in inputs/ (the floor plan, or photos of the outside and the notes on them), and write plan.json. Calibrate with `ats space scale` and `ats space origin`, then check with `ats space check` and `ats space overlay` until every wall lines up with the drawing.',
  'Look at preview/overlay.png: line every wall up with the floor plan, to within a few centimetres.',
  'Draw the place from where each photo of the outside was taken (`ats space match` with the pack’s manifest) and make the model match every photo: its height, its floors, its openings and what it’s made of.',
  'Now furnish it from the photos and my description, with a real model for every piece: library models for everyday furniture, and your own made in Blender (`ats model build`) for anything personal. Then `ats space render` each room and compare it with the photos.',
  'Go through the photos room by room and make anything that doesn’t look like the real thing match it: model it in Blender with `ats model build`, check the preview against the photo, and render the room again.',
  'Tell me, in plain words, what you built and anything you weren’t sure of.',
];
const FIX_PROMPT =
  'The checks found problems (qa-output/report.html has the details and screenshots). Fix everything they report, then run `ats qa` until it says Ready.';

const SLEPT: Record<string, string> = {
  idle: 'it was quiet for a while',
  'time-limit': 'it reached the time limit after you stepped away',
  you: 'you put it to sleep',
};

/** How often an open workspace's page says the Architect is here, while they're using it. */
const HERE_EVERY_MS = 60_000;
/** With no touch, click or key for this long, an open page no longer counts as being used. */
const IN_USE_MS = 10 * 60_000;
/** How long before a workspace goes to sleep its page says so. */
const WARN_MS = 5 * 60_000;

/**
 * While an awake workspace's page is showing and in use, tells the server every minute that the
 * Architect is here, so it doesn't go to sleep under them. A page left open and untouched doesn't.
 */
function useStillHere(id: string | undefined, awake: boolean) {
  useEffect(() => {
    if (!id || !awake) return;
    let usedAt = Date.now();
    const used = () => {
      usedAt = Date.now();
    };
    // Moving into the preview (a page inside this one, whose touches and keys aren't seen here)
    // blurs this window: that counts as using it too.
    const events = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'blur'] as const;
    for (const e of events) window.addEventListener(e, used, { capture: true, passive: true });
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible' && Date.now() - usedAt < IN_USE_MS)
        stillHere(id).catch(() => {});
    }, HERE_EVERY_MS);
    return () => {
      clearInterval(timer);
      for (const e of events) window.removeEventListener(e, used, { capture: true });
    };
  }, [id, awake]);
}

/**
 * A workspace: a terminal where the Architect works with their assistant, and a live preview
 * that rebuilds as the assistant saves files. Publishing checks the creation first.
 */
export function Workspace({ me }: { me: Me }) {
  const { spaceId, workspaceId } = useParams();
  const [ws, setWs] = useState<WorkspaceDetail | null>(null);
  /** Changing the model or effort (it applies the next time the assistant starts). */
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** The pane shown: one at a time on a phone; on a wide screen, beside the terminal. */
  const [tab, setTab] = useState<'terminal' | 'preview' | 'files' | 'brief'>('terminal');
  /** To the terminal: on a wide screen it's always there, so Files stays open beside it. */
  const toTerminal = () =>
    setTab((t) => (t === 'files' && matchMedia('(min-width: 901px)').matches ? t : 'terminal'));
  const [suggest, setSuggest] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [needsConnect, setNeedsConnect] = useState(false);
  const [checks, setChecks] = useState<CheckResult | 'running' | null>(null);
  /** Counts additions to uploads/ (so the list of added files looks again). */
  const [added, setAdded] = useState(0);

  const refresh = useCallback(() => {
    if (!workspaceId) return;
    loadWorkspace(workspaceId).then(setWs, (e: Error) => setError(e.message));
  }, [workspaceId]);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  /** Does `fn`, `busy` with `label` meanwhile; says whether it worked. */
  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
      refresh();
      return true;
    } catch (e) {
      const err = e as Error & { code?: string };
      if (err.code === 'connect') setNeedsConnect(true);
      setError(err.message);
      return false;
    } finally {
      setBusy(null);
    }
  };
  const check = async () => {
    if (!workspaceId) return;
    setChecks('running');
    setError(null);
    try {
      setChecks(await runChecks(workspaceId));
    } catch (e) {
      setChecks(null);
      setError((e as Error).message);
    }
  };
  /** Types into the terminal; 'fix' is the prompt that asks to fix what the checks found. */
  const type = (what: 'start' | 'resume' | 'prompt' | 'fix', text?: string) =>
    act(what, async () => {
      if (!workspaceId) return;
      await typeInto(workspaceId, what === 'fix' ? 'prompt' : what, text);
      toTerminal();
      if (what === 'prompt' || what === 'fix')
        setNotice('Added to the terminal: read it over, then press Enter to send it.');
    });

  useStillHere(workspaceId, ws?.status === 'running');
  /** Opening an asleep workspace wakes it, once (not one its Architect put to sleep themselves). */
  const woke = useRef(false);
  useEffect(() => {
    if (!ws || woke.current) return;
    woke.current = true;
    if (ws.status === 'stopped' && ws.stoppedBecause !== 'you')
      void act('open', () => workspaceAction(ws.id, 'open'));
  });

  if (!ws) {
    return (
      <main className="ats-screen">
        <div className="ats-container">
          {error ? <Notice tone="error">{error}</Notice> : <p className="ats-muted">Loading…</p>}
        </div>
      </main>
    );
  }
  const awake = ws.status === 'running';
  const build = ws.lastBuild;
  const building = build && (build.status === 'queued' || build.status === 'running');
  const sleepsIn = awake && ws.sleepsAt ? Date.parse(ws.sleepsAt) - Date.now() : null;

  return (
    <div className="workspace">
      <header className="workspace-head">
        <div className="workspace-title">
          <Link
            className="ats-icon-button"
            to={ws.kind === 'space' ? '/' : `/space/${spaceId}/studio`}
            aria-label={ws.kind === 'space' ? 'Back home' : 'Back to the Studio'}
            title={ws.kind === 'space' ? 'Back home' : 'Back to the Studio'}
          >
            <Icon name="back" />
          </Link>
          <div>
            <h1>{ws.title}</h1>
            <span className="ats-muted studio-small">
              {ws.assistant} ·{' '}
              <button
                type="button"
                className="workspace-choice"
                onClick={() => setChoosing((v) => !v)}
                aria-expanded={choosing}
                title="Change the model or effort"
              >
                {describeChoice(ws.provider, ws.runsWith)}
              </button>{' '}
              · {awake ? 'Awake' : ws.status === 'ready' ? 'Not started yet' : 'Asleep'}
              {ws.request && (
                <>
                  {' · '}
                  <Link to={`/space/${spaceId}/requests/${ws.request.id}`}>For a request</Link>
                </>
              )}
            </span>
          </div>
        </div>
        <div className="studio-actions-row">
          {awake ? (
            <Button
              variant="ghost"
              onClick={() => void act('stop', () => workspaceAction(ws.id, 'stop'))}
              disabled={busy !== null}
              busy={busy === 'stop'}
              title="Stops your assistant and the preview; everything in the workspace is kept"
            >
              <Icon name="moon" size={16} />
              {busy === 'stop' ? 'Going to sleep…' : 'Sleep'}
            </Button>
          ) : null}
          {ws.kind === 'creation' && (
            <Button
              variant="primary"
              onClick={() => setPublishing(true)}
              disabled={!awake || Boolean(building)}
            >
              <Icon name="upload" size={16} />
              Publish…
            </Button>
          )}
        </div>
      </header>
      {choosing && (
        <ChangeAssistant
          ws={ws}
          onDone={() => {
            setChoosing(false);
            refresh();
          }}
        />
      )}

      {error && (
        <div className="workspace-notice">
          <Notice tone="error">
            {error} {needsConnect && <Link to="/studio/assistants">Connect it</Link>}
          </Notice>
        </div>
      )}
      {sleepsIn !== null && sleepsIn < WARN_MS && (
        <div className="workspace-notice">
          <Notice>
            <span className="workspace-sleeping">
              This workspace goes to sleep{' '}
              {sleepsIn < 90_000
                ? 'in a moment'
                : `in about ${Math.round(sleepsIn / 60_000)} minutes`}{' '}
              (everything in it is kept).
              <Button
                variant="ghost"
                onClick={() => void act('here', () => stillHere(ws.id))}
                disabled={busy !== null}
                busy={busy === 'here'}
              >
                <Icon name="sun" size={16} />
                Stay awake
              </Button>
            </span>
          </Notice>
        </div>
      )}
      {ws.blockedHosts.length > 0 && (
        <div className="workspace-notice">
          <Notice>
            <details className="workspace-blocked">
              <summary>
                Your assistant tried to reach{' '}
                {ws.blockedHosts.length === 1 ? 'a site' : `${ws.blockedHosts.length} sites`} it
                can’t use.
              </summary>
              {ws.blockedHosts.slice(0, 3).join(', ')}
              {ws.blockedHosts.length > 3 ? ` and ${ws.blockedHosts.length - 3} more` : ''}.
              Workspaces can only reach the assistant’s maker, npm and free asset libraries;
              creations can’t use the internet at all.
            </details>
          </Notice>
        </div>
      )}
      {build && (
        <BuildStatus
          ws={ws}
          spaceId={spaceId ?? ''}
          fixing={busy === 'fix'}
          canFix={busy === null}
          onFix={() => void type('fix', FIX_PROMPT)}
        />
      )}
      {publishing && (
        <PublishDialog
          busy={busy === 'publish'}
          error={error}
          onClose={() => setPublishing(false)}
          onPublish={(live) =>
            act('publish', async () => {
              await publishWorkspace(ws.id, live);
              setPublishing(false);
            })
          }
        />
      )}

      <nav className="workspace-tabs" aria-label="Workspace">
        {(['terminal', 'preview', 'files', 'brief'] as const).map((t) => (
          <button key={t} type="button" aria-pressed={tab === t} onClick={() => setTab(t)}>
            <Icon
              name={
                t === 'terminal'
                  ? 'terminal'
                  : t === 'preview'
                    ? ws.kind === 'space'
                      ? 'map'
                      : 'eye'
                    : t === 'files'
                      ? 'folder'
                      : 'fileText'
              }
              size={16}
            />
            {t === 'terminal'
              ? 'Terminal'
              : t === 'preview'
                ? ws.kind === 'space'
                  ? 'Plan'
                  : 'Preview'
                : t === 'files'
                  ? 'Files'
                  : 'Brief'}
          </button>
        ))}
      </nav>

      {!awake ? (
        <div className="workspace-asleep">
          {ws.status === 'ready' ? (
            <>
              <h2>Ready to start</h2>
              <p className="ats-muted">
                Nothing happens until you start it. Wake it (about half a minute), press{' '}
                <strong>Start {ws.assistant}</strong>, then choose a step from{' '}
                <strong>Suggestions</strong>: your assistant does the rest, and you can watch.
              </p>
            </>
          ) : (
            <>
              <h2>This workspace is asleep</h2>
              <p className="ats-muted">
                {ws.stoppedBecause
                  ? `It went to sleep because ${SLEPT[ws.stoppedBecause] ?? ws.stoppedBecause}. `
                  : ''}
                Everything in it is kept. Waking it starts {ws.assistant} and the live preview.
              </p>
            </>
          )}
          <Button
            variant="primary"
            onClick={() => void act('open', () => workspaceAction(ws.id, 'open'))}
            disabled={busy !== null}
            busy={busy === 'open'}
          >
            <Icon name="sun" size={16} />
            {busy === 'open' ? 'Waking… (about half a minute)' : 'Wake it'}
          </Button>
          <details className="workspace-brief-inline">
            <summary>The brief</summary>
            <p>{ws.brief}</p>
          </details>
        </div>
      ) : (
        <div className="workspace-body" data-tab={tab}>
          <section className="workspace-pane workspace-pane--terminal" aria-label="Terminal">
            <div className="workspace-tools" role="toolbar" aria-label="Assistant">
              <Button
                variant="ghost"
                data-short={busy === 'start' ? 'Starting…' : 'Start'}
                onClick={() => void type('start')}
                disabled={busy !== null}
                busy={busy === 'start'}
              >
                <Icon name="play" size={16} />
                {busy === 'start' ? `Starting ${ws.assistant}…` : `Start ${ws.assistant}`}
              </Button>
              <Button
                variant="ghost"
                data-short={busy === 'resume' ? 'Carrying on…' : 'Carry on'}
                onClick={() => void type('resume')}
                disabled={busy !== null}
                busy={busy === 'resume'}
              >
                <Icon name="redo" size={16} />
                {busy === 'resume' ? 'Carrying on…' : 'Carry on'}
              </Button>
              <Button
                variant="ghost"
                data-short={checks === 'running' ? 'Checking…' : 'Checks'}
                onClick={() => void check()}
                busy={checks === 'running'}
              >
                <Icon name="checkCircle" size={16} />
                {checks === 'running' ? 'Checking… (about a minute)' : 'Run checks'}
              </Button>
              <Button
                variant="ghost"
                className="workspace-files-toggle"
                data-short="Files"
                aria-pressed={tab === 'files'}
                onClick={() => setTab(tab === 'files' ? 'terminal' : 'files')}
              >
                <Icon name="folder" size={16} />
                Files
              </Button>
              <AddFiles
                workspaceId={ws.id}
                place={ws.kind === 'space'}
                onAdded={(names, typed) => {
                  toTerminal();
                  setAdded((n) => n + 1);
                  const one = names.length === 1;
                  setNotice(
                    typed
                      ? `Added ${namesOf(names)}. ${one ? 'Its name is' : 'Their names are'} in the terminal: say what to do with ${one ? 'it' : 'them'}, then press Enter.`
                      : `Added ${namesOf(names)} to uploads/.`,
                  );
                  // Ready to type what to do with them (not on a touch screen: no keyboard pops up).
                  if (matchMedia('(pointer: fine)').matches)
                    document
                      .querySelector<HTMLTextAreaElement>(
                        '.workspace-terminal .xterm-helper-textarea',
                      )
                      ?.focus();
                }}
                onProblem={setError}
              />
              <div className="workspace-suggest">
                <Button
                  variant="ghost"
                  data-short="Suggestions"
                  onClick={() => setSuggest((v) => !v)}
                  aria-expanded={suggest}
                  busy={busy === 'prompt'}
                >
                  <Icon name="lightbulb" size={16} />
                  Suggestions
                </Button>
                {suggest && (
                  <ul className="workspace-suggestions">
                    {(ws.kind === 'space' ? SPACE_SUGGESTIONS : SUGGESTIONS).map((s) => (
                      <li key={s}>
                        <button
                          type="button"
                          disabled={busy !== null}
                          onClick={() => {
                            setSuggest(false);
                            void type('prompt', s);
                          }}
                        >
                          {s}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
            {checks && checks !== 'running' && (
              <ChecksPanel
                result={checks}
                fixing={busy === 'fix'}
                onClose={() => setChecks(null)}
                onFix={() => {
                  if (busy !== null) return;
                  void type('fix', FIX_PROMPT).then((typed) => typed && setChecks(null));
                }}
              />
            )}
            <AddedFiles
              workspaceId={ws.id}
              place={ws.kind === 'space'}
              version={added}
              onRemoved={(name) => setNotice(`Removed ${name}.`)}
              onMentioned={(name, typed) =>
                setNotice(
                  typed
                    ? `${name} is in the terminal: say what to do with it, then press Enter.`
                    : `${name} couldn't be put in the terminal.`,
                )
              }
              onProblem={setError}
            />
            <div className="workspace-terminal">
              <Terminal target={`ws:${ws.id}`} />
            </div>
          </section>
          <section className="workspace-pane workspace-pane--preview" aria-label="Preview">
            {ws.kind === 'space' ? (
              <PlanPane workspaceId={ws.id} spaceId={ws.spaceId} awake={awake} />
            ) : (
              <Preview workspaceId={ws.id} title={ws.title} me={me} />
            )}
          </section>
          <section className="workspace-pane workspace-pane--files" aria-label="Files">
            <ChangedFiles workspaceId={ws.id} shown={tab === 'files'} />
          </section>
          <section className="workspace-pane workspace-pane--brief" aria-label="Brief">
            <h2>The brief</h2>
            <p className="workspace-brief">{ws.brief}</p>
            <p className="ats-muted studio-small">
              Your assistant reads this from BRIEF.md in the workspace. While you’re here, it stays
              awake. Once you step away, it sleeps after {ws.limits.idleMinutes} quiet minutes (when
              your assistant isn’t at work either), or once it’s been awake {ws.limits.sessionHours}{' '}
              hours in all, however busy your assistant is. Opening it again wakes it, and picks up
              where you left off.
            </p>
          </section>
        </div>
      )}
      {notice && (
        <div className="chat-toast workspace-toast" role="status">
          {notice}
        </div>
      )}
    </div>
  );
}

function BuildStatus({
  ws,
  spaceId,
  fixing,
  canFix,
  onFix,
}: {
  ws: WorkspaceDetail;
  spaceId: string;
  /** Asking to fix it is under way. */
  fixing: boolean;
  /** Not while something else is under way. */
  canFix: boolean;
  onFix: () => void;
}) {
  const b = ws.lastBuild;
  if (!b) return null;
  const words =
    b.status === 'queued' || b.status === 'running'
      ? `${b.step ?? 'Waiting its turn'}…`
      : b.status === 'published'
        ? 'Passed its checks and it’s live.'
        : b.status === 'passed'
          ? 'Passed its checks: try it, then make it live from Creations.'
          : b.status === 'failed'
            ? `Didn’t pass: ${b.qa?.failed ?? 'some'} thing${b.qa?.failed === 1 ? '' : 's'} to fix.`
            : `The build itself went wrong: ${b.error ?? ''}`;
  return (
    <div className="workspace-build" data-status={b.status} aria-live="polite">
      <span className="studio-dot" aria-hidden="true" />
      <span className="studio-grow">{words}</span>
      {b.status === 'failed' && (
        <Button variant="ghost" onClick={onFix} disabled={!canFix} busy={fixing}>
          <Icon name="wrench" size={16} />
          {fixing ? 'Asking…' : 'Ask to fix it'}
        </Button>
      )}
      {(b.status === 'failed' || b.status === 'passed' || b.status === 'published') && (
        <Link
          className="ats-icon-button"
          to={`/space/${spaceId}/builds/${b.id}`}
          aria-label="Its check report"
          title="Its check report"
        >
          <Icon name="list" />
        </Link>
      )}
      {b.status === 'passed' && (
        <Link
          className="ats-icon-button"
          to={`/space/${spaceId}/creations`}
          aria-label="Creations"
          title="Creations"
        >
          <Icon name="box" />
        </Link>
      )}
    </div>
  );
}

function ChecksPanel({
  result,
  fixing,
  onClose,
  onFix,
}: {
  result: CheckResult;
  /** Asking to fix it is under way. */
  fixing: boolean;
  onClose: () => void;
  onFix: () => void;
}) {
  const fails = result.problems.filter((p) => p.status === 'fail');
  const notes = result.problems.filter((p) => p.status === 'warn');
  return (
    <div className="workspace-checks" data-ok={result.ok} aria-live="polite">
      <div className="workspace-checks-head">
        <strong>
          {result.ok
            ? notes.length
              ? `Ready, with ${notes.length} thing${notes.length === 1 ? '' : 's'} worth a look`
              : 'Ready: it passes every check'
            : `${fails.length} thing${fails.length === 1 ? '' : 's'} to fix`}
        </strong>
        <div className="studio-actions-row">
          {!result.ok && (
            <Button variant="primary" onClick={onFix} busy={fixing}>
              <Icon name="wrench" size={16} />
              {fixing ? 'Asking…' : 'Ask to fix it'}
            </Button>
          )}
          <IconButton icon="close" label="Close the checks" onClick={onClose} />
        </div>
      </div>
      {result.problems.length > 0 && (
        <ul>
          {result.problems.slice(0, 8).map((p) => (
            <li key={`${p.title}|${p.where ?? ''}`}>
              <span
                className={`studio-dot studio-dot--${p.status === 'fail' ? 'bad' : 'ok'}`}
                aria-hidden="true"
              />{' '}
              {p.title}
              {p.where && <span className="ats-muted"> · {p.where}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function PublishDialog({
  busy,
  error,
  onClose,
  onPublish,
}: {
  /** The checks are being started: it stays open, and nothing in it can be pressed again. */
  busy: boolean;
  /** Why the checks couldn't start (shown once one of its buttons has been pressed). */
  error: string | null;
  onClose: () => void;
  onPublish: (live: boolean) => void;
}) {
  const dialog = useModal();
  /** Which was pressed: to try it first, or to make it live. */
  const [chose, setChose] = useState<boolean | null>(null);
  const publish = (live: boolean) => {
    setChose(live);
    onPublish(live);
  };
  return (
    <dialog
      ref={dialog}
      className="ats-sheet"
      onClose={onClose}
      // Escape doesn't close it while the checks are being started.
      onCancel={(e) => busy && e.preventDefault()}
      aria-labelledby="publish-title"
      aria-busy={busy || undefined}
    >
      <div className="ats-stack">
        <h2 id="publish-title">Publish</h2>
        <p className="ats-muted">
          The creation is checked first — built cleanly, and tried on phones, a tablet and a laptop.
          Nothing reaches anyone unless it passes.
        </p>
        {chose !== null && !busy && error && <Notice tone="error">{error}</Notice>}
        <div className="ats-stack" style={{ gap: 8 }}>
          <Button
            variant="primary"
            onClick={() => publish(false)}
            disabled={busy}
            busy={busy && chose === false}
          >
            <Icon name="play" size={16} />
            {busy && chose === false ? 'Starting the checks…' : 'Check it, and let me try it first'}
          </Button>
          <Button
            variant="ghost"
            onClick={() => publish(true)}
            disabled={busy}
            busy={busy && chose === true}
          >
            <Icon name="upload" size={16} />
            {busy && chose === true
              ? 'Starting the checks…'
              : 'Check it, and make it live if it passes'}
          </Button>
          <Button variant="ghost" onClick={() => dialog.current?.close()} disabled={busy}>
            Cancel
          </Button>
        </div>
      </div>
    </dialog>
  );
}

/** This workspace's model and effort: from the next time its assistant starts. */
function ChangeAssistant({ ws, onDone }: { ws: WorkspaceDetail; onDone: () => void }) {
  const [value, setValue] = useState({ provider: ws.provider, ...ws.choice });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await setWorkspaceAssistant(ws.id, { model: value.model, effort: value.effort });
      onDone();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <section className="workspace-assistant" aria-label={`${ws.assistant} model and effort`}>
      <AssistantPicker
        assistants={[{ provider: ws.provider, name: ws.assistant }]}
        value={value}
        onChange={(c) => setValue({ provider: ws.provider, model: c.model, effort: c.effort })}
        lockProvider
      />
      <p className="ats-muted studio-small">
        Used the next time {ws.assistant} starts here (Start {ws.assistant}, or Carry on). To change
        it in a conversation that's already going, type <code>/model</code> in the terminal.
      </p>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="studio-actions-row">
        <Button variant="primary" onClick={() => void save()} busy={busy}>
          <Icon name="save" size={16} />
          {busy ? 'Saving…' : 'Save'}
        </Button>
        <Button variant="ghost" onClick={onDone} disabled={busy}>
          Cancel
        </Button>
      </div>
    </section>
  );
}
