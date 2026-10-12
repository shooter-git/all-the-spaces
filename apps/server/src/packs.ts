import { Unzip, UnzipInflate, unzipSync, type Zippable, zipSync } from 'fflate';
import { fieldOfView, photoPosition } from './photo-position.ts';
import { openPicture } from './pictures.ts';

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

/** Why a zip can't be added (400, or 415 when nothing in it is something a place takes). */
export class PackError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/**
 * A plain, safe file name from whatever the Architect's file was called ("Kitchen Window
 * (2).HEIC" → kitchen-window-2 + .heic): lower case letters, digits and dashes only.
 */
export function uploadName(original: string): { base: string; ext: string } {
  const plain = original.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  const dot = plain.lastIndexOf('.');
  const rawExt = dot > 0 ? plain.slice(dot + 1) : '';
  const ext = /^[a-z0-9]{1,10}$/.test(rawExt) ? rawExt : '';
  const base =
    (ext ? plain.slice(0, dot) : plain)
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/, '') || 'file';
  return { base, ext };
}

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

/** Pictures cleaned on the way in (others, like GIF and SVG, are kept as they are). */
const PICTURE = /^(jpe?g|png|webp|heic|heif|avif|tiff?)$/;
/** Pictures a pack keeps in their own format, cleaned (any other picture becomes a JPEG). */
const KEEP_FORMAT: Record<string, 'jpeg' | 'png' | 'webp' | 'avif' | 'tiff'> = {
  jpg: 'jpeg',
  jpeg: 'jpeg',
  png: 'png',
  webp: 'webp',
  avif: 'avif',
  tif: 'tiff',
  tiff: 'tiff',
};
/** Besides pictures, what a place's pack may hold: documents about the place. */
const PLACE_DOCUMENT = /^(pdf|md|markdown|txt|json|csv|tsv|ya?ml|geojson|kml|gif|svg)$/;

/**
 * One file from a pack as it's kept: a picture without its hidden details (where and on what it
 * was taken), in its own format and under its own name where it can be (the pack's README or
 * manifest names it). Null when a place's pack can't take it: a place takes pictures and
 * documents about it, and a picture that can't be read is left out (a creation keeps it as it
 * is).
 */
async function packFile(path: string, data: Buffer, place: boolean) {
  const dot = path.lastIndexOf('.');
  const ext = dot > path.lastIndexOf('/') + 1 ? path.slice(dot + 1).toLowerCase() : '';
  if (PICTURE.test(ext)) {
    try {
      const img = (await openPicture(data, 100_000_000))
        .rotate()
        .resize({ width: 4096, height: 4096, fit: 'inside', withoutEnlargement: true });
      const format = KEEP_FORMAT[ext];
      if (format === 'jpeg' || !format)
        return {
          path: format ? path : `${path.slice(0, dot)}.jpg`,
          data: await img.jpeg({ quality: 90, mozjpeg: true }).toBuffer(),
        };
      return { path, data: await img.toFormat(format).toBuffer() };
    } catch {
      return place ? null : { path, data };
    }
  }
  return place && !PLACE_DOCUMENT.test(ext) ? null : { path, data };
}

/** Where the pack's photos were taken, when the Architect chose to keep it. */
export const POSITIONS_FILE = 'photo-positions.json';

/**
 * A zip as it's kept: unpacked and arranged, its pictures cleaned, and what a place can't take
 * left out (`left`). The folder is a plain name (lower case, digits and dashes).
 *
 * With `positions` (the Architect's choice: photos of the outside of a building, not of a home),
 * where each photo was taken is read from its details before they're cleaned off, and kept in
 * `photo-positions.json` beside them: position, direction and lens only, in the form
 * `ats space match` reads. The pictures themselves are still saved without any details.
 */
export async function preparePack(
  body: Buffer,
  zipName: string,
  place: boolean,
  options: { positions?: boolean } = {},
): Promise<{
  folder: string;
  files: Map<string, Buffer>;
  left: string[];
  bytes: number;
  /** How many photos had a position kept. */
  positioned: number;
}> {
  const arranged = arrangePack(unzipPack(body), zipName);
  if (!arranged.files.size) throw new PackError('It’s empty.');
  const files = new Map<string, Buffer>();
  const left: string[] = [];
  const photos: Record<string, unknown>[] = [];
  let bytes = 0;
  for (const [path, data] of arranged.files) {
    const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
    const position = options.positions && PICTURE.test(ext) ? photoPosition(data) : null;
    const kept = await packFile(path, data, place);
    if (!kept || files.has(kept.path)) {
      left.push(path);
      continue;
    }
    files.set(kept.path, kept.data);
    bytes += kept.data.length;
    if (position) {
      const { width = 0, height = 0 } = await openPicture(kept.data, 100_000_000)
        .then((img) => img.metadata())
        .catch(() => ({ width: 0, height: 0 }));
      photos.push({
        file: kept.path,
        lat: Number(position.lat.toFixed(7)),
        lng: Number(position.lng.toFixed(7)),
        ...(position.heading !== undefined ? { heading: Number(position.heading.toFixed(1)) } : {}),
        ...(position.focal35 && width && height
          ? { fov: fieldOfView(position.focal35, width, height) }
          : {}),
        ...(position.altitude !== undefined
          ? { altitude: Number(position.altitude.toFixed(1)) }
          : {}),
        cameraHeight: 1.6,
      });
    }
  }
  if (photos.length) {
    let name = POSITIONS_FILE;
    for (let i = 2; files.has(name); i++) name = `photo-positions-${i}.json`;
    const manifest = Buffer.from(
      `${JSON.stringify(
        {
          about:
            "Where each photo was taken, from the photo's own details (kept because the Architect chose to): latitude and longitude, the compass direction it faces (heading) when the phone recorded one, its lens as a field of view across (fov, degrees) and its altitude (metres above sea level). Photos are taken about 1.6 m up. A photo without a heading needs one before ats space match can use it.",
          photos,
        },
        null,
        2,
      )}\n`,
    );
    files.set(name, manifest);
    bytes += manifest.length;
  }
  if (!files.size)
    throw new PackError(
      'Nothing in it could be added: a place takes pictures and documents about it (PDF, text, JSON…).',
      415,
    );
  return {
    folder: uploadName(arranged.folder).base,
    files,
    left,
    bytes,
    positioned: photos.length,
  };
}

/** A prepared pack as one file to store (pictures as they are; text compressed). */
export function zipPack(files: Map<string, Buffer>): Uint8Array {
  const zippable: Zippable = {};
  for (const [path, data] of files)
    zippable[path] = [data, { level: /\.(jpe?g|png|webp|avif|gif|pdf)$/i.test(path) ? 0 : 6 }];
  return zipSync(zippable);
}

/** A stored pack's files (made by `zipPack`, so trusted to be what it says). */
export const unzipStored = (zip: Uint8Array) =>
  new Map(Object.entries(unzipSync(zip)).filter(([path]) => !path.endsWith('/')));
