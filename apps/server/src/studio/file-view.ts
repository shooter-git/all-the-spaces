/** What the Studio shows of a workspace file: text, or a picture, and nothing else. */
import type { FileView } from '@ats/api-types';

/** Text longer than this is too long to show (the supervisor allows pictures up to 8 MB). */
export const MAX_TEXT_BYTES = 1024 * 1024;

/** Pictures by their first bytes (never by name alone): only kinds a browser draws as pictures. */
const PICTURES: { type: string; ext: RegExp; magic: (b: Buffer) => boolean }[] = [
  {
    type: 'image/png',
    ext: /\.png$/i,
    magic: (b) =>
      b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  {
    type: 'image/jpeg',
    ext: /\.jpe?g$/i,
    magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    type: 'image/gif',
    ext: /\.gif$/i,
    magic: (b) => /^GIF8[79]a/.test(b.subarray(0, 6).toString('latin1')),
  },
  {
    type: 'image/webp',
    ext: /\.webp$/i,
    magic: (b) =>
      b.subarray(0, 4).toString('latin1') === 'RIFF' &&
      b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
];

/** A path the Studio may ask about: from the workspace's top, plain text, never outside it. */
export const viewablePath = (p: string) =>
  p.length > 0 &&
  p.length <= 400 &&
  ![...p].some((c) => c < ' ' || c === '\u007f') &&
  !p.startsWith('/') &&
  !p.split('/').some((part) => part === '' || part === '.' || part === '..') &&
  p !== '.git' &&
  !p.startsWith('.git/');

/**
 * How a file is shown: a picture (a raster kind its name and first bytes agree on, as a `data:`
 * address, which a browser only ever draws), or its text (UTF-8 with no NUL, short enough to
 * read). Anything else isn't shown: `too-long` text, or `not-shown` for everything else.
 */
export function viewOf(path: string, bytes: Buffer): FileView | 'too-long' | 'not-shown' {
  const picture = PICTURES.find((p) => p.ext.test(path) && p.magic(bytes));
  if (picture)
    return {
      path,
      bytes: bytes.length,
      kind: 'picture',
      src: `data:${picture.type};base64,${bytes.toString('base64')}`,
    };
  if (bytes.subarray(0, 8192).includes(0)) return 'not-shown';
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return 'not-shown';
  }
  if (bytes.length > MAX_TEXT_BYTES) return 'too-long';
  return { path, bytes: bytes.length, kind: 'text', text };
}
