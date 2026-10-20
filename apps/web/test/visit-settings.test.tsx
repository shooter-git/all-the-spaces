// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VisitSettings } from '../src/components/VisitSettings.tsx';
import { routes, until } from './helpers/fakes.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;
const text = () => container.textContent ?? '';
const button = (label: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(label));
const box = () => container.querySelector<HTMLInputElement>('input[type=checkbox]');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('recording where people spend time', () => {
  it('asks before turning it off, since that deletes what was recorded', async () => {
    const saved: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      routes({
        '/api/groups/g1/visit-settings': (init) => {
          if (init?.method !== 'PUT') return { visits: true };
          saved.push(JSON.parse(String(init.body)));
          return { ok: true };
        },
      }),
    );
    await act(async () => root.render(<VisitSettings groupId="g1" />));
    await until(() => box()?.checked === true && !box()?.disabled);

    // Unticking only asks; keeping it changes nothing.
    await act(async () => box()?.click());
    expect(text()).toContain('is deleted now');
    expect(saved).toEqual([]);
    await act(async () => button('Keep recording')?.click());
    expect(button('Turn off and delete')).toBeUndefined();
    expect(box()?.checked).toBe(true);

    await act(async () => box()?.click());
    await act(async () => button('Turn off and delete')?.click());
    await until(() => box()?.checked === false && text().includes('saved'));
    expect(saved).toEqual([{ visits: false }]);
    expect(button('Turn off and delete')).toBeUndefined();

    // Turning it back on deletes nothing, so it doesn't ask.
    await act(async () => box()?.click());
    await until(() => box()?.checked === true);
    expect(saved).toEqual([{ visits: false }, { visits: true }]);
  });
});
