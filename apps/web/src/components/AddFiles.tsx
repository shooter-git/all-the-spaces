import { Button, Confirm, Icon, IconButton } from '@ats/ui';
import { useEffect, useRef, useState } from 'react';
import { useModal } from '../lib/modal.ts';
import { isPdf, pdfPages } from '../lib/pdf.ts';
import {
  listUploads,
  MAX_UPLOAD,
  mentionUpload,
  removeUpload,
  type UploadedFile,
  uploadToWorkspace,
} from '../lib/workbench.ts';

const PLACE_TYPES = 'image/*,.heic,.heif,application/pdf,.pdf,.zip,application/zip';
const isZip = (f: File) => /\.zip$/i.test(f.name);
const isPicture = (f: File) => f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name);
/** A picture whose name says it's a drawing of the place, not a photo of it. */
const looksLikePlan = (f: File) => /plan|floor|blueprint|layout|drawing/i.test(f.name);

/**
 * Adding files to a workspace while the assistant works: a button, or dropping them anywhere on
 * the page. They go into `uploads/`, and their paths are pasted into the terminal for the
 * Architect to send with their own words (C9). A place takes pictures and PDFs (each page a
 * plan); a creation takes anything. A .zip (photos with a README or a manifest saying what each
 * is, say) is unpacked into a folder of its own, its files keeping their names.
 */
