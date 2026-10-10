import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PolyHaven } from '../src/index.ts';

const md5 = (b: Uint8Array) => createHash('md5').update(b).digest('hex');
const bytes = (s: string) => new TextEncoder().encode(s);
const ref = (url: string, body: Uint8Array, md5sum = md5(body)) => ({
  url,
  size: body.byteLength,
  md5: md5sum,
});

/** A stand-in for api.polyhaven.com and its file host, counting what was fetched. */
function fakePolyHaven(files: Record<string, Uint8Array>, api: Record<string, unknown>) {
  const fetched: string[] = [];
  const fetch = vi.fn(async (url: string) => {
    fetched.push(url);
    const path = url.replace('https://api.polyhaven.com', '');
    if (path in api) return new Response(JSON.stringify(api[path]));
    if (url in files) return new Response(files[url]);
    return new Response('missing', { status: 404 });
  });
  return { fetch, fetched };
}

describe('Poly Haven assets', () => {
  let cacheDir = '';
  const diffuse = bytes('diffuse pixels');
  const normal = bytes('normal pixels');
  const arm = bytes('arm pixels');
  const api = {
    '/info/planks': { name: 'Planks', authors: { 'Rob Tuytel': 'All' }, dimensions: [2000, 1000] },
    '/files/planks': {
      Diffuse: { '1k': { jpg: ref('https://dl/diffuse.jpg', diffuse) } },
      nor_gl: { '1k': { jpg: ref('https://dl/normal.jpg', normal) } },
      arm: { '1k': { jpg: ref('https://dl/arm.jpg', arm) } },
    },
  };
  const files = {
    'https://dl/diffuse.jpg': diffuse,
    'https://dl/normal.jpg': normal,
    'https://dl/arm.jpg': arm,
  };

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'ats-assets-test-'));
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(cacheDir, { recursive: true, force: true });
  });

  it('downloads a texture with its licence record, and serves it from the cache after', async () => {
    const fake = fakePolyHaven(files, api);
    vi.stubGlobal('fetch', fake.fetch);
    const set = await new PolyHaven(cacheDir).texture('planks');
    expect(set.credit).toEqual({
      source: 'polyhaven',
      id: 'planks',
      name: 'Planks',
      license: 'CC0-1.0',
      url: 'https://polyhaven.com/a/planks',
      authors: ['Rob Tuytel'],
    });
    expect(set.size).toEqual([2, 1]);
    expect([set.diffuse, set.normal, set.arm]).toEqual([diffuse, normal, arm]);
    expect(await readFile(join(cacheDir, 'textures/planks/1k/Diffuse.jpg'))).toEqual(
      Buffer.from(diffuse),
    );

    // Offline now: everything comes from the cache.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    expect((await new PolyHaven(cacheDir).texture('planks')).arm).toEqual(arm);
  });

  it("refuses a download that doesn't match its checksum, and keeps nothing of it", async () => {
    const tampered = {
      ...api,
      '/files/planks': {
        ...api['/files/planks'],
        Diffuse: { '1k': { jpg: ref('https://dl/diffuse.jpg', diffuse, md5(bytes('other'))) } },
      },
    };
    vi.stubGlobal('fetch', fakePolyHaven(files, tampered).fetch);
    await expect(new PolyHaven(cacheDir).texture('planks')).rejects.toThrow(/Checksum mismatch/);
    await expect(readFile(join(cacheDir, 'textures/planks/1k/Diffuse.jpg'))).rejects.toThrow();
  });

  it('says which map is missing, and when Poly Haven answers with an error', async () => {
    vi.stubGlobal('fetch', fakePolyHaven(files, api).fetch);
    await expect(new PolyHaven(cacheDir).texture('planks', '2k')).rejects.toThrow(
      'Texture planks has no Diffuse map at 2k',
    );
    await expect(new PolyHaven(cacheDir).hdri('nowhere')).rejects.toThrow(
      'Poly Haven /files/nowhere: HTTP 404',
    );
  });
});
