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
 * `scale` and `origin` take --image (the floor's drawing) and --floor (its key in plan.json; the
 * first floor if left out). Each floor is calibrated on its own, in trace.json.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { PolyHaven } from '@ats/assets';
import { checkPlan, SpacePlan } from '@ats/space-format';
import sharp from 'sharp';
import { previewRoom } from './build.ts';
import { DEFAULT_HDRI } from './catalog.ts';
import { denoise, runBlender } from './model-cli.ts';
import { checkModels, modelPaths } from './models.ts';
import { renderOverlay, scaleFrom, Traces, traceFor } from './trace.ts';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    image: { type: 'string' },
    floor: { type: 'string' },
    quick: { type: 'boolean', default: false },
    samples: { type: 'string' },
    corners: { type: 'string', default: '1,2' },
    dir: { type: 'string', default: process.cwd() },
  },
});
const dir = values.dir as string;
const [command, ...args] = positionals;
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
    const key = args[0];
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
      const [a, b, metres] = args;
      trace.metresPerPixel = scaleFrom(point(a), point(b), Number(metres));
      console.log(
        `${floor}: ${(1 / trace.metresPerPixel).toFixed(1)} pixels per metre. Saved in trace.json.`,
      );
    } else {
      trace.origin = point(args[0]);
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
  } else {
    console.log(
      'Usage: ats-space check | overlay | render ROOM [--corners 1,2,3,4] [--quick] [--samples N] | scale X1,Y1 X2,Y2 METRES [--image FILE] [--floor KEY] | origin X,Y [--image FILE] [--floor KEY]',
    );
    process.exitCode = 2;
  }
}
main().catch((err) => {
  console.error((err as Error).message);
  process.exitCode = 1;
});
