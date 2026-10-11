#!/usr/bin/env node
/**
 * ats-space: tools for building a real place from its floor plan, used by `ats space …` in a
 * space workspace (run in the workspace folder).
 *
 *   ats-space check                        is plan.json sound? (fits, doors on shared walls, reachable)
 *   ats-space overlay                      draw plan.json over each floor's plan → preview/overlay-<floor>.png
 *   ats-space scale X1,Y1 X2,Y2 METRES     calibrate from two points on the image a known distance apart
 *   ats-space origin X,Y                   the pixel where the plan's x = 0, z = 0 sits
 *   ats-space render ROOM                  draw a room as you'd see it standing in two opposite
 *                                          corners → preview/rooms/<room>-corner-<n>.png
 *
 * Working from the outside in (photos of the outside, an aerial view, no floor plan):
 *
 *   ats-space straighten IMAGE DEGREES     turn an aerial view so the building's walls run straight
 *                                          across and down → preview/plan-<name>.png
 *   ats-space site LAT,LNG                 where the place is on Earth (its plan's origin, or with
 *                                          --plan X,Z / --at PX,PY another point), and --bearing
 *   ats-space match MANIFEST|PHOTO         draw the whole place from where each photo was taken,
 *                                          beside it → preview/match/<photo>.png
 *
 * `scale` and `origin` take --image (the floor's drawing) and --floor (its key in plan.json; the
 * first floor if left out). Each floor is calibrated on its own, in trace.json.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { PolyHaven } from '@ats/assets';
import { checkPlan, earthPoint, PlanSite, SpacePlan } from '@ats/space-format';
import sharp from 'sharp';
import { previewRoom, previewSite } from './build.ts';
import { DEFAULT_HDRI } from './catalog.ts';
import { cameraFor, type Shot, shotsFrom, sideBySide } from './match.ts';
import { denoise, runBlender } from './model-cli.ts';
import { checkModels, modelPaths } from './models.ts';
import { renderOverlay, scaleFrom, Traces, traceFor } from './trace.ts';

const OPTIONS = {
  image: { type: 'string' },
  floor: { type: 'string' },
  quick: { type: 'boolean', default: false },
  samples: { type: 'string' },
  corners: { type: 'string', default: '1,2' },
  // site and match
  plan: { type: 'string' },
  at: { type: 'string' },
  bearing: { type: 'string' },
  heading: { type: 'string' },
  pitch: { type: 'string' },
  fov: { type: 'string' },
  'camera-height': { type: 'string' },
  only: { type: 'string' },
  dir: { type: 'string', default: process.cwd() },
} as const;
/**
 * The arguments, with negative numbers taken as values (a bearing of -22, a pitch of -5, a
 * latitude south of the equator), not as options: each option's value is joined to it, and the
 * rest are positional.
 */
function args(argv: string[]) {
  const options: string[] = [];
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (!a.startsWith('--')) positional.push(a);
    else {
      const name = a.slice(2) as keyof typeof OPTIONS;
      if (OPTIONS[name]?.type === 'string' && i + 1 < argv.length)
        options.push(`${a}=${argv[++i]}`);
      else options.push(a);
    }
  }
  return [...options, '--', ...positional];
}
const { positionals, values } = parseArgs({
  args: args(process.argv.slice(2)),
  allowPositionals: true,
  options: OPTIONS,
});
const dir = values.dir as string;
const [command, ...rest] = positionals;
const point = (s: string | undefined): [number, number] => {
  const m = /^(-?[\d.]+),(-?[\d.]+)$/.exec(s ?? '');
  if (!m) throw new Error(`Expected a point like 120,340 (pixels), got "${s ?? ''}"`);
  return [Number(m[1]), Number(m[2])];
};
const readJson = async (file: string) => JSON.parse(await readFile(join(dir, file), 'utf8'));
const readTraces = async (): Promise<unknown> => {
  try {
    return await readJson('trace.json');
  } catch {
    return null;
  }
};
/** Every floor's calibration, as `{ floors: { key: … } }` (converting an older single one). */
async function allTraces(firstFloor: string) {
  const raw = Traces.safeParse(await readTraces());
  if (!raw.success)
    return {} as Record<
      string,
      { image: string; metresPerPixel: number; origin: [number, number] }
    >;
  if ('floors' in raw.data) return { ...raw.data.floors };
  const { floor, ...one } = raw.data;
  return { [floor ?? firstFloor]: one };
}
const writeTraces = (floors: object) =>
  writeFile(join(dir, 'trace.json'), `${JSON.stringify({ floors }, null, 2)}\n`);

