import { Icon, IconButton, Notice } from '@ats/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type ChangedFile, type FileView, listChanges, viewFile } from '../lib/workbench.ts';
import './changed-files.css';

/** How often the list looks again while it's on screen. */
const EVERY_MS = 5000;

const WORDS: Record<ChangedFile['change'], string> = {
  added: 'new',
  changed: 'changed',
  removed: 'removed',
};

/** A folder of changed files: its own name, possibly several folders deep ("src/scenes"). */
export interface Folder {
  name: string;
  folders: Folder[];
  files: (ChangedFile & { name: string })[];
}

/**
 * The folders the files are in, folders first and each in name order. A folder holding only one
 * other folder is shown as one ("src/scenes"), so a deep file doesn't need a click per level.
 */
export function treeOf(files: ChangedFile[]): Folder {
  const top: Folder = { name: '', folders: [], files: [] };
  for (const f of files) {
    const parts = f.path.split('/');
    const name = parts.pop() as string;
    let here = top;
    for (const part of parts) {
      let next = here.folders.find((d) => d.name === part);
      if (!next) {
        next = { name: part, folders: [], files: [] };
        here.folders.push(next);
      }
      here = next;
    }
    here.files.push({ ...f, name });
  }
  const tidy = (d: Folder): Folder => {
    let folder = d;
    while (folder.name && folder.files.length === 0 && folder.folders.length === 1) {
      const only = folder.folders[0] as Folder;
      folder = { ...only, name: `${folder.name}/${only.name}` };
    }
    return {
      ...folder,
      folders: folder.folders.map(tidy).sort((a, b) => a.name.localeCompare(b.name)),
      files: folder.files.sort((a, b) => a.name.localeCompare(b.name)),
    };
  };
  return tidy(top);
}

const count = (d: Folder): number => d.files.length + d.folders.reduce((n, f) => n + count(f), 0);

/**
 * What the assistant has made, changed or removed in the workspace since it started, as folders.
 * Looks again every few seconds while shown, and marks what's just appeared or changed; choosing a
 * file shows what's in it (the folders stay as they were, for going back).
 */