export function AddFiles({
  workspaceId,
  place,
  onAdded,
  onProblem,
}: {
  workspaceId: string;
  place: boolean;
  /** The names the files got in uploads/, and whether they were typed into the terminal. */
  onAdded: (names: string[], typed: boolean) => void;
  onProblem: (message: string) => void;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  /** Asking whether to keep where a .zip's photos were taken (its answer, once given). */
  const [asking, setAsking] = useState<((keep: boolean) => void) | null>(null);
  const busy = useRef(false);
  const keepPositions = () =>
    new Promise<boolean>((resolve) =>
      setAsking(() => (keep: boolean) => {
        setAsking(null);
        resolve(keep);
      }),
    );

  const add = async (files: File[]) => {
    if (busy.current || !files.length) return;
    busy.current = true;
    const problems: string[] = [];
    const added: string[] = [];
    let typed = true;
    try {
      // Photos of a building's outside can keep where they were taken, to match the model
      // against: the Architect says so for each .zip (never for photos of a home).
      const positions = place && files.some(isZip) ? await keepPositions() : false;
      const items: { file: File; as?: 'plan' | 'photo' }[] = [];
      for (const file of files) {
        if (file.size > MAX_UPLOAD) problems.push(`${file.name} is over 25 MB.`);
        else if (!place || isZip(file)) items.push({ file });
        else if (isPdf(file)) {
          // One picture per page (each usually a floor), as when the place was set up.
          setProgress(`Reading ${file.name}…`);
          try {
            for (const page of await pdfPages(file, 30)) items.push({ file: page, as: 'plan' });
          } catch (e) {
            problems.push(`${file.name}: ${(e as Error).message}`);
          }
        } else if (isPicture(file))
          items.push({ file, as: looksLikePlan(file) ? 'plan' : 'photo' });
        else problems.push(`${file.name}: a place takes pictures, PDFs and .zip files.`);
      }
      for (const [i, { file, as }] of items.entries()) {
        setProgress(items.length > 1 ? `Adding ${i + 1} of ${items.length}…` : 'Adding…');
        try {
          const r = await uploadToWorkspace(workspaceId, file, as, positions && isZip(file));
          added.push(r.path.replace(/^uploads\//, ''));
          typed &&= r.typed;
          if (r.left?.length)
            problems.push(
              `Left out of ${file.name} (a place takes pictures and documents about it): ${namesOf(r.left)}.`,
            );
        } catch (e) {
          problems.push((e as Error).message);
        }
      }
    } finally {
      busy.current = false;
      setProgress(null);
    }
    if (added.length) onAdded(added, typed);
    if (problems.length) onProblem(problems.join(' '));
  };
  const addRef = useRef(add);
  addRef.current = add;

  // Files dropped anywhere on the page (a browser would otherwise open them in place of it).
  useEffect(() => {
    let depth = 0;
    const files = (e: DragEvent) => Boolean(e.dataTransfer?.types.includes('Files'));
    const enter = (e: DragEvent) => {
      if (!files(e)) return;
      depth++;
      setOver(true);
    };
    const leave = (e: DragEvent) => {
      if (!files(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setOver(false);
    };
    const dragOver = (e: DragEvent) => {
      if (!files(e) || !e.dataTransfer) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    };
    const drop = (e: DragEvent) => {
      if (!files(e) || !e.dataTransfer) return;
      e.preventDefault();
      e.stopPropagation();
      depth = 0;
      setOver(false);
      void addRef.current([...e.dataTransfer.files]);
    };
    window.addEventListener('dragenter', enter, true);
    window.addEventListener('dragleave', leave, true);
    window.addEventListener('dragover', dragOver, true);
    window.addEventListener('drop', drop, true);
    return () => {
      window.removeEventListener('dragenter', enter, true);
      window.removeEventListener('dragleave', leave, true);
      window.removeEventListener('dragover', dragOver, true);
      window.removeEventListener('drop', drop, true);
    };
  }, []);

  return (
    <>
      <Button
        variant="ghost"
        data-short={progress ? 'Adding…' : 'Add files'}
        onClick={() => picker.current?.click()}
        busy={progress !== null}
        title={
          place
            ? 'Add photos or plans (pictures, PDFs, or a .zip of them with notes) for your assistant to look at'
            : 'Add files (or a .zip of them) for your assistant to look at or use'
        }
      >
        <Icon name="upload" size={16} />
        {progress ?? 'Add files'}
      </Button>
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        {...(place ? { accept: PLACE_TYPES } : {})}
        onChange={(e) => {
          const chosen = [...(e.target.files ?? [])];
          e.target.value = '';
          void add(chosen);
        }}
      />
      {asking && <KeepPositions onAnswer={asking} />}
      {over && (
        <div className="workspace-drop" aria-hidden="true">
          <div className="workspace-drop-card">
            <Icon name="upload" size={28} />
            <strong>Drop to add {place ? 'pictures, PDFs or a .zip' : 'files'}</strong>
            <span>
              They go into uploads/ (a .zip unpacked into a folder), and their names into the
              terminal for you to send.
            </span>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * Whether to keep where a .zip's photos were taken: their positions, the way they face and their
 * lens, kept in photo-positions.json beside them so the assistant can draw its model from the
 * same spots. Photos are otherwise saved without any of their details, so it's asked, and closing
 * the question keeps nothing.
 */
function KeepPositions({ onAnswer }: { onAnswer: (keep: boolean) => void }) {
  const dialog = useModal();
  const answer = useRef(false);
  return (
    <dialog
      ref={dialog}
      className="ats-sheet"
      aria-labelledby="keep-positions-title"
      onClose={() => onAnswer(answer.current)}
    >
      <h2 id="keep-positions-title">Keep where the photos were taken?</h2>
      <p>
        Photos from a phone know where they were taken and which way they face. Keeping that lets
        your assistant draw its model from the same spots and check it against each photo. It's kept
        with the place, for your assistant only.
      </p>
      <p className="ats-muted">
        Only for photos of the outside of a building, not of a home. The pictures themselves are
        always saved without it.
      </p>
      <div className="studio-actions-row">
        <Button
          variant="primary"
          onClick={() => {
            answer.current = true;
            dialog.current?.close();
          }}
        >
          Keep where they were taken
        </Button>
        <Button variant="ghost" onClick={() => dialog.current?.close()}>
          Leave it out
        </Button>
      </div>
    </dialog>
  );
}

/** "a.jpg", "a.jpg and b.txt", "a.jpg, b.txt and c.pdf", "a.jpg, b.txt and 3 more". */
export function namesOf(names: string[]) {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length <= 3) return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
}

const PICTURE_NAME = /\.(jpe?g|png|webp|gif|avif|svg|heic|heif|tiff?)$/;
const sizeOf = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/**
 * The files added to a workspace (what's in its uploads/ folder, a .zip as its folder), newest
 * last. Tapping one puts its name in the terminal again, for the Architect to send with their
 * words; each can be removed.
 */
export function AddedFiles({
  workspaceId,
  place,
  version,
  onMentioned,
  onRemoved,
  onProblem,
}: {
  workspaceId: string;
  place: boolean;
  /** Changes when files are added (to look again). */
  version: number;
  onMentioned: (name: string, typed: boolean) => void;
  onRemoved: (name: string) => void;
  onProblem: (message: string) => void;
}) {
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [removing, setRemoving] = useState<UploadedFile | null>(null);
  const [busy, setBusy] = useState(false);
  const row = useRef<HTMLUListElement>(null);
  const remove = async ({ name }: UploadedFile) => {
    setBusy(true);
    try {
      await removeUpload(workspaceId, name);
      setFiles((list) => list.filter((f) => f.name !== name));
      onRemoved(name);
    } catch (e) {
      onProblem((e as Error).message);
    } finally {
      setBusy(false);
      setRemoving(null);
    }
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` asks again on purpose
  useEffect(() => {
    let live = true;
    const look = () =>
      listUploads(workspaceId).then(
        (list) => live && setFiles(list),
        () => {},
      );
    void look();
    // The assistant can move or remove them too.
    const t = setInterval(look, 30_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [workspaceId, version]);
  // The newest in view, whenever the list changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when `files` changes on purpose
  useEffect(() => {
    if (row.current) row.current.scrollLeft = row.current.scrollWidth;
  }, [files]);
  if (!files.length) return null;
  return (
    <div className="workspace-uploads-wrap">
      <div className="workspace-uploads">
        <span className="workspace-uploads-label">Added files</span>
        <ul ref={row} aria-label="Added files">
          {files.map((f) => (
            <li key={f.name} data-removing={removing?.name === f.name || undefined}>
              <button
                type="button"
                title={
                  f.folder
                    ? `uploads/${f.name}/ · ${f.files} file${f.files === 1 ? '' : 's'}, ${sizeOf(f.bytes)}. Tap to put its name in the terminal again.`
                    : `uploads/${f.name} · ${sizeOf(f.bytes)}. Tap to put its name in the terminal again.`
                }
                onClick={() =>
                  mentionUpload(workspaceId, f.name, f.folder).then(
                    (r) => onMentioned(f.folder ? `${f.name}/` : f.name, r.typed),
                    (e: Error) => onProblem(e.message),
                  )
                }
              >
                <Icon
                  name={f.folder ? 'folder' : PICTURE_NAME.test(f.name) ? 'image' : 'fileText'}
                  size={14}
                />
                <span>{f.folder ? `${f.name}/` : f.name}</span>
              </button>
              <IconButton
                icon="trash"
                label={`Remove ${f.name}`}
                tone="danger"
                className="workspace-uploads-remove"
                onClick={() => setRemoving(f)}
              />
            </li>
          ))}
        </ul>
      </div>
      {removing && (
        <Confirm
          confirm="Remove"
          busy={busy}
          onConfirm={() => void remove(removing)}
          onCancel={() => setRemoving(null)}
        >
          {removing.folder
            ? `Remove ${removing.name}/ and the ${removing.files} file${removing.files === 1 ? '' : 's'} in it from this workspace? Your assistant won’t be able to look at them any more.`
            : `Remove ${removing.name} from this workspace? Your assistant won’t be able to look at it any more.`}
          {place && ' The place keeps its copy with its photos and plans.'}
        </Confirm>
      )}
    </div>
  );
}
