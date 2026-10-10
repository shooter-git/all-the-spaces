import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { add, search } from '../src/polyhaven.ts';

const md5 = (b: Uint8Array) => createHash('md5').update(b).digest('hex');
const bytes = (s: string) => new TextEncoder().encode(s);

/** A stand-in for api.polyhaven.com and its file host. */
const serve = (api: Record<string, unknown>, files: Record<string, Uint8Array> = {}) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const path = url.replace('https://api.polyhaven.com', '');
      if (path in api) return new Response(JSON.stringify(api[path]));
      if (url in files) return new Response(files[url]);
      return new Response('missing', { status: 404 });
    }),
  );

afterEach(() => vi.unstubAllGlobals());

describe('ats assets search', () => {
  const api = {
    '/assets?t=models': {
      wooden_chair: { name: 'Wooden Chair', categories: ['furniture'], download_count: 10 },
      office_chair: { name: 'Office Chair', tags: ['wood'], download_count: 500 },
      lamp: { name: 'Lamp', categories: ['lighting'], download_count: 9000 },
    },
    '/assets?t=textures': {
      wood_floor: { name: 'Wood Floor', authors: { Rob: 'All' }, download_count: 50 },
    },
    '/assets?t=hdris': {},
  };

  it('ranks by how many words match, then by how often each is downloaded', async () => {
    serve(api);
    const found = await search('wooden chair');
    expect(found.map((f) => f.id)).toEqual(['wooden_chair', 'office_chair']);
    expect(found[0]).toEqual({
      id: 'wooden_chair',
      name: 'Wooden Chair',
      type: 'models',
      categories: ['furniture'],
      authors: [],
    });
  });

  it('looks in one kind of asset when asked, and keeps to the limit', async () => {
    serve(api);
    expect((await search('wood', 'textures')).map((f) => f.id)).toEqual(['wood_floor']);
    expect(await search('', 'models', 2)).toHaveLength(2);
  });
});

describe('ats assets add', () => {
  let dir = '';
  const diffuse = bytes('diffuse');
  const hdr = bytes('sky');
  const file = (url: string, body: Uint8Array) => ({ url, md5: md5(body), size: body.length });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ats-cli-test-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('downloads a texture into public/assets with a credit for assets.lock.json', async () => {
    serve(
      {
        '/info/planks': { name: 'Planks', type: 1, authors: { 'Rob Tuytel': 'All' } },
        '/files/planks': { Diffuse: { '1k': { jpg: file('https://dl/d.jpg', diffuse) } } },
      },
      { 'https://dl/d.jpg': diffuse },
    );
    const result = await add(dir, 'planks');
    expect(result).toEqual({
      type: 'textures',
      files: ['public/assets/planks/planks_diffuse.jpg'],
      credit: {
        license: 'CC0-1.0',
        source: 'https://polyhaven.com/a/planks',
        title: 'Planks',
        author: 'Rob Tuytel',
      },
    });
    expect(await readFile(join(dir, result.files[0] as string))).toEqual(Buffer.from(diffuse));
  });

  it('falls back to 1k when the resolution asked for is missing', async () => {
    serve(
      {
        '/info/sky': { name: 'Sky', type: 0 },
        '/files/sky': { hdri: { '1k': { hdr: file('https://dl/sky.hdr', hdr) } } },
      },
      { 'https://dl/sky.hdr': hdr },
    );
    const result = await add(dir, 'sky', '4k');
    expect(result.files).toEqual(['public/assets/sky/sky.hdr']);
    expect(result.credit.author).toBe('Poly Haven');
  });

  it('refuses ids that are not Poly Haven ids, and downloads that fail their checksum', async () => {
    await expect(add(dir, '../../etc')).rejects.toThrow('Not a Poly Haven asset id');
    serve(
      {
        '/info/sky': { name: 'Sky', type: 0 },
        '/files/sky': { hdri: { '1k': { hdr: { ...file('https://dl/sky.hdr', hdr), md5: '0' } } } },
      },
      { 'https://dl/sky.hdr': hdr },
    );
    await expect(add(dir, 'sky')).rejects.toThrow("Download didn't match its checksum");
    await expect(readFile(join(dir, 'public/assets/sky/sky.hdr'))).rejects.toThrow();
  });
});
