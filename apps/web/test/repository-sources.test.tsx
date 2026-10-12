// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerInfo } from '../src/lib/group.ts';
import type { ServerSources, ServerSourcesChange } from '../src/lib/sources.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sent: ServerSourcesChange[] = [];
let stored: ServerSources;
let refusal: string | null = null;

vi.mock('../src/lib/sources.ts', async (actual) => ({
  ...(await actual<typeof import('../src/lib/sources.ts')>()),
  loadServerSources: async () => stored,
  saveServerSources: async (change: ServerSourcesChange) => {
    sent.push(change);
    if (refusal) throw new Error(refusal);
    return {
      hosts: stored.hosts.map((h) => {
        const c = change.hosts.find((x) => x.id === h.id);
        return c ? { ...h, on: c.on ?? h.on, repositories: c.repositories } : h;
      }),
    };
  },
}));

let server: ServerInfo;
vi.mock('../src/lib/group.ts', () => ({ loadServer: async () => server }));

const { RepositorySources } = await import('../src/components/RepositorySources.tsx');
const { ServerInfo: ServerPage } = await import('../src/routes/ServerInfo.tsx');

const fresh = (): ServerSources => ({
  hosts: [
    {
      id: 'github-public',
      displayName: 'GitHub',
      from: 'built-in',
      on: false,
      address: 'api.github.com',
      fileRepositories: [],
      token: false,
      repositories: [],
    },
    {
      id: 'github',
      displayName: 'Our GitHub',
      from: 'file',
      on: true,
      address: 'api.github.com',
      fileRepositories: ['lanternfield-club/*'],
      token: true,
      repositories: [],
    },
  ],
});

describe('where creations may come from, on the Server page', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    stored = fresh();
    sent.length = 0;
    refusal = null;
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const show = async () => {
    await act(async () => root.render(<RepositorySources />));
  };
  const checkbox = () => host.querySelector<HTMLInputElement>('input[type="checkbox"]');
  const radio = (words: string) =>
    [...host.querySelectorAll('label')]
      .find((l) => l.textContent?.includes(words))
      ?.querySelector<HTMLInputElement>('input[type="radio"]');
  const textareas = () => [...host.querySelectorAll('textarea')];
  const click = (el: HTMLElement | null | undefined) =>
    act(async () => {
      el?.click();
    });
  const type = (el: HTMLTextAreaElement, text: string) =>
    act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      set?.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
  const save = () =>
    click([...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Save'));

  it('starts with GitHub off, and shows what a file allows without letting it be changed', async () => {
    await show();
    expect(checkbox()?.checked).toBe(false);
    expect(radio('Any public repository')).toBeUndefined();
    expect(host.textContent).toContain('Our GitHub');
    expect(host.textContent).toContain('lanternfield-club/*');
    expect(host.textContent).toContain(
      'Its file allows: lanternfield-club/* (private ones too, with the server’s token). Change these in the file.',
    );
    // The one box there is for what's added here, public only; nothing about the token itself.
    expect(textareas()).toHaveLength(1);
    expect(textareas()[0]?.value).toBe('');
    expect(host.textContent).not.toMatch(/ATS_SOURCE|tokenEnv/);
  });

  it('switches GitHub on for any public repository', async () => {
    await show();
    await click(checkbox());
    // Only the ones listed is chosen first: any at all is a choice of its own.
    expect(radio('Only the ones I list')?.checked).toBe(true);
    await click(radio('Any public repository'));
    expect(host.textContent).toContain('A private one is never read');
    await save();
    expect(sent).toEqual([
      {
        hosts: [
          { id: 'github-public', on: true, repositories: ['*'] },
          { id: 'github', repositories: [] },
        ],
      },
    ]);
    expect(host.textContent).toContain('Saved. Architects can use it straight away.');
  });

  it('lists repositories one to a line, for GitHub and for a host in a file', async () => {
    await show();
    await click(checkbox());
    const [github, file] = textareas();
    await type(github as HTMLTextAreaElement, 'lanternfield-club/*\n  someone/marble-run \n\n');
    await type(file as HTMLTextAreaElement, 'open-club/lantern-toss');
    await save();
    expect(sent[0]?.hosts).toEqual([
      {
        id: 'github-public',
        on: true,
        repositories: ['lanternfield-club/*', 'someone/marble-run'],
      },
      { id: 'github', repositories: ['open-club/lantern-toss'] },
    ]);
  });

  it('says what the server refused', async () => {
    refusal = "“x/..” isn't a repository.";
    await show();
    await type(textareas()[0] as HTMLTextAreaElement, 'x/..');
    await save();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("isn't a repository");
  });
});

describe('the Server page', () => {
  let host: HTMLDivElement;
  let root: Root;
  const me = {
    user: { id: 'u', name: 'Robin', email: 'robin@example.test' },
    groups: [{ groupId: 'g', groupName: 'House', themeColor: null, role: 'architect' as const }],
  };
  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    stored = fresh();
    server = {
      release: 'v0.1.0',
      address: 'https://spaces.example.test',
      storage: 'builtin',
      backups: { schedule: 'nightly', keepDays: 14, offsite: false },
      features: { studio: true, voice: false, email: false },
      counts: { people: 2, spaces: 1, creations: 3 },
      owner: { name: 'Pat', you: false },
    };
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });
  const show = () =>
    act(async () =>
      root.render(
        <MemoryRouter>
          <ServerPage me={me} />
        </MemoryRouter>,
      ),
    );

  it('shows other Architects who decides, without the settings', async () => {
    await show();
    expect(host.textContent).toContain('up to the server’s owner, Pat.');
    expect(host.querySelector('textarea')).toBeNull();
  });

  it('gives the owner the settings', async () => {
    server = { ...server, owner: { name: 'Robin', you: true } };
    await show();
    expect(host.textContent).toContain('Let creations come from GitHub');
  });
});