/** The workspace models a plan uses, read from disk, checked the way building the place will. */
async function workspaceModels(plan: SpacePlan) {
  const files = new Map<string, Uint8Array>();
  for (const path of modelPaths(plan))
    try {
      files.set(path, new Uint8Array(await readFile(join(dir, path))));
    } catch {}
  return checkModels(plan, files);
}

async function main() {
  if (command === 'check') {
    const raw = await readJson('plan.json');
    const { plan, problems } = checkPlan(raw);
    const models = plan ? (await workspaceModels(plan as SpacePlan)).problems : [];
    const all = [...problems, ...models.map((m) => ({ level: 'error' as const, ...m, fix: '' }))];
    if (!all.length)
      console.log('plan.json looks sound: everything fits and every room can be reached.');
    for (const p of all)
      console.log(
        `${p.level === 'error' ? 'FIX ' : 'note'}  ${p.message}${p.fix ? `\n      → ${p.fix}` : ''}`,
      );
    process.exitCode = all.some((p) => p.level === 'error') ? 1 : 0;
  } else if (command === 'render') {
    const plan = SpacePlan.parse(await readJson('plan.json'));
    const key = rest[0];
    if (!key)
      throw new Error(
        `Which room? ats space render <room key>. Rooms: ${plan.rooms.map((r) => r.key).join(', ')}`,
      );
    const { models, problems } = await workspaceModels(plan);
    for (const p of problems) console.log(`note  ${p.message} (drawn as a simple shape for now)`);
    const assets = new PolyHaven(
      process.env.ATS_ASSET_CACHE ?? join(homedir(), '.cache', 'ats-assets'),
    );
    const started = Date.now();
    const room = await previewRoom(plan, key, { assets, models });
    const wanted = new Set((values.corners as string).split(',').map((c) => `corner-${c.trim()}`));
    room.cameras = room.cameras.filter((c) => wanted.has(c.name));
    if (!room.cameras.length) throw new Error('Corners are 1 to 4, e.g. --corners 1,2,3,4');
    const hdri = await assets.hdri(DEFAULT_HDRI).then(
      (h) => h.path,
      () => null,
    );
    const tmp = await mkdtemp(join(tmpdir(), 'ats-room-'));
    try {
      await writeFile(join(tmp, 'room.glb'), room.glb);
      await writeFile(
        join(tmp, 'input.json'),
        JSON.stringify({
          cameras: room.cameras,
          lights: room.lights,
          hdri,
          hdriRotation: Math.PI,
          width: 960,
          height: 640,
          samples: Number(values.samples ?? 64),
          engine: values.quick ? 'BLENDER_WORKBENCH' : 'CYCLES',
        }),
      );
      await runBlender(
        fileURLToPath(new URL('../blender/render_room.py', import.meta.url)),
        [join(tmp, 'room.glb'), join(tmp, 'input.json'), tmp],
        dir,
      );
      await mkdir(join(dir, 'preview', 'rooms'), { recursive: true });
      const written: string[] = [];
      for (const cam of room.cameras) {
        const out = join('preview', 'rooms', `${key}-${cam.name}.png`);
        if (!values.quick) await denoise(join(tmp, `${cam.name}.png`));
        await sharp(join(tmp, `${cam.name}.png`))
          .png()
          .toFile(join(dir, out));
        written.push(out);
      }
      console.log(
        `Drew ${room.name} from ${written.length === 1 ? 'a corner' : `${written.length} corners`} at eye height (${room.models} model${room.models === 1 ? '' : 's'}) in ${((Date.now() - started) / 1000).toFixed(0)} s:\n  ${written.join('\n  ')}\nLook at them next to the photos of the room. (--corners 1,2,3,4 for every corner; --quick for a fast plain look; --samples 128 for less grain.)`,
      );
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  } else if (command === 'overlay') {
    const plan = SpacePlan.parse(await readJson('plan.json'));
    const first = plan.floors[0]?.key as string;
    const raw = await readTraces();
    await mkdir(join(dir, 'preview'), { recursive: true });
    for (const floor of plan.floors) {
      const trace = traceFor(raw, floor.key, first);
      const image = trace ? await readFile(join(dir, trace.image)) : null;
      const png = await renderOverlay(plan, { trace, image, floor: floor.key });
      const out = join('preview', `overlay-${floor.key}.png`);
      await writeFile(join(dir, out), png);
      // The first floor is also overlay.png (what a single-floor place shows).
      if (floor.key === first) await writeFile(join(dir, 'preview', 'overlay.png'), png);
      console.log(
        `Drew ${out} (${floor.name})${trace ? ` over ${trace.image}` : ': no calibration for this floor yet, so the plan on its own'}. Look at it and compare.`,
      );
    }
  } else if (command === 'scale' || command === 'origin') {
    // Drawings are usually calibrated before the plan is written, so the plan needn't be
    // complete (or even valid) yet: only its floor keys matter here.
    const keys = await readJson('plan.json').then(
      (p: { floors?: { key?: unknown }[] }) =>
        (p.floors ?? []).map((f) => f.key).filter((k): k is string => typeof k === 'string'),
      () => [] as string[],
    );
    const first = keys[0] ?? 'f1';
    const floor = values.floor ?? first;
    if (!/^[\w-]{1,40}$/.test(floor))
      throw new Error(`"${floor}" isn't a floor key (letters, digits, dashes and underscores).`);
    const floors = await allTraces(first);
    const trace = {
      origin: [0, 0] as [number, number],
      metresPerPixel: 0,
      image: '',
      ...floors[floor],
    };
    trace.image = values.image ?? trace.image;
    if (!trace.image)
      throw new Error(`Which image shows this floor? Add --image inputs/plan-1.jpg`);
    if (command === 'scale') {
      const [a, b, metres] = rest;
      trace.metresPerPixel = scaleFrom(point(a), point(b), Number(metres));
      console.log(
        `${floor}: ${(1 / trace.metresPerPixel).toFixed(1)} pixels per metre. Saved in trace.json.`,
      );
    } else {
      trace.origin = point(rest[0]);
      console.log(
        `${floor}: the plan's origin (x = 0, z = 0) is at pixel ${trace.origin.join(', ')}. Saved in trace.json.`,
      );
    }
    floors[floor] = trace;
    await writeTraces(floors);
    if (!keys.includes(floor))
      console.log(
        `Note: plan.json has no floor "${floor}" yet. Give the floor this key when you add it, so its overlay uses this calibration.`,
      );
  } else if (command === 'straighten') {
    const [image, degrees] = rest;
    const turn = Number(degrees);
    if (!image || !Number.isFinite(turn))
      throw new Error(
        'ats space straighten IMAGE DEGREES (clockwise; negative turns the other way)',
      );
    const out = join(
      'preview',
      `plan-${basename(image, extname(image))
        .replace(/[^\w.-]+/g, '-')
        .slice(0, 60)}.png`,
    );
    await mkdir(join(dir, 'preview'), { recursive: true });
    await sharp(await readFile(join(dir, image)))
      .rotate(turn, { background: '#ffffff' })
      .png()
      .toFile(join(dir, out));
    const bearing = ((-turn % 360) + 360) % 360;
    console.log(
      `Turned ${image} ${turn}° clockwise: ${out}. Calibrate on it (ats space scale … --image ${out}).\nIf ${image} was north-up (as maps and aerial views are), the top of ${out} faces a compass bearing of ${bearing.toFixed(1)}°: that's the site's bearing (ats space site LAT,LNG --bearing ${bearing.toFixed(1)}).`,
    );
  } else if (command === 'site') {
    const [lat, lng] = point(rest[0]);
    const raw = await readJson('plan.json');
    const bearing = Number(values.bearing ?? raw.site?.bearing ?? 0);
    if (!Number.isFinite(bearing))
      throw new Error(`--bearing is in degrees, got "${values.bearing}"`);
    // Which point of the plan is at LAT,LNG: the origin, a point in metres, or a pixel of the
    // calibrated image.
    let xz: [number, number] = [0, 0];
    if (values.plan) xz = point(values.plan);
    else if (values.at) {
      const first = (raw.floors?.[0]?.key as string | undefined) ?? 'f1';
      const trace = traceFor(await readTraces(), values.floor ?? first, first);
      if (!trace?.metresPerPixel)
        throw new Error(
          '--at is a pixel of the calibrated image: run ats space scale and origin first.',
        );
      const [px, py] = point(values.at);
      xz = [
        (px - trace.origin[0]) * trace.metresPerPixel,
        (py - trace.origin[1]) * trace.metresPerPixel,
      ];
    }
    const there = PlanSite.parse({ lat, lng, bearing });
    const [olat, olng] = earthPoint(there, -xz[0], -xz[1]);
    const site = PlanSite.parse({
      lat: Number(olat.toFixed(7)),
      lng: Number(olng.toFixed(7)),
      bearing,
    });
    raw.site = site;
    await writeFile(join(dir, 'plan.json'), `${JSON.stringify(raw, null, 2)}\n`);
    console.log(
      `Saved the site in plan.json: the origin (x = 0, z = 0) is at ${site.lat}, ${site.lng}, and the plan's north faces ${site.bearing}°.${xz[0] || xz[1] ? ` (${lat}, ${lng} is at x = ${xz[0].toFixed(2)}, z = ${xz[1].toFixed(2)}.)` : ''}`,
    );
  } else if (command === 'match') {
    const plan = SpacePlan.parse(await readJson('plan.json'));
    const source = rest[0];
    if (!source)
      throw new Error(
        "ats space match MANIFEST (a pack's manifest.json), or PHOTO --at LAT,LNG|X,Z --heading DEG [--pitch DEG] [--fov DEG] [--camera-height M]",
      );
    let shots: Shot[];
    let folder = '';
    if (source.endsWith('.json')) {
      const found = shotsFrom(await readJson(source));
      folder = dirname(source);
      shots = found.shots;
      for (const s of found.skipped) console.log(`note  skipped ${s}`);
    } else {
      const heading = Number(values.heading);
      if (!values.at || !Number.isFinite(heading))
        throw new Error(
          'A single photo needs --at LAT,LNG (or X,Z with --plan-coordinates) and --heading DEG.',
        );
      const [a, b] = point(values.at);
      const inPlan = Math.abs(a) > 90 || Math.abs(b) > 180 || !plan.site;
      shots = [
        {
          file: source,
          ...(inPlan ? { at: [a, b] as [number, number] } : { lat: a, lng: b }),
          heading,
          pitch: Number(values.pitch ?? 0),
          ...(values.fov ? { fov: Number(values.fov) } : {}),
          cameraHeight: Number(values['camera-height'] ?? 2.5),
        },
      ];
    }
    if (values.only) {
      const wanted = (values.only as string)
        .split(',')
        .map((w) => w.trim())
        .filter(Boolean);
      shots = shots.filter((s, i) =>
        wanted.some((w) => String(i + 1) === w || basename(s.file).includes(w)),
      );
    }
    if (!shots.length) throw new Error('No photos to match (each needs a position and a heading).');
    const { models, problems } = await workspaceModels(plan);
    for (const p of problems) console.log(`note  ${p.message} (drawn as a simple shape for now)`);
    const assets = new PolyHaven(
      process.env.ATS_ASSET_CACHE ?? join(homedir(), '.cache', 'ats-assets'),
    );
    const started = Date.now();
    const site = await previewSite(plan, { assets, models });
    const hdri = await assets.hdri(DEFAULT_HDRI).then(
      (h) => h.path,
      () => null,
    );
    const cameras = [];
    const photos = new Map<string, Buffer>();
    for (const [i, shot] of shots.entries()) {
      const photo = await readFile(join(dir, folder, shot.file));
      const meta = await sharp(photo).rotate().metadata();
      const aspect = (meta.width ?? 4) / (meta.height ?? 3);
      const cam = cameraFor(plan, plan.site, shot, aspect);
      const name = `shot-${i + 1}`;
      photos.set(name, photo);
      cameras.push({
        name,
        file: shot.file,
        position: cam.position,
        target: cam.target,
        fov: cam.fov,
        clipEnd: 2000,
        height: Math.round(960 / aspect),
      });
      console.log(
        `${shot.file}: from x = ${cam.at[0].toFixed(1)}, z = ${cam.at[1].toFixed(1)}, ${cam.position[1].toFixed(1)} m up, looking ${shot.heading}° (pitch ${shot.pitch}°, field of view ${cam.fov.toFixed(0)}°)`,
      );
    }
    const tmp = await mkdtemp(join(tmpdir(), 'ats-match-'));
    try {
      await writeFile(join(tmp, 'site.glb'), site.glb);
      // One render per photo shape (Blender draws every camera at one size).
      const sizes = new Map<number, typeof cameras>();
      for (const c of cameras) sizes.set(c.height, [...(sizes.get(c.height) ?? []), c]);
      for (const [height, group] of sizes) {
        await writeFile(
          join(tmp, 'input.json'),
          JSON.stringify({
            cameras: group,
            lights: [],
            hdri,
            hdriRotation: Math.PI,
            width: 960,
            height,
            samples: Number(values.samples ?? 32),
            engine: values.quick ? 'BLENDER_WORKBENCH' : 'CYCLES',
          }),
        );
        await runBlender(
          fileURLToPath(new URL('../blender/render_room.py', import.meta.url)),
          [join(tmp, 'site.glb'), join(tmp, 'input.json'), tmp],
          dir,
        );
      }
      await mkdir(join(dir, 'preview', 'match'), { recursive: true });
      const written: string[] = [];
      for (const cam of cameras) {
        if (!values.quick) await denoise(join(tmp, `${cam.name}.png`));
        const stem = basename(cam.file, extname(cam.file))
          .replace(/[^\w.-]+/g, '-')
          .slice(0, 70);
        const out = join('preview', 'match', `${stem}.png`);
        await writeFile(
          join(dir, out),
          await sideBySide(
            photos.get(cam.name) as Buffer,
            await readFile(join(tmp, `${cam.name}.png`)),
            basename(cam.file),
          ),
        );
        written.push(out);
      }
      console.log(
        `Drew the place from where ${written.length === 1 ? 'the photo was' : `${written.length} photos were`} taken in ${((Date.now() - started) / 1000).toFixed(0)} s:\n  ${written.join('\n  ')}\nLook at each: the photo, the model from the same spot, and the two laid over each other. Where edges show twice, the model (or the site, or the photo's position) is off. (--quick for a fast plain look; --only 3,7 for some.)`,
      );
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  } else {
    console.log(
      'Usage: ats-space check | overlay | render ROOM [--corners 1,2,3,4] [--quick] [--samples N] | scale X1,Y1 X2,Y2 METRES [--image FILE] [--floor KEY] | origin X,Y [--image FILE] [--floor KEY] | straighten IMAGE DEGREES | site LAT,LNG [--plan X,Z | --at PX,PY] [--bearing DEG] | match MANIFEST|PHOTO [--at …] [--heading DEG] [--pitch DEG] [--fov DEG] [--camera-height M] [--only 1,2] [--quick]',
    );
    process.exitCode = 2;
  }
}
main().catch((err) => {
  console.error((err as Error).message);
  process.exitCode = 1;
});
