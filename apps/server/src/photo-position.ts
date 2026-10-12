/**
 * Where a photo was taken, from its own details (EXIF), for matching a model against it: its
 * latitude and longitude, the compass direction it faces, its altitude, and how wide its lens is.
 * Read only when the Architect chose to keep it; everything else in the details is ignored, and
 * the picture itself is still saved without any of them.
 */
export interface PhotoPosition {
  lat: number;
  lng: number;
  /** Compass degrees (0 north, 90 east), when the phone recorded it. */
  heading?: number;
  /** Metres above sea level. */
  altitude?: number;
  /** The lens as a 35 mm camera's focal length (for the field of view). */
  focal35?: number;
}

/** The first EXIF block in a JPEG, HEIC or WebP file: "Exif\0\0" followed by a TIFF header. */
function tiffIn(file: Buffer): Buffer | null {
  for (let at = file.indexOf('Exif\0\0'); at >= 0; at = file.indexOf('Exif\0\0', at + 1)) {
    const tiff = file.subarray(at + 6);
    const head = tiff.subarray(0, 4).toString('latin1');
    if (head === 'II*\0' || head === 'MM\0*') return tiff;
  }
  return null;
}

/** A photo's position, or null when it has none (or its details can't be read). */
export function photoPosition(file: Buffer): PhotoPosition | null {
  const tiff = tiffIn(file);
  if (!tiff || tiff.length < 8) return null;
  const little = tiff[0] === 0x49;
  const u16 = (o: number) => (little ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
  const u32 = (o: number) => (little ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
  const SIZES: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
  /** One directory's entries: tag → where its values are, their type and how many. */
  const entries = (offset: number) => {
    const out = new Map<number, { type: number; count: number; at: number }>();
    if (offset + 2 > tiff.length) return out;
    const n = u16(offset);
    for (let i = 0; i < n; i++) {
      const e = offset + 2 + i * 12;
      if (e + 12 > tiff.length) break;
      const type = u16(e + 2);
      const count = u32(e + 4);
      const size = (SIZES[type] ?? 1) * count;
      const at = size <= 4 ? e + 8 : u32(e + 8);
      if (at + size <= tiff.length) out.set(u16(e), { type, count, at });
    }
    return out;
  };
  const rational = (at: number) => {
    const d = u32(at + 4);
    return d ? u32(at) / d : Number.NaN;
  };
  try {
    const ifd0 = entries(u32(4));
    const gpsAt = ifd0.get(0x8825);
    if (!gpsAt) return null;
    const gps = entries(u32(gpsAt.at));
    const ascii = (tag: number) => {
      const e = gps.get(tag);
      return e ? String.fromCharCode(tiff[e.at] ?? 0) : '';
    };
    const degrees = (tag: number) => {
      const e = gps.get(tag);
      if (e?.type !== 5 || e.count < 3) return Number.NaN;
      return rational(e.at) + rational(e.at + 8) / 60 + rational(e.at + 16) / 3600;
    };
    let lat = degrees(0x0002);
    let lng = degrees(0x0004);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) return null;
    if (ascii(0x0001) === 'S') lat = -lat;
    if (ascii(0x0003) === 'W') lng = -lng;
    const out: PhotoPosition = { lat, lng };
    const direction = gps.get(0x0011);
    if (direction?.type === 5) {
      const h = rational(direction.at);
      if (Number.isFinite(h)) out.heading = ((h % 360) + 360) % 360;
    }
    const altitude = gps.get(0x0006);
    if (altitude?.type === 5) {
      const a = rational(altitude.at);
      const below = gps.get(0x0005);
      if (Number.isFinite(a)) out.altitude = below && tiff[below.at] === 1 ? -a : a;
    }
    const exifAt = ifd0.get(0x8769);
    const focal = exifAt ? entries(u32(exifAt.at)).get(0xa405) : undefined;
    if (focal?.type === 3 && u16(focal.at) > 0) out.focal35 = u16(focal.at);
    return out;
  } catch {
    return null;
  }
}

/**
 * The horizontal field of view (degrees) of a lens given as a 35 mm camera's focal length, for a
 * picture `width` by `height` (landscape: the frame's 36 mm side across; portrait: its 24 mm).
 */
export const fieldOfView = (focal35: number, width: number, height: number) =>
  Number(((2 * Math.atan((width >= height ? 18 : 12) / focal35) * 180) / Math.PI).toFixed(1));
