// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreationSource } from '../src/lib/sources.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BUILT = 'a'.repeat(40);
const NEWER = 'b'.repeat(40);
const updates: unknown[][] = [];

vi.mock('../src/lib/sources.ts', async (actual) => ({
  ...(await actual<typeof import('../src/lib/sources.ts')>()),
  updateFromSource: async (...args: unknown[]) => {
    updates.push(args);
    return { buildId: 'build-1', commit: BUILT, label: 'v1.2' };
  },
}));

const { RepositoryPanel } = await import('../src/components/Repository.tsx');

const source = (over: Partial<CreationSource> = {}): CreationSource => ({
  host: 'github',
  hostName: 'GitHub',
  repository: 'lanternfield-club/hallowed-lanterns',
  path: '',
  follows: 'release',
  ref: null,
  updateMode: 'candidate',
  builtCommit: BUILT,
  latestCommit: BUILT,
  latestLabel: 'v1.2',
  behindBy: 0,
  checkedAt: new Date().toISOString(),
  checkError: null,
  ...over,
});

describe('a creation that follows a repository, on its card', () => {
  let host: HTMLDivElement;
  let root: Root;
  let changed: number;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    updates.length = 0;
    changed = 0;
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const show = async (s: CreationSource) => {
    await act(async () =>
      root.render(
        <RepositoryPanel
          creationId="creation-1"
          title="Hallowed Lanterns"
          source={s}
          hosts={[]}
          onChanged={() => changed++}
        />,
      ),
    );
  };
  const button = (words: string) =>
    [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(words));

  it('builds the commit it is on again when it is up to date', async () => {
    await show(source());
    expect(host.textContent).toContain('Up to date: v1.2');
    expect(button('Update to')).toBeUndefined();
    await act(async () => button('Build again')?.click());
    expect(updates).toEqual([['creation-1']]);
    expect(changed).toBe(1);
    expect(host.textContent).toContain("Building v1.2: it appears below once it's checked.");
  });

  it('offers the update instead when there is something newer', async () => {
    await show(source({ latestCommit: NEWER, latestLabel: 'v1.3', behindBy: 2 }));
    expect(button('Update to v1.3')).toBeDefined();
    expect(button('Build again')).toBeUndefined();
  });

  it('offers no rebuild when the last look went wrong, or before it is built', async () => {
    await show(source({ checkError: 'The repository is gone.' }));
    expect(button('Build again')).toBeUndefined();
    expect(button('Update to')).toBeUndefined();
    await show(source({ builtCommit: null }));
    expect(button('Build again')).toBeUndefined();
    expect(button('Update to v1.2')).toBeDefined();
  });
});
