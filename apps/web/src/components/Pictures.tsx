import { Button, Icon } from '@ats/ui';
import { useState } from 'react';
import { useModal } from '../lib/modal.ts';
import { type AssistantPicture, pictureUrl } from '../lib/workbench.ts';

const ago = (at: number) => {
  const m = Math.round((Date.now() - at) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : new Date(at).toLocaleDateString();
};
/** "study-corner-2" → "Study, corner 2"; "lego_r2d2" → "lego r2d2". */
const title = (p: AssistantPicture) => {
  const corner = /^(.*)-corner-(\d)$/.exec(p.name);
  const words = (corner?.[1] ?? p.name).replace(/[-_]+/g, ' ');
  const nice = words.charAt(0).toUpperCase() + words.slice(1);
  return corner ? `${nice}, corner ${corner[2]}` : nice;
};

/**
 * What the assistant has drawn so far, newest first: rooms seen from their corners, the models it
 * made, each from four sides, and the place drawn from where photos of it were taken, beside
 * them. Tap one to see it larger. Nothing to read in a terminal.
 */
export function Pictures({
  workspaceId,
  pictures,
}: {
  workspaceId: string;
  pictures: AssistantPicture[] | null;
}) {
  const [open, setOpen] = useState<AssistantPicture | null>(null);
  const [kind, setKind] = useState<'all' | AssistantPicture['kind']>('all');
  if (!pictures) return <p className="ats-muted pictures-empty">Looking…</p>;
  if (!pictures.length)
    return (
      <p className="ats-muted pictures-empty">
        Your assistant’s pictures appear here as it makes them: the models it builds, from four
        sides, and each room as you’d see it from its corners. Ask it to “render the rooms you’ve
        furnished” to see them.
      </p>
    );
  const shown = pictures.filter((p) => kind === 'all' || p.kind === kind);
  // Only the kinds there are (a choice between them once there's more than one).
  const kinds = new Set(pictures.map((p) => p.kind));
  return (
    <div className="pictures">
      {kinds.size > 1 && (
        <fieldset className="preview-devices pictures-kinds">
          <legend className="visually-hidden">Show</legend>
          {(
            [
              ['all', 'All'],
              ['room', 'Rooms'],
              ['model', 'Models'],
              ['match', 'Photo matches'],
            ] as const
          )
            .filter(([k]) => k === 'all' || kinds.has(k))
            .map(([k, label]) => (
              <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}>
                {label}
              </button>
            ))}
        </fieldset>
      )}
      <ul className="pictures-grid">
        {shown.map((p) => (
          <li key={p.path}>
            <button type="button" onClick={() => setOpen(p)} title={`${title(p)} · ${ago(p.at)}`}>
              <img
                src={pictureUrl(workspaceId, p)}
                alt={title(p)}
                loading="lazy"
                data-kind={p.kind}
              />
              <span className="pictures-caption">
                <Icon
                  name={p.kind === 'room' ? 'home' : p.kind === 'match' ? 'camera' : 'box'}
                  size={13}
                />
                {title(p)}
                <span className="ats-muted"> · {ago(p.at)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {open && (
        <LargePicture workspaceId={workspaceId} picture={open} onClose={() => setOpen(null)} />
      )}
    </div>
  );
}

/** One picture, as big as the screen allows. */
function LargePicture({
  workspaceId,
  picture,
  onClose,
}: {
  workspaceId: string;
  picture: AssistantPicture;
  onClose: () => void;
}) {
  const dialog = useModal();
  return (
    <dialog ref={dialog} className="pictures-large" onClose={onClose} aria-label={title(picture)}>
      <div className="pictures-large-bar">
        <strong>{title(picture)}</strong>
        <span className="ats-muted"> · {ago(picture.at)}</span>
        <Button variant="ghost" onClick={() => dialog.current?.close()}>
          <Icon name="close" size={16} />
          Close
        </Button>
      </div>
      <img src={pictureUrl(workspaceId, picture)} alt={title(picture)} />
    </dialog>
  );
}
