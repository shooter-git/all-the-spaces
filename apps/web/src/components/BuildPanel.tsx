import { Button, Icon, Notice } from '@ats/ui';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import {
  buildPlace,
  loadReview,
  type PlanProblem,
  publishPlace,
  type Review,
} from '../lib/places.ts';
import { bakingWords, LightingLine } from './LightingLine.tsx';

// ---- Building, walking through, publishing -------------------------------------------------------

export function BuildPanel({
  workspaceId,
  spaceId,
  changed,
}: {
  workspaceId: string;
  spaceId: string;
  /** Whether the assistant has changed the place since the last build. */
  changed: { last: number | null; changed: boolean } | null;
}) {
  const navigate = useNavigate();
  const [review, setReview] = useState<Review | null>(null);
  const [problems, setProblems] = useState<PlanProblem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  /** What's under way: starting a build, or publishing. */
  const [busy, setBusy] = useState<'build' | 'publish' | null>(null);
  /** Where each creation whose object is gone goes: an object key, '' for the shelf. */
  const [moves, setMoves] = useState<Record<string, string>>({});
  const refresh = useCallback(() => loadReview(spaceId).then(setReview, () => {}), [spaceId]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (!review?.building) return;
    const t = setInterval(() => void refresh(), 4000);
    return () => clearInterval(t);
  }, [review?.building, refresh]);

  const build = async () => {
    setBusy('build');
    setError(null);
    setProblems([]);
    const r = await buildPlace(workspaceId);
    setBusy(null);
    if (!r.ok) {
      setError(r.error);
      setProblems(r.problems);
    }
    void refresh();
  };
  const c = review?.candidate;
  const live = Boolean(review?.space.live);
  const homeless = c?.homeless ?? [];
  const undecided = homeless.filter((h) => !(h.id in moves));
  const chosen = new Set(Object.values(moves).filter(Boolean));
  const publish = async () => {
    if (!c) return;
    setBusy('publish');
    try {
      const r = await publishPlace(
        spaceId,
        c.id,
        Object.fromEntries(Object.entries(moves).map(([id, key]) => [id, key || null])),
      );
      // The plans and photos are deleted once it's live, and this workspace with them.
      if (r.inputsDeleted) {
        navigate(`/space/${spaceId}/studio`);
        return;
      }
      setConfirm(false);
      setMoves({});
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="plan-build" aria-live="polite">
      {review?.building ? (
        <>
          <p>
            <span className="studio-pulse" aria-hidden="true" /> Building it: walls, doors,
            furniture and lighting. {live ? 'Rooms that haven’t changed are reused. ' : ''}Baking
            the lighting takes a few minutes a room, several rooms at a time, so a bigger place can
            take an hour or more. It carries on if you leave this page.
          </p>
          {bakingWords(review.progress) && (
            <p className="studio-small" data-baking="">
              {bakingWords(review.progress)}
            </p>
          )}
        </>
      ) : c ? (
        <>
          {changed?.changed && (
            <div className="plan-changed">
              <span className="plan-changed-icon">
                <Icon name="sparkles" size={18} />
              </span>
              <p>
                <strong>Your assistant has changed the place since version {c.number}.</strong>{' '}
                Build it to walk through the changes.
              </p>
              <Button
                variant="primary"
                onClick={() => void build()}
                disabled={busy !== null}
                busy={busy === 'build'}
              >
                <Icon name="hammer" size={16} />
                {busy === 'build' ? 'Starting…' : 'Build it'}
              </Button>
            </div>
          )}
          <p>
            <strong>Version {c.number} is ready to look at</strong> · {c.rooms.length} room
            {c.rooms.length === 1 ? '' : 's'}, {c.objects} objects
          </p>
          <LightingLine report={c.lighting} />
          {live && c.changes && <Changes changes={c.changes} />}
          {homeless.length > 0 && (
            <div className="plan-homeless">
              <p>
                <strong>
                  {homeless.length === 1
                    ? 'A creation needs a new home'
                    : `${homeless.length} creations need a new home`}
                </strong>{' '}
                <span className="ats-muted">
                  Its object isn’t in this version. Choose another object, or put it on the shelf
                  (you can place it later). What people saved in it stays.
                </span>
              </p>
              {homeless.map((h) => (
                <label key={h.id} className="plan-move">
                  <span>
                    <strong>{h.title}</strong>
                    {h.objectLabel && <span className="ats-muted"> · was on {h.objectLabel}</span>}
                  </span>
                  <select
                    className="ats-input"
                    value={h.id in moves ? moves[h.id] : 'choose'}
                    onChange={(e) => setMoves({ ...moves, [h.id]: e.target.value })}
                  >
                    <option value="choose" disabled>
                      Choose…
                    </option>
                    <option value="">On the shelf for now</option>
                    {(c.freeObjects ?? []).map((o) => (
                      <option
                        key={o.key}
                        value={o.key}
                        disabled={chosen.has(o.key) && moves[h.id] !== o.key}
                      >
                        {o.label} · {o.room}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          )}
          <div className="studio-actions-row">
            <a
              className="ats-button ats-button--ghost"
              href={`/space/${spaceId}?version=${c.id}`}
              target="_blank"
              rel="noreferrer"
            >
              <Icon name="enter" size={16} />
              Walk through it
            </a>
            <Button
              variant="ghost"
              onClick={() => void build()}
              disabled={busy !== null}
              busy={busy === 'build'}
            >
              <Icon name="hammer" size={16} />
              {busy === 'build' ? 'Starting…' : 'Build again'}
            </Button>
            <Button
              variant="primary"
              onClick={() => setConfirm(true)}
              disabled={busy !== null || undecided.length > 0}
            >
              <Icon name="upload" size={16} />
              Publish…
            </Button>
          </div>
          {confirm && (
            <Notice>
              <p style={{ margin: '0 0 8px' }}>
                {live
                  ? 'Everyone in the space moves to the new version straight away. Rooms keep who can see them; new rooms start private to Architects. You can go back to the old version from the Studio.'
                  : 'Every room starts private to Architects: nobody else sees anything until you choose who sees each room.'}
                {review?.deletesInputs &&
                  ' The floor plans and photos are then deleted, with this workspace; the plan itself is kept for changes later.'}
              </p>
              <div className="studio-actions-row">
                <Button
                  variant="primary"
                  onClick={() => void publish()}
                  disabled={busy !== null}
                  busy={busy === 'publish'}
                >
                  <Icon name="upload" size={16} />
                  {busy === 'publish' ? 'Publishing…' : 'Publish it'}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => setConfirm(false)}
                  disabled={busy === 'publish'}
                >
                  Cancel
                </Button>
              </div>
            </Notice>
          )}
        </>
      ) : live ? (
        <>
          <p>
            <strong>It's live.</strong> To change it, ask your assistant (or move walls), then build
            the changes to walk through before anyone else sees them.
          </p>
          <div className="studio-actions-row">
            <Button variant="primary" onClick={() => void build()} busy={busy === 'build'}>
              {busy === 'build' ? 'Starting…' : 'Build the changes'}
            </Button>
            <Link className="ats-button ats-button--ghost" to={`/space/${spaceId}/privacy`}>
              Who sees each room
            </Link>
            <Link className="ats-button ats-button--ghost" to={`/space/${spaceId}`}>
              Enter
            </Link>
          </div>
        </>
      ) : (
        <div className="studio-actions-row" style={{ justifyContent: 'space-between' }}>
          <span className="ats-muted studio-small">
            When the plan looks right, build it to walk through.
          </span>
          <Button variant="primary" onClick={() => void build()} busy={busy === 'build'}>
            {busy === 'build' ? 'Starting…' : 'Build it'}
          </Button>
        </div>
      )}
      {review?.failed && <Notice tone="error">It couldn't be built: {review.failed}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      {problems.length > 0 && (
        <ul className="plan-problems">
          {problems.map((p) => (
            <li key={p.message} data-level={p.level}>
              {p.message}
              {p.fix && <span className="ats-muted"> {p.fix}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** What a new version changes, in a few plain lines. */
function Changes({
  changes,
}: {
  changes: NonNullable<NonNullable<Review['candidate']>['changes']>;
}) {
  const names = (list: { name?: string; label?: string }[]) =>
    list.map((x) => x.name ?? x.label).join(', ');
  const { rooms, objects } = changes;
  const lines = [
    rooms.changed.length > 0 && `Changed: ${names(rooms.changed)}`,
    rooms.added.length > 0 && `New rooms: ${names(rooms.added)}`,
    rooms.removed.length > 0 && `Rooms taken away: ${names(rooms.removed)}`,
    objects.added.length > 0 && `New things: ${names(objects.added)}`,
    objects.removed.length > 0 && `Taken away: ${names(objects.removed)}`,
    objects.moved.length > 0 && `Moved: ${names(objects.moved)}`,
  ].filter(Boolean) as string[];
  return (
    <div className="plan-changes">
      {lines.length === 0 ? (
        <p className="ats-muted studio-small">Nothing has changed from the live version.</p>
      ) : (
        <ul>
          {lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}
      {rooms.unchanged.length > 0 && (
        <p className="ats-muted studio-small">
          {rooms.unchanged.length === 1 ? 'One room is' : `${rooms.unchanged.length} rooms are`}{' '}
          exactly as before ({names(rooms.unchanged)}): nobody needs to download{' '}
          {rooms.unchanged.length === 1 ? 'it' : 'them'} again.
        </p>
      )}
    </div>
  );
}
