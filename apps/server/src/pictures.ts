import decodeHeic from 'heic-decode';
import sharp, { type Sharp } from 'sharp';

/**
 * iPhone photos (HEIC) are HEIF files compressed with HEVC, which our image library can't decode
 * (it reads AVIF, the other kind of HEIF): they're decoded here first. Everything else goes
 * straight to the image library.
 */
function isHeic(b: Buffer): boolean {
  if (b.length < 16 || b.toString('latin1', 4, 8) !== 'ftyp') return false;
  const size = Math.min(b.readUInt32BE(0), b.length, 64);
  const brands = [b.toString('latin1', 8, 12)];
  for (let i = 16; i + 4 <= size; i += 4) brands.push(b.toString('latin1', i, i + 4));
  if (brands.some((x) => x === 'avif' || x === 'avis')) return false;
  return brands.some((x) => /^(heic|heix|heim|heis|hevc|hevx)$/.test(x));
}

/** The boxes (ISO BMFF) between two offsets: their type and where their contents are. */
function* boxes(b: Buffer, from: number, to: number) {
  let at = from;
  while (at + 8 <= to) {
    let size = b.readUInt32BE(at);
    let header = 8;
    if (size === 1) {
      if (at + 16 > to) return;
      const large = b.readBigUInt64BE(at + 8);
      if (large > BigInt(to - at)) return;
      size = Number(large);
      header = 16;
    } else if (size === 0) size = to - at;
    if (size < header || at + size > to) return;
    yield { type: b.toString('latin1', at + 4, at + 8), start: at + header, end: at + size };
    at += size;
  }
}

/**
 * The most pixels any image in a HEIF file says it has (its `ispe` properties), read without
 * decoding anything; null if it says none. The decoder holds images to these sizes.
 */
export function heifPixels(b: Buffer): number | null {
  let most: number | null = null;
  const inside = (box: { start: number; end: number }, type: string, skip = 0) =>
    [...boxes(b, box.start + skip, box.end)].filter((x) => x.type === type);
  for (const meta of inside({ start: 0, end: b.length }, 'meta'))
    for (const iprp of inside(meta, 'iprp', 4)) // meta is a full box: 4 bytes of version, flags
      for (const ipco of inside(iprp, 'ipco'))
        for (const ispe of inside(ipco, 'ispe')) {
          if (ispe.end - ispe.start < 12) continue;
          const pixels = b.readUInt32BE(ispe.start + 4) * b.readUInt32BE(ispe.start + 8);
          most = Math.max(most ?? 0, pixels);
        }
  return most;
}

export class PictureError extends Error {}

/** An uploaded picture, ready to be re-encoded. Throws PictureError if it can't be read. */
export async function openPicture(buffer: Buffer, limitInputPixels: number): Promise<Sharp> {
  if (isHeic(buffer)) {
    // Its size first: decoding allocates the whole picture (4 bytes a pixel) in this process.
    const pixels = heifPixels(buffer);
    if (pixels === null) throw new PictureError("That iPhone photo couldn't be read.");
    if (pixels > limitInputPixels) throw new PictureError('That picture is too big.');
    let decoded: { width: number; height: number; data: Uint8ClampedArray };
    try {
      decoded = await decodeHeic({ buffer });
    } catch {
      throw new PictureError("That iPhone photo couldn't be read.");
    }
    if (decoded.width * decoded.height > limitInputPixels)
      throw new PictureError('That picture is too big.');
    return sharp(Buffer.from(decoded.data.buffer), {
      raw: { width: decoded.width, height: decoded.height, channels: 4 },
    });
  }
  return sharp(buffer, { limitInputPixels, failOn: 'error' });
}
