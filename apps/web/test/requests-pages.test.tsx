// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestDetail, RequestStatus, RequestSummary } from '../src/lib/requests.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WORDS: Partial<Record<RequestStatus, string>> = {
  in_progress: 'Being built',
  not_quite: 'Not quite',
  published: 'Ready to try',
  done: 'Done',
};
const summary = (over: Partial<RequestSummary> = {}): RequestSummary => ({
  id: 'r1',
  kind: 'new',
  title: 'A book that reads itself',
  status: 'published',
  statusWords: 'Ready to try',
  open: false,
  groupId: 'g1',
  spaceId: 's1',
  spaceName: 'The Workshop',
  objectLabel: 'Bookshelf',
  objectKey: 'bookshelf',
  roomKey: 'living',
  creationId: 'c1',
  images: [],
  documents: [],
  createdAt: '2026-10-20T10:00:00Z',
  updatedAt: '2026-10-24T10:00:00Z',
  ...over,
});
const detail = (status: RequestStatus): RequestDetail => ({
  ...summary({
    status,
    statusWords: WORDS[status] ?? status,
    open: ['in_progress', 'not_quite'].includes(status),
  }),
  prompt: 'Open a book and it tells you a story.',
  mine: true,
  canWithdraw: false,
  canFinish: status === 'published',
  workspace: null,
});

let request: RequestDetail;
let mine: RequestSummary[] = [];
const said: { done: string[]; notQuite: [string, string][] } = { done: [], notQuite: [] };

vi.mock('../src/lib/requests.ts', async (actual) => ({
  ...(await actual<typeof import('../src/lib/requests.ts')>()),
  loadRequest: async () => ({ request, events: [] }),
  myRequests: async () => mine,
  requestQueue: async () => [summary({ status: 'submitted', statusWords: 'New', open: true })],
  finishRequest: async (id: string) => {
    said.done.push(id);
    request = detail('done');
    return {};
  },
  notQuite: async (id: string, note: string) => {
    said.notQuite.push([id, note]);
    request = detail('not_quite');
    return {};
  },
}));

const { MyRequests, RequestPage, RequestQueue } = await import('../src/routes/Requests.tsx');

describe('the request pages', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    said.done.length = 0;
    said.notQuite.length = 0;
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const show = async (at: string) => {
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={[at]}>
          <Routes>
            <Route path="/requests" element={<MyRequests />} />
            <Route path="/requests/:requestId" element={<RequestPage />} />
            <Route path="/studio/requests" element={<RequestQueue />} />
          </Routes>
        </MemoryRouter>,
      ),
    );
  };
  const button = (words: string) =>
    [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === words);
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
  const back = () => host.querySelector<HTMLAnchorElement>('a.ats-back');
  const steps = () =>
    [...host.querySelectorAll('.req-steps li')].map((li) => [
      li.textContent,
      li.getAttribute('data-state'),
    ]);

  it('goes back from the queue to where it is reached from, not to the last page', async () => {
    await show('/studio/requests');
    expect(back()?.getAttribute('href')).toBe('/');
    expect(back()?.textContent).toBe('Your spaces');
    act(() => root.unmount());
    root = createRoot(host);
    await show('/studio/requests?space=s1');
    expect(back()?.getAttribute('href')).toBe('/space/s1/studio');
    expect(back()?.textContent).toBe('Studio');
  });

  it('asks the person who asked whether it is what they wanted, and "That\'s it" makes it done', async () => {
    request = detail('published');
    await show('/requests/r1');
    expect(steps().at(-2)).toEqual(['Ready to try', 'now']);
    expect(host.textContent).toContain('Is it what you asked for?');
    await click(button("That's it"));
    expect(said.done).toEqual(['r1']);
    expect(steps().at(-1)).toEqual(['Done', 'now']);
    expect(steps().at(-2)).toEqual(['Ready to try', 'done']);
    expect(host.textContent).not.toContain('Is it what you asked for?');
    expect(button('Go to it')).toBeDefined();
  });

  it('sends it back with a word of why when it is not quite right, or thinks better of it', async () => {
    request = detail('published');
    await show('/requests/r1');
    await click(button('Not quite…'));
    expect(button("That's it")).toBeUndefined();
    await type(host.querySelector('textarea') as HTMLTextAreaElement, 'Hmm');
    await click(button('Cancel'));
    expect(host.querySelector('textarea')).toBeNull();
    expect(said.notQuite).toEqual([]);
    await click(button('Not quite…'));
    await type(host.querySelector('textarea') as HTMLTextAreaElement, 'It reads too fast.');
    await click(button('Send'));
    expect(said.notQuite).toEqual([['r1', 'It reads too fast.']]);
    expect(steps().find(([, state]) => state === 'now')).toEqual(['Being built', 'now']);
    expect(host.textContent).not.toContain('Is it what you asked for?');
  });

  it('lists what is ready to try first, apart from what is done', async () => {
    mine = [
      summary({ id: 'a', title: 'Done already', status: 'done', statusWords: 'Done' }),
      summary({ id: 'b', title: 'Try me', status: 'published' }),
      summary({ id: 'c', title: 'On its way', status: 'in_progress', open: true }),
    ];
    await show('/requests');
    const sections = [...host.querySelectorAll('section')].map((s) => [
      s.querySelector('h2')?.textContent,
      [...s.querySelectorAll('.req-row strong')].map((t) => t.textContent),
    ]);
    expect(sections).toEqual([
      ['Ready to try', ['Try me']],
      ['Waiting', ['On its way']],
      ['Done', ['Done already']],
    ]);
  });
});
