import { Unzip, UnzipInflate } from 'fflate';

/**
 * A .zip the Architect adds to a workspace (a "pack"): photos, a README, a manifest, reference
 * documents. It's unpacked on the way in and kept together as one folder in `uploads/`, with its
 * own names and folders: a README or manifest in it names its files, so they must stay as they are.
 */
export const PACK_LIMITS = {
  /** Files in one pack. */
  files: 1000,
  /** Unpacked, all together, counted as it unpacks (not what the archive says). */
  unpacked: 200 * 1024 * 1024,
  /** Folders deep. */
  depth: 8,
};

export class PackError extends Error {}

/** A name kept as it is: letters, digits, dots, dashes and underscores. */
const PLAIN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/** What an archive tool or a computer leaves in a zip that nobody put there on purpose. */
const JUNK = /^(__MACOSX|\..*|Thumbs\.db|desktop\.ini)$/i;

/** A zip file, by its first bytes (an empty zip has only its end record). */
export const isZip = (data: Buffer) =>
  data.length >= 4 &&
  data[0] === 0x50 &&
  data[1] === 0x4b &&
  ((data[2] === 3 && data[3] === 4) || (data[2] === 5 && data[3] === 6));

/** One part of a path as it can be kept: unchanged when it's plain, made plain when it isn't. */
export function packName(part: string): string {
  if (PLAIN.test(part)) return part;
  const plain = part
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+/, '')
    .slice(0, 100)
    .replace(/[-.]+$/, '');
  return plain || 'file';
}

/**
 * The files in a zip, by their paths inside it, without folders of their own, junk or anything
 * that climbs out. Refuses one that unpacks too big or holds too many files.
 */
export function unzipPack(body: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let total = 0;
  let count = 0;
  let refused: PackError | null = null;
  const unzip = new Unzip((file) => {
    if (refused || file.name.endsWith('/')) return;
    const parts = file.name.replace(/\\/g, '/').split('/');
    if (parts.some((p) => JUNK.test(p))) return;
    if (parts.some((p) => !p || p === '..') || parts.length > PACK_LIMITS.depth) {
      refused = new PackError('It holds something with an odd name.');
      return;
    }
    if (++count > PACK_LIMITS.files) {
      refused = new PackError(`It holds more than ${PACK_LIMITS.files} files.`);
      return;
    }
    const pieces: Uint8Array[] = [];
    file.ondata = (err, data, final) => {
      if (refused) return;
      if (err) {
        refused = new PackError('It’s damaged.');
        return;
      }
      total += data.byteLength;
      if (total > PACK_LIMITS.unpacked) {
        refused = new PackError(
          `It unpacks to more than ${PACK_LIMITS.unpacked / 1024 / 1024} MB.`,
        );
        return;
      }
      pieces.push(data);
      if (final) files.set(parts.join('/'), Buffer.concat(pieces));
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  // Small pieces: each one unpacks to at most about a thousand times its size.
  const piece = 16 * 1024;
  try {
    for (let at = 0; at < body.length && !refused; at += piece)
      unzip.push(body.subarray(at, at + piece), at + piece >= body.length);
  } catch {
    refused ??= new PackError('It isn’t a zip that can be read.');
  }
  if (refused) throw refused;
  return files;
}

/**
 * Where a pack's files go: the folder they're all in when the zip has just one at its top (as
 * most do), otherwise one named after the zip; and each file's path inside it, made plain where
 * it has to be (two that end up the same keep both, numbered).
 */
export function arrangePack(
  files: Map<string, Buffer>,
  zipName: string,
): { folder: string; files: Map<string, Buffer> } {
  const paths = [...files.keys()];
  const top = paths[0]?.split('/')[0];
  const shared = Boolean(top) && paths.every((p) => p.startsWith(`${top}/`));
  const folder = shared ? (top as string) : zipName.replace(/\.zip$/i, '');
  const arranged = new Map<string, Buffer>();
  for (const [path, data] of files) {
    const inside = (shared ? path.split('/').slice(1) : path.split('/')).map(packName);
    let name = inside.join('/');
    for (let i = 2; arranged.has(name); i++) {
      const last = inside.at(-1) as string;
      const dot = last.lastIndexOf('.');
      const numbered = dot > 0 ? `${last.slice(0, dot)}-${i}${last.slice(dot)}` : `${last}-${i}`;
      name = [...inside.slice(0, -1), numbered].join('/');
    }
    arranged.set(name, data);
  }
  return { folder, files: arranged };
}
