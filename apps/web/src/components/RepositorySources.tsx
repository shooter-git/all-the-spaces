import { Button, Notice } from '@ats/ui';
import { useEffect, useId, useState } from 'react';
import {
  loadServerSources,
  patternsFrom,
  type ServerSourceHost,
  saveServerSources,
} from '../lib/sources.ts';
import '../routes/studio.css';

/** A host as it's being changed: the list as typed, one to a line. */
interface Draft {
  host: ServerSourceHost;
  on: boolean;
  /** The built-in GitHub host: any public repository, or only those listed. */
  any: boolean;
  text: string;
}

const draftOf = (host: ServerSourceHost): Draft => ({
  host,
  on: host.on,
  any: host.from === 'built-in' && host.repositories.includes('*'),
  text: host.repositories.filter((p) => host.from !== 'built-in' || p !== '*').join('\n'),
});

/**
 * Which repositories creations may come from (ADR 0012), for the server's owner: GitHub's public
 * repositories, switched on here, and more for the hosts set up in files. What a file says, its
 * token above all, is only ever changed in the file.
 */
export function RepositorySources() {
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    loadServerSources().then(
      (s) => setDrafts(s.hosts.map(draftOf)),
      (e: Error) => setError(e.message),
    );
  }, []);
  const change = (id: string, to: Partial<Draft>) => {
    setSaved(false);
    setDrafts((all) => all?.map((d) => (d.host.id === id ? { ...d, ...to } : d)) ?? null);
  };
  const save = async () => {
    if (!drafts) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const after = await saveServerSources({
        hosts: drafts.map((d) =>
          d.host.from === 'built-in'
            ? { id: d.host.id, on: d.on, repositories: d.any ? ['*'] : patternsFrom(d.text) }
            : { id: d.host.id, repositories: patternsFrom(d.text) },
        ),
      });
      setDrafts(after.hosts.map(draftOf));
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    }
    setSaving(false);
  };

  if (!drafts) return error ? <Notice tone="error">{error}</Notice> : <p>Loading…</p>;
  const builtIn = drafts.find((d) => d.host.from === 'built-in');
  const files = drafts.filter((d) => d.host.from === 'file');
  return (
    <div className="ats-stack manage-sources">
      <p className="ats-muted">
        Creations can come straight from a git repository and follow it as it changes. You choose
        whose. Wherever it comes from, a creation is checked, built and played sealed off, with no
        network, like every other one: this decides whose work can reach your server.
      </p>
      {builtIn && <BuiltIn draft={builtIn} onChange={(to) => change(builtIn.host.id, to)} />}
      {files.map((d) => (
        <FromFile key={d.host.id} draft={d} onChange={(to) => change(d.host.id, to)} />
      ))}
      {error && <Notice tone="error">{error}</Notice>}
      <div className="ats-row">
        <Button variant="primary" onClick={() => void save()} busy={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
        {saved && <span className="ats-muted">Saved. Architects can use it straight away.</span>}
      </div>
    </div>
  );
}

function BuiltIn({ draft, onChange }: { draft: Draft; onChange: (to: Partial<Draft>) => void }) {
  const listId = useId();
  return (
    <div className="manage-source ats-stack">
      <label className="studio-check">
        <input
          type="checkbox"
          checked={draft.on}
          onChange={(e) => onChange({ on: e.target.checked })}
        />
        <span>
          Let creations come from GitHub
          <span className="ats-muted studio-small studio-check-hint">
            Public repositories on github.com only, read without any password or token. Off until
            you switch it on.
          </span>
        </span>
      </label>
      {draft.on && (
        <>
          <fieldset className="manage-source-choice">
            <legend>Which repositories</legend>
            <label>
              <input
                type="radio"
                name={`${listId}-which`}
                checked={!draft.any}
                onChange={() => onChange({ any: false })}
              />{' '}
              Only the ones I list
            </label>
            <label>
              <input
                type="radio"
                name={`${listId}-which`}
                checked={draft.any}
                onChange={() => onChange({ any: true })}
              />{' '}
              Any public repository
            </label>
          </fieldset>
          {draft.any ? (
            <p className="ats-muted studio-small">
              Any Architect on this server can choose any public repository. A private one is never
              read, even if it's named.
            </p>
          ) : (
            <PatternList
              id={listId}
              label="Repositories, one on each line"
              hint="owner/name for one, or owner/* for all of an owner’s."
              text={draft.text}
              onChange={(text) => onChange({ text })}
            />
          )}
        </>
      )}
    </div>
  );
}

function FromFile({ draft, onChange }: { draft: Draft; onChange: (to: Partial<Draft>) => void }) {
  const listId = useId();
  const { host } = draft;
  return (
    <div className="manage-source ats-stack">
      <div>
        <strong>{host.displayName}</strong>
        <span className="ats-muted studio-small">
          {' '}
          · set up in a file on the server ({host.address})
        </span>
      </div>
      <div className="studio-small">
        <span className="ats-muted">Its file allows: </span>
        {host.fileRepositories.length ? (
          host.fileRepositories.map((p, i) => (
            <span key={p}>
              {i > 0 && ', '}
              <code>{p}</code>
            </span>
          ))
        ) : (
          <span className="ats-muted">nothing</span>
        )}
        {host.token && host.fileRepositories.some((p) => p !== '*') && (
          <span className="ats-muted"> (private ones too, with the server’s token)</span>
        )}
        <span className="ats-muted">. Change these in the file.</span>
      </div>
      <PatternList
        id={listId}
        label="Also allow (public repositories only)"
        hint="owner/name, owner/* for all of an owner’s, or * for any public one. Never read with the server’s token."
        text={draft.text}
        onChange={(text) => onChange({ text })}
      />
    </div>
  );
}

function PatternList({
  id,
  label,
  hint,
  text,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  text: string;
  onChange: (text: string) => void;
}) {
  return (
    <div className="ats-field">
      <label htmlFor={id}>{label}</label>
      <textarea
        id={id}
        className="ats-input manage-source-list"
        rows={3}
        value={text}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby={`${id}-hint`}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        placeholder="owner/name"
      />
      <span id={`${id}-hint`} className="ats-hint">
        {hint}
      </span>
    </div>
  );
}