export function ChangedFiles({ workspaceId, shown }: { workspaceId: string; shown: boolean }) {
  const [list, setList] = useState<{ files: ChangedFile[]; more: boolean } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  /** Paths new or different since the last look (none on the first). */
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const last = useRef<Map<string, string> | null>(null);
  /** The file being looked at, if any. */
  const [open, setOpen] = useState<string | null>(null);

  const look = useCallback(
    () =>
      listChanges(workspaceId).then(
        (r) => {
          const before = last.current;
          const now = new Map(r.files.map((f) => [f.path, f.change]));
          setFresh(
            new Set(
              before
                ? r.files.filter((f) => before.get(f.path) !== f.change).map((f) => f.path)
                : [],
            ),
          );
          last.current = now;
          setList(r);
          setProblem(null);
        },
        (e: Error) => setProblem(e.message),
      ),
    [workspaceId],
  );
  /** Looking again because they asked (not the look every few seconds). */
  const [looking, setLooking] = useState(false);
  const lookAgain = () => {
    setLooking(true);
    void look().finally(() => setLooking(false));
  };

  useEffect(() => {
    if (!shown) return;
    void look();
    const t = setInterval(look, EVERY_MS);
    return () => clearInterval(t);
  }, [shown, look]);

  const tally = (change: ChangedFile['change']) =>
    list?.files.filter((f) => f.change === change).length ?? 0;
  const summary = (['added', 'changed', 'removed'] as const)
    .map((c) => ({ c, n: tally(c) }))
    .filter(({ n }) => n > 0)
    .map(({ c, n }) => `${n} ${WORDS[c]}`)
    .join(' · ');

  const fileRow = (f: Folder['files'][number]) => {
    const row = (
      <>
        <Icon name="file" size={15} />
        <span className="changed-file-name">{f.name}</span>
        <span className="changed-file-badge">{WORDS[f.change]}</span>
      </>
    );
    return (
      <li
        key={f.path}
        className="changed-file"
        data-change={f.change}
        data-fresh={fresh.has(f.path) || undefined}
        title={f.path}
      >
        {/* A removed file has nothing left to show. */}
        {f.change === 'removed' ? (
          <div className="changed-file-row">{row}</div>
        ) : (
          <button type="button" className="changed-file-row" onClick={() => setOpen(f.path)}>
            {row}
          </button>
        )}
      </li>
    );
  };
  const folderRow = (d: Folder, path: string) => (
    <li key={`${path}${d.name}/`}>
      <details open>
        <summary>
          <Icon name="folder" size={15} />
          <span className="changed-file-name">{d.name}</span>
          <span className="ats-muted changed-files-count">{count(d)}</span>
        </summary>
        <ul>{contents(d, `${path}${d.name}/`)}</ul>
      </details>
    </li>
  );
  const contents = (d: Folder, path: string) => [
    ...d.folders.map((f) => folderRow(f, path)),
    ...d.files.map(fileRow),
  ];

  return (
    <div className="changed-files">
      {open && <FileViewer workspaceId={workspaceId} path={open} onBack={() => setOpen(null)} />}
      {/* Kept while a file is open (hidden), so its folders are as they were on the way back. */}
      <div className="changed-files-list" hidden={open !== null}>
        <div className="changed-files-head">
          <div>
            <h2>Files</h2>
            <p className="ats-muted studio-small">
              {list && list.files.length > 0
                ? `${summary} since this workspace started. Choose one to see what's in it.`
                : null}
            </p>
          </div>
          <IconButton icon="refresh" label="Look again" onClick={lookAgain} busy={looking} />
        </div>
        {problem && <Notice tone="error">{problem}</Notice>}
        {!list ? (
          !problem && <p className="ats-muted">Looking…</p>
        ) : list.files.length === 0 ? (
          <p className="ats-muted">
            Nothing yet. Files your assistant makes or changes show here as it works.
          </p>
        ) : (
          <>
            <ul className="changed-files-tree" aria-label="Files made or changed">
              {contents(treeOf(list.files), '')}
            </ul>
            {list.more && (
              <p className="ats-muted studio-small">
                There are more than can be shown here: only the first {list.files.length} are
                listed.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const size = (bytes: number) =>
  bytes < 1024
    ? `${bytes} bytes`
    : bytes < 1024 * 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/**
 * What's in one workspace file: its text, or the picture. Opening one takes a moment (a helper
 * that has only the workspace reads it); "Look again" reads it afresh as the assistant works.
 */
export function FileViewer({
  workspaceId,
  path,
  onBack,
}: {
  workspaceId: string;
  path: string;
  onBack: () => void;
}) {
  const [view, setView] = useState<FileView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [reading, setReading] = useState(true);
  /** Only the latest read is shown (an earlier one can finish after it). */
  const latest = useRef(0);

  const read = useCallback(() => {
    const n = ++latest.current;
    setReading(true);
    viewFile(workspaceId, path).then(
      (v) => {
        if (n !== latest.current) return;
        setView(v);
        setProblem(null);
        setReading(false);
      },
      (e: Error) => {
        if (n !== latest.current) return;
        setView(null);
        setProblem(e.message);
        setReading(false);
      },
    );
  }, [workspaceId, path]);
  useEffect(read, [read]);

  const name = path.split('/').pop() ?? path;
  return (
    <section className="file-view" aria-label={name}>
      <div className="file-view-head">
        <IconButton icon="back" label="Back to the files" onClick={onBack} />
        <div className="file-view-title">
          <h2>{name}</h2>
          <p className="ats-muted studio-small">
            {path}
            {view ? ` · ${size(view.bytes)}` : ''}
          </p>
        </div>
        <IconButton icon="refresh" label="Look again" onClick={read} busy={reading} />
      </div>
      {problem && <Notice tone="error">{problem}</Notice>}
      {reading && !view && !problem ? (
        <p className="ats-muted">Opening… (a few seconds)</p>
      ) : view?.kind === 'picture' ? (
        <div className="file-view-picture">
          <img src={view.src} alt={name} />
        </div>
      ) : view?.kind === 'text' ? (
        view.text ? (
          <section
            className="file-view-text"
            aria-label={`What's in ${name}`}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: a long file scrolls, and keyboard users must reach it to scroll it (Safari doesn't make scrolling boxes focusable)
            tabIndex={0}
          >
            <pre>{view.text}</pre>
          </section>
        ) : (
          <p className="ats-muted">This file is empty.</p>
        )
      ) : null}
    </section>
  );
}
