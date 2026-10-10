import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/lib/api.ts';

// What fetch does when the network blinks mid-request.
const blink = () => Promise.reject(new TypeError('Failed to fetch'));
const ok = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

describe('api', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('asks again when the network blinks, for things safe to repeat', async () => {
    const fetch = vi
      .fn()
      .mockImplementationOnce(blink)
      .mockImplementationOnce(() => ok({ n: 1 }));
    vi.stubGlobal('fetch', fetch);
    expect(await api<{ n: number }>('/api/thing')).toEqual({ n: 1 });
    expect(fetch).toHaveBeenCalledTimes(2);

    fetch
      .mockReset()
      .mockImplementationOnce(blink)
      .mockImplementationOnce(() => ok({ ok: true }));
    await api('/api/workspaces/x/open', { method: 'POST', json: {}, retry: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('never repeats something that may not be safe to do twice', async () => {
    const fetch = vi.fn().mockImplementation(blink);
    vi.stubGlobal('fetch', fetch);
    await expect(api('/api/chat', { json: { body: 'hi' } })).rejects.toThrow(/connection dropped/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('gives up after three tries, in plain words', async () => {
    const fetch = vi.fn().mockImplementation(blink);
    vi.stubGlobal('fetch', fetch);
    await expect(api('/api/thing')).rejects.toThrow(/connection dropped/);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
