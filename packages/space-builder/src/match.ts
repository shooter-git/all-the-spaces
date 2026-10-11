import {
  type PlanSite,
  planDirection,
  planPoint,
  type SpacePlan,
  slopeAt,
} from '@ats/space-format';
import sharp from 'sharp';
import type { V3 } from './geometry.ts';

/**
 * Photos of a real place taken from known spots (street views, a survey, someone's own photos
 * with their positions), as cameras in its plan, so the model can be drawn from the same spots and
 * set beside them (`ats space match`).
 */
export interface Shot {
  /** The photo, as the manifest names it (relative to the manifest's folder). */
  file: string;
  /** Where it was taken: latitude and longitude, or a point in the plan. */
  lat?: number;
  lng?: number;
  at?: [number, number];
  /** Compass heading (degrees: 0 north, 90 east) and pitch (degrees up from the horizon). */
  heading: number;
  pitch: number;
  /** Horizontal field of view in degrees, or the vertical one (converted with the photo's shape). */
  fov?: number;
  vfov?: number;
  /** Metres above the ground where it was taken. */
  cameraHeight: number;
}

/** A street-view camera's height, and a lens most photos are close to, when a manifest doesn't say. */
export const DEFAULTS = { cameraHeight: 2.5, fov: 75 };

const num = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v)
    ? v
    : typeof v === 'string' && v.trim() && Number.isFinite(Number(v))
      ? Number(v)
      : undefined;

/**
 * The shots a manifest describes, whatever it calls them: a list at its top, or under `images`,
 * `photos`, `pictures` or `shots`; each with its file (`file`, `filename`, `path` or `image`),
 * where (`lat` and `lng`/`lon`, or `at`: [x, z] in the plan), `heading`, and optionally `pitch`,
 * `fov` (or `hfov`), `vfov` and `cameraHeight`. Entries it can't place (an aerial, a document)
 * are listed in `skipped` with the reason.
 */
export function shotsFrom(manifest: unknown): { shots: Shot[]; skipped: string[] } {
  const m = manifest as Record<string, unknown> | unknown[];
  const list = Array.isArray(m)
    ? m
    : (['images', 'photos', 'pictures', 'shots']
        .map((k) => (m as Record<string, unknown>)?.[k])
        .find(Array.isArray) ?? []);
  const shots: Shot[] = [];
  const skipped: string[] = [];
  for (const raw of list as unknown[]) {
    const e = (raw ?? {}) as Record<string, unknown>;
    const file = [e.file, e.filename, e.path, e.image].find((v) => typeof v === 'string') as
      | string
      | undefined;
    if (!file) continue;
    const heading = num(e.heading);
    const lat = num(e.lat ?? e.latitude);
    const lng = num(e.lng ?? e.lon ?? e.longitude);
    const at =
      Array.isArray(e.at) && e.at.length === 2 && e.at.every((v) => num(v) !== undefined)
        ? ([num(e.at[0]), num(e.at[1])] as [number, number])
        : undefined;
    if (heading === undefined) {
      skipped.push(`${file}: no heading (which way it looks)`);
      continue;
    }
    if (!at && (lat === undefined || lng === undefined)) {
      skipped.push(`${file}: no position (lat and lng, or at)`);
      continue;
    }
    const fov = num(e.fov ?? e.hfov);
    const vfov = num(e.vfov);
    shots.push({
      file,
      ...(at ? { at } : { lat: lat as number, lng: lng as number }),
      heading,
      pitch: num(e.pitch) ?? 0,
      ...(fov !== undefined ? { fov } : {}),
      ...(vfov !== undefined ? { vfov } : {}),
      cameraHeight: num(e.cameraHeight ?? e.camera_height) ?? DEFAULTS.cameraHeight,
    });
  }
  return { shots, skipped };
}

/**
 * The height of the ground (or floor) under a point: the lowest walking surface of the rooms it's
 * in, or of the nearest outdoor room (a street, a pavement) when it's in none.
 */
