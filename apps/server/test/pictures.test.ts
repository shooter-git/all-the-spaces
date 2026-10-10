import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';

// The real decoder, watched: a picture that's too big must never reach it.
const decoder = vi.hoisted(() => ({ calls: 0 }));
vi.mock('heic-decode', async (original) => {
  const real = ((await original()) as { default: (o: { buffer: Buffer }) => Promise<unknown> })
    .default;
  return {
    default: (opts: { buffer: Buffer }) => {
      decoder.calls++;
      return real(opts);
    },
  };
});

const { heifPixels, openPicture } = await import('../src/pictures.ts');

const LIMIT = 50_000_000;
const box = (type: string, ...contents: Buffer[]) => {
  const body = Buffer.concat(contents);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
};
const u32 = (...n: number[]) => {
  const b = Buffer.alloc(4 * n.length);
  n.forEach((v, i) => {
    b.writeUInt32BE(v, 4 * i);
  });
  return b;
};
/** Just the header of an iPhone photo: says how big it is, holds no picture at all. */
const header = (width: number, height: number) =>
  Buffer.concat([
    box('ftyp', Buffer.from('heic', 'latin1'), u32(0), Buffer.from('mif1heic', 'latin1')),
    box(
      'meta',
      u32(0),
      box('hdlr', u32(0, 0), Buffer.from('pict', 'latin1'), u32(0, 0, 0), Buffer.alloc(1)),
      box('iprp', box('ipco', box('ispe', u32(0, width, height)))),
    ),
  ]);

describe('iPhone photos (HEIC)', () => {
  it('reads how big a photo is from its header, without decoding it', async () => {
    expect(heifPixels(header(16_000, 16_000))).toBe(256_000_000);
    const photo = await readFile(new URL('./fixtures/photo.heic', import.meta.url));
    expect(heifPixels(photo)).toBe(1200 * 900);
  });

  it('refuses one that says it is too big before decoding anything', async () => {
    decoder.calls = 0;
    await expect(openPicture(header(16_000, 16_000), LIMIT)).rejects.toThrow(
      'That picture is too big.',
    );
    // A real photo whose header claims more pixels than allowed.
    const photo = await readFile(new URL('./fixtures/photo.heic', import.meta.url));
    await expect(openPicture(photo, 1000 * 900)).rejects.toThrow('That picture is too big.');
    expect(decoder.calls).toBe(0);
  });

  it("refuses one that doesn't say how big it is", async () => {
    decoder.calls = 0;
    const photo = await readFile(new URL('./fixtures/photo.heic', import.meta.url));
    const at = photo.indexOf('ispe', 0, 'latin1');
    const nameless = Buffer.from(photo);
    nameless.write('free', at, 'latin1');
    await expect(openPicture(nameless, LIMIT)).rejects.toThrow("couldn't be read");
    expect(decoder.calls).toBe(0);
  });

  it('still opens a real photo', async () => {
    decoder.calls = 0;
    const photo = await readFile(new URL('./fixtures/photo.heic', import.meta.url));
    const image = await openPicture(photo, LIMIT);
    expect(await image.metadata()).toMatchObject({ width: 1200, height: 900 });
    expect(decoder.calls).toBe(1);
  });
});
