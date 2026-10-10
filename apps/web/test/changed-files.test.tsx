// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChangedFiles, treeOf } from '../src/components/ChangedFiles.tsx';
import type { ChangedFile, FileView } from '../src/lib/workbench.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const workbench = vi.hoisted(() => ({
  answers: [] as { files: ChangedFile[]; more: boolean }[],
  asked: 0,
  /** What each file holds, or the error opening it gives. */
  views: new Map<string, FileView | Error>(),
  viewed: [] as string[],
}));
vi.mock('../src/lib/workbench.ts', () => ({
  listChanges: async () => {
    workbench.asked++;
    return workbench.answers.shift() ?? { files: [], more: false };
  },
  viewFile: async (_id: string, path: string) => {
    workbench.viewed.push(path);
    const v = workbench.views.get(path);
    if (!v || v instanceof Error) throw v ?? new Error('missing');
    return v;
  },
}));

const files: ChangedFile[] = [
  { path: 'src/scenes/level.ts', change: 'added' },
  { path: 'src/scenes/menu.ts', change: 'changed' },
  { path: 'src/main.ts', change: 'changed' },
  { path: 'src/old.ts', change: 'removed' },
  { path: 'assets/models/robot/robot.glb', change: 'added' },
  { path: 'README.md', change: 'changed' },
];

describe('the files the assistant made or changed, as folders', () => {
  it('nests them, folders first, and folds a folder holding only one folder into it', () => {
    const top = treeOf(files);
    expect(top.files.map((f) => f.name)).toEqual(['README.md']);
    expect(top.folders.map((d) => d.name)).toEqual(['assets/models/robot', 'src']);
    const src = top.folders[1];
    expect(src?.folders.map((d) => d.name)).toEqual(['scenes']);
    expect(src?.files.map((f) => `${f.name} ${f.change}`)).toEqual([
      'main.ts changed',
      'old.ts removed',
    ]);
    expect(top.folders[0]?.files.map((f) => f.path)).toEqual(['assets/models/robot/robot.glb']);
  });
});

describe('the Files pane', () => {
  let box: HTMLElement;
  let root: Root;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    workbench.answers = [];
    workbench.asked = 0;
    workbench.views = new Map();
    workbench.viewed = [];
    box = document.createElement('div');
    document.body.append(box);
    root = createRoot(box);
  });
  afterEach(() => {
    act(() => root.unmount());
    box.remove();
    vi.useRealTimers();
  });
  const settle = () => act(async () => {});

  it('asks nothing while it is out of sight', async () => {
    act(() => root.render(<ChangedFiles workspaceId="w1" shown={false} />));
    await settle();
    await act(async () => vi.advanceTimersByTime(20_000));
    expect(workbench.asked).toBe(0);
  });

  it('lists names with what happened to each, and marks what just appeared', async () => {
    workbench.answers.push({ files: files.slice(0, 2), more: false }, { files, more: false });
    act(() => root.render(<ChangedFiles workspaceId="w1" shown />));
    await settle();
    expect(box.textContent).toContain('1 new · 1 changed since this workspace started.');
    // The first look marks nothing as just made.
    expect(box.querySelectorAll('[data-fresh]')).toHaveLength(0);

    await act(async () => vi.advanceTimersByTime(5000));
    await settle();
    expect(workbench.asked).toBe(2);
    expect(box.textContent).toContain('2 new · 3 changed · 1 removed');
    const row = (name: string) =>
      [...box.querySelectorAll<HTMLElement>('.changed-file')].find((r) =>
        r.textContent?.startsWith(name),
      );
    expect(row('old.ts')?.dataset.change).toBe('removed');
    expect(row('old.ts')?.textContent).toContain('removed');
    // Only what's new since the last look is marked.
    expect([...box.querySelectorAll('[data-fresh]')].map((r) => r.getAttribute('title'))).toEqual([
      'assets/models/robot/robot.glb',
      'src/main.ts',
      'src/old.ts',
      'README.md',
    ]);
  });

  it('says so when nothing has changed yet, and when there are more than it lists', async () => {
    act(() => root.render(<ChangedFiles workspaceId="w1" shown />));
    await settle();
    expect(box.textContent).toContain('Nothing yet.');
    workbench.answers.push({ files: files.slice(0, 1), more: true });
    await act(async () => vi.advanceTimersByTime(5000));
    await settle();
    expect(box.textContent).toContain('only the first 1 are listed');
  });

  const button = (name: string) =>
    [...box.querySelectorAll<HTMLButtonElement>('button.changed-file-row')].find((b) =>
      b.textContent?.startsWith(name),
    );

  it("opens a file to show what's in it, and goes back to the folders as they were", async () => {
    workbench.answers.push({ files, more: false });
    workbench.views.set('src/main.ts', {
      path: 'src/main.ts',
      bytes: 24,
      kind: 'text',
      text: 'export const speed = 3;\n',
    });
    act(() => root.render(<ChangedFiles workspaceId="w1" shown />));
    await settle();
    // A folder closed before opening a file stays closed after.
    const assets = box.querySelector<HTMLDetailsElement>('details');
    if (assets) assets.open = false;
    // A removed file has nothing left to open.
    expect(button('old.ts')).toBeUndefined();

    act(() => button('main.ts')?.click());
    await settle();
    expect(workbench.viewed).toEqual(['src/main.ts']);
    expect(box.querySelector('.file-view h2')?.textContent).toBe('main.ts');
    expect(box.querySelector('.file-view')?.textContent).toContain('src/main.ts · 24 bytes');
    expect(box.querySelector('pre')?.textContent).toBe('export const speed = 3;\n');
    expect(box.querySelector<HTMLElement>('.changed-files-list')?.hidden).toBe(true);

    // Look again: read afresh (the assistant may have changed it).
    act(() =>
      box.querySelector<HTMLButtonElement>('.file-view [aria-label="Look again"]')?.click(),
    );
    await settle();
    expect(workbench.viewed).toEqual(['src/main.ts', 'src/main.ts']);

    act(() => box.querySelector<HTMLButtonElement>('[aria-label="Back to the files"]')?.click());
    expect(box.querySelector('.file-view')).toBeNull();
    expect(box.querySelector<HTMLElement>('.changed-files-list')?.hidden).toBe(false);
    expect(box.querySelector<HTMLDetailsElement>('details')?.open).toBe(false);
  });

  it('shows a picture as a picture, and says why a file can’t be shown', async () => {
    workbench.answers.push({ files, more: false });
    workbench.views.set(
      'assets/models/robot/robot.glb',
      new Error("This file isn't text or a picture, so it can't be shown here."),
    );
    workbench.views.set('src/scenes/level.ts', {
      path: 'src/scenes/level.ts',
      bytes: 2048,
      kind: 'picture',
      src: 'data:image/png;base64,iVBORw0KGgo=',
    });
    act(() => root.render(<ChangedFiles workspaceId="w1" shown />));
    await settle();
    act(() => button('robot.glb')?.click());
    await settle();
    expect(box.textContent).toContain(
      "This file isn't text or a picture, so it can't be shown here.",
    );
    act(() => box.querySelector<HTMLButtonElement>('[aria-label="Back to the files"]')?.click());
    act(() => button('level.ts')?.click());
    await settle();
    const img = box.querySelector('img');
    expect(img?.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(img?.getAttribute('alt')).toBe('level.ts');
    expect(box.textContent).toContain('2 KB');
  });
});