export function groundAt(plan: SpacePlan, x: number, z: number): number {
  const floors = new Map(plan.floors.map((f) => [f.key, f.elevation]));
  const height = (r: SpacePlan['rooms'][number], px: number, pz: number) =>
    (floors.get(r.floor) ?? 0) + slopeAt(r, px, pz);
  const under = plan.rooms.filter(
    (r) => x >= r.rect[0] && x <= r.rect[2] && z >= r.rect[1] && z <= r.rect[3],
  );
  if (under.length) return Math.min(...under.map((r) => height(r, x, z)));
  let best: { d: number; h: number } | null = null;
  for (const r of plan.rooms) {
    if (!r.outdoor) continue;
    const cx = Math.min(Math.max(x, r.rect[0]), r.rect[2]);
    const cz = Math.min(Math.max(z, r.rect[1]), r.rect[3]);
    const d = Math.hypot(x - cx, z - cz);
    if (!best || d < best.d) best = { d, h: height(r, cx, cz) };
  }
  return best?.h ?? Math.min(...plan.floors.map((f) => f.elevation));
}

/** Where a shot's camera is in the plan and what it looks at, and its horizontal field of view. */
export function cameraFor(
  plan: SpacePlan,
  site: PlanSite | undefined,
  shot: Shot,
  aspect: number,
): { position: V3; target: V3; fov: number; at: [number, number] } {
  let at = shot.at;
  if (!at) {
    if (!site)
      throw new Error(
        `To place ${shot.file} by latitude and longitude, plan.json needs a "site" (ats space site).`,
      );
    at = planPoint(site, shot.lat as number, shot.lng as number);
  }
  const [dx, dz] = planDirection(site ?? { bearing: 0 }, shot.heading);
  const p = (shot.pitch * Math.PI) / 180;
  const y = groundAt(plan, at[0], at[1]) + shot.cameraHeight;
  const position: V3 = [at[0], y, at[1]];
  const target: V3 = [
    at[0] + dx * Math.cos(p) * 10,
    y + Math.sin(p) * 10,
    at[1] + dz * Math.cos(p) * 10,
  ];
  const fov =
    shot.fov ??
    (shot.vfov !== undefined
      ? (2 * Math.atan(Math.tan((shot.vfov * Math.PI) / 360) * aspect) * 180) / Math.PI
      : DEFAULTS.fov);
  return { position, target, fov, at };
}

/**
 * The photo, the drawing from the same spot, and the two laid over each other, side by side and
 * labelled: what to compare to see what's off.
 */
export async function sideBySide(photo: Uint8Array, render: Uint8Array, title: string) {
  const width = 640;
  const { data: photoPng, info } = await sharp(photo)
    .rotate()
    .resize({ width })
    .removeAlpha()
    .png()
    .toBuffer({ resolveWithObject: true });
  const height = info.height;
  const renderPng = await sharp(render)
    .resize({ width, height, fit: 'fill' })
    .removeAlpha()
    .png()
    .toBuffer();
  // Half and half: edges that line up show once, edges that don't show twice.
  const half = await sharp(renderPng).ensureAlpha(0.5).png().toBuffer();
  const blend = await sharp(photoPng)
    .composite([{ input: half }])
    .png()
    .toBuffer();
  const band = 30;
  const gap = 8;
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const label = (text: string, x: number) =>
    `<text x="${x + 6}" y="21" font-family="DejaVu Sans, sans-serif" font-size="15" fill="#1d1d1f">${esc(text)}</text>`;
  const total = width * 3 + gap * 2;
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${band}">${label(`Photo: ${title}`, 0)}${label('The model from the same spot', width + gap)}${label('Both, laid over each other', 2 * (width + gap))}</svg>`,
  );
  return sharp({
    create: { width: total, height: height + band, channels: 3, background: '#f4f1ec' },
  })
    .composite([
      { input: svg, left: 0, top: 0 },
      { input: photoPng, left: 0, top: band },
      { input: renderPng, left: width + gap, top: band },
      { input: blend, left: 2 * (width + gap), top: band },
    ])
    .png()
    .toBuffer();
}
