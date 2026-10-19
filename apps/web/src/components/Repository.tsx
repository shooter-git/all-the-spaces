import { Button, Icon, IconButton, Notice } from '@ats/ui';
import { useState } from 'react';
import {
  allowedInWords,
  type CreationSource,
  checkSource,
  linkSource,
  type SourceHostInfo,
  type SourceSettings,
  short,
  unlinkSource,
  updateFromSource,
} from '../lib/sources.ts';

const FOLLOWS = {
  release: 'Newest release',
  branch: 'Newest on a branch',
  commit: 'One commit',
} as const;

const ago = (iso: string) => {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : new Date(iso).toLocaleDateString();
};

/**
 * Where a creation comes from, when it follows a repository: what it follows, whether there's
 * something newer, and building it (through the same checks as any version). Folded, it's one
 * line, unless there's something to do (an update, or a look that went wrong).
 */
export function RepositoryPanel({
  creationId,
  title,
  source,
  hosts,
  folded = false,
  onChanged,
}: {
  creationId: string;
  title: string;
  source: CreationSource;
  hosts: SourceHostInfo[];
  folded?: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<'check' | 'update' | 'unlink' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [started, setStarted] = useState<string | null>(null);
  const run = async (what: 'check' | 'update' | 'unlink') => {
    setBusy(what);
    setError(null);
    setStarted(null);
    try {
      if (what === 'check') await checkSource(creationId);
      if (what === 'update') {
        const r = await updateFromSource(creationId);
        setStarted(`Building ${r.label || short(r.commit)}: it appears below once it's checked.`);
      }
      if (what === 'unlink') await unlinkSource(creationId);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(null);
  };
  const newer = source.latestCommit && source.latestCommit !== source.builtCommit;
  const status = source.checkError
    ? null
    : !source.builtCommit
      ? 'Not built from it yet'
      : !newer
        ? `Up to date${source.latestLabel ? `: ${source.latestLabel}` : ''}`
        : source.behindBy
          ? `${source.behindBy} new commit${source.behindBy === 1 ? '' : 's'}${source.follows === 'release' ? `: ${source.latestLabel}` : ''}`
          : `Something newer: ${source.latestLabel ?? short(source.latestCommit)}`;
  const toDo = (newer || !source.builtCommit || source.checkError) && !started;
  if (folded && !toDo && !editing && !error)
    return (
      <section className="studio-repo-line studio-small" aria-label={`Where ${title} comes from`}>
        <Icon name="link" size={14} />
        <strong>{source.repository.split('/').pop()}</strong>
        {status && (
          <span className="studio-repo-status">
            <span
              className={`studio-dot studio-dot--${newer ? 'ok' : 'good'}`}
              aria-hidden="true"
            />{' '}
            {status}
          </span>
        )}
      </section>
    );
  return (
    <section className="studio-repo" aria-label={`Where ${title} comes from`}>
      <div className="studio-repo-head">
        <Icon name="link" size={16} />
        <div className="studio-grow">
          <div>
            <strong>{source.repository}</strong>
            {source.path ? <span className="ats-muted"> / {source.path}</span> : null}
            <span className="ats-muted">
              {' '}
              · {FOLLOWS[source.follows]}
              {source.follows !== 'release' && source.ref
                ? ` (${source.follows === 'commit' ? short(source.ref) : source.ref})`
                : ''}{' '}
              · {source.updateMode === 'live' ? 'updates go live' : 'updates are tried first'}
            </span>
          </div>
          <div className="studio-small">
            {status && (
              <>
                <span
                  className={`studio-dot studio-dot--${newer ? 'ok' : 'good'}`}
                  aria-hidden="true"
                />{' '}
                {status}
              </>
            )}
            {source.builtCommit && (
              <span className="ats-muted"> · built from {short(source.builtCommit)}</span>
            )}
            {source.checkedAt && (
              <span className="ats-muted"> · looked {ago(source.checkedAt)}</span>
            )}
          </div>
        </div>
        <div className="studio-icon-actions">
          <IconButton
            icon="refresh"
            label={`Look at ${source.repository} for something newer`}
            disabled={busy !== null}
            onClick={() => void run('check')}
          />
          <IconButton
            icon="settings"
            label={`Change what ${title} follows`}
            disabled={busy !== null}
            onClick={() => setEditing((e) => !e)}
          />
        </div>
      </div>
      {source.checkError && <Notice tone="error">{source.checkError}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      {started && <Notice>{started}</Notice>}
      {(newer || !source.builtCommit) && !source.checkError && (
        <div className="studio-actions">
          <Button variant="primary" disabled={busy !== null} onClick={() => void run('update')}>
            <Icon name="download" size={16} />
            {busy === 'update'
              ? 'Fetching…'
              : `Update to ${source.latestLabel && source.follows === 'release' ? source.latestLabel : short(source.latestCommit) || 'the newest'}`}
          </Button>
        </div>
      )}
      {/* Up to date: the same commit again, for instance once the server builds things differently. */}
      {!newer && source.builtCommit && !source.checkError && (
        <div className="studio-actions">
          <Button variant="ghost" disabled={busy !== null} onClick={() => void run('update')}>
            <Icon name="hammer" size={16} />
            {busy === 'update' ? 'Fetching…' : 'Build again'}
          </Button>
        </div>
      )}
      {editing && (
        <RepositoryForm
          hosts={hosts}
          initial={source}
          submitLabel="Save"
          onCancel={() => setEditing(false)}
          onSubmit={async (s) => {
            await linkSource(creationId, s);
            setEditing(false);
            onChanged();
          }}
          extra={
            <Button variant="ghost" disabled={busy !== null} onClick={() => void run('unlink')}>
              <Icon name="unlink" size={16} />
              Stop following it
            </Button>
          }
        />
      )}
    </section>
  );
}

/** Which repository, which folder, what to follow, and where new versions land. */
export function RepositoryForm({
  hosts,
  initial,
  submitLabel,
  onSubmit,
  onCancel,
  extra,
  children,
}: {
  hosts: SourceHostInfo[];
  initial?: Partial<SourceSettings>;
  submitLabel: string;
  onSubmit: (s: SourceSettings) => Promise<void>;
  onCancel: () => void;
  /** Another action beside Cancel (Stop following). */
  extra?: React.ReactNode;
  /** Fields before the repository's (which object, for a new creation). */
  children?: React.ReactNode;
}) {
  const [host, setHost] = useState(initial?.host ?? hosts[0]?.id ?? '');
  const [repository, setRepository] = useState(initial?.repository ?? '');
  const [path, setPath] = useState(initial?.path ?? '');
  const [follows, setFollows] = useState<SourceSettings['follows']>(initial?.follows ?? 'release');
  const [ref, setRef] = useState(initial?.ref ?? '');
  const [updateMode, setUpdateMode] = useState<SourceSettings['updateMode']>(
    initial?.updateMode ?? 'candidate',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const allowed = hosts.find((h) => h.id === host)?.repositories ?? [];
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        host,
        repository: repository.trim(),
        path: path.trim(),
        follows,
        ref: follows === 'release' ? null : ref.trim() || null,
        updateMode,
      });
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };
  return (
    <form className="studio-confirm studio-repo-form" onSubmit={(e) => void submit(e)}>
      {children}
      {hosts.length > 1 && (
        <label>
          <span>Where</span>
          <select className="ats-input" value={host} onChange={(e) => setHost(e.target.value)}>
            {hosts.map((h) => (
              <option key={h.id} value={h.id}>
                {h.displayName}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        <span>Repository</span>
        <input
          className="ats-input"
          value={repository}
          onChange={(e) => setRepository(e.target.value)}
          placeholder={allowed.find((p) => p !== '*')?.replace('*', 'name') ?? 'owner/name'}
          required
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <small className="ats-muted">This server allows {allowedInWords(allowed)}.</small>
      </label>
      <label>
        <span>Folder</span>
        <input
          className="ats-input"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="Leave empty if the whole repository is the creation"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
      </label>
      <fieldset className="studio-repo-choice">
        <legend>Follow</legend>
        {(Object.keys(FOLLOWS) as SourceSettings['follows'][]).map((f) => (
          <label key={f}>
            <input
              type="radio"
              name="follows"
              checked={follows === f}
              onChange={() => setFollows(f)}
            />{' '}
            {FOLLOWS[f]}
          </label>
        ))}
      </fieldset>
      {follows !== 'release' && (
        <label>
          <span>{follows === 'branch' ? 'Branch' : 'Commit (all 40 characters)'}</span>
          <input
            className="ats-input"
            value={ref}
            onChange={(e) => setRef(e.target.value)}
            placeholder={follows === 'branch' ? 'main' : ''}
            required
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </label>
      )}
      <fieldset className="studio-repo-choice">
        <legend>New versions</legend>
        <label>
          <input
            type="radio"
            name="updateMode"
            checked={updateMode === 'candidate'}
            onChange={() => setUpdateMode('candidate')}
          />{' '}
          Wait for me to try them
        </label>
        <label>
          <input
            type="radio"
            name="updateMode"
            checked={updateMode === 'live'}
            onChange={() => setUpdateMode('live')}
          />{' '}
          Go live once they pass their checks
        </label>
      </fieldset>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="studio-actions">
        <Button variant="ghost" type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        {extra}
        <Button variant="primary" type="submit" disabled={busy || !repository.trim()}>
          {busy ? 'Looking…' : submitLabel}
        </Button>
      </div>
    </form>
  );
}
