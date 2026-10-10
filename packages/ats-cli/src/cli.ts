#!/usr/bin/env node
/**
 * ats — the All the Spaces command inside a creation's workspace.
 *
 *   ats qa                      check the creation the way publishing will (writes qa-output/)
 *   ats assets search <words>   find free (CC0) models, textures and skies
 *   ats assets add <id>         download one into public/assets/ and record its licence
 *   ats model …                 make 3D models with Blender (see `ats model help`)
 *   ats help
 */
import { spawn } from 'node:child_process';
import { access, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { type AssetType, add, search } from './polyhaven.ts';

// `ats space …` and `ats model …` pass everything through to their tools as it is.
const passThrough = ['space', 'model'].includes(process.argv[2] ?? '')
  ? process.argv.slice(3)
  : null;
const { positionals, values } = parseArgs({
  args: passThrough ? [process.argv[2] as string] : process.argv.slice(2),
  allowPositionals: true,
  options: {
    type: { type: 'string' },
    res: { type: 'string', default: '1k' },
    seconds: { type: 'string' },
    screen: { type: 'string' },
    dir: { type: 'string', default: process.cwd() },
  },
});
const [command, sub, ...rest] = positionals;
const dir = values.dir as string;

const HELP = `ats — for building a creation in All the Spaces

  ats qa                      Check the creation the way publishing will: a clean build, then
                              it's played on a phone (upright and on its side), a tablet and a
                              laptop. Prints what to fix; the full report is qa-output/report.html
                              (screenshots too). Options: --seconds 4, --screen desktop
  ats space check             (space workspaces) Is plan.json sound? Fits, doors on shared
                              walls, every room reachable.
  ats space overlay           Draw plan.json over the floor plan: preview/overlay.png
  ats space scale X1,Y1 X2,Y2 METRES --image inputs/plan-1.jpg
                              Calibrate: two points on the image a known distance apart.
  ats space origin X,Y        The pixel on the image where the plan's x = 0, z = 0 sits.
  ats space render <room>     Draw a room (with its furniture and models) as you'd see it
                              from two opposite corners at eye height: preview/rooms/.
                              Compare with the photos. Options: --corners 1,2,3,4, --quick
                              (a fast plain look), --samples 128 (less grain, slower)
  ats model build <script.py> Make a 3D model with Blender: run a Blender Python script that
                              exports a .glb, check it, and draw it from four sides
                              (preview/models/). See \`ats model help\`.
  ats model preview <file.glb>   Draw any model from four sides.
  ats model check             Check models the way building the place will.
  ats assets search <words>   Find free (CC0) models, textures and skies on Poly Haven.
                              Option: --type models|textures|hdris
  ats assets add <id>         Download one into public/assets/ (a model as one .glb; in a
                              place's workspace, into models/) and record its licence in
                              assets.lock.json. Option: --res 1k|2k (1k suits phones)
`;

async function main() {
  if (command === 'qa') {
    const qa = process.env.ATS_QA_CLI;
    if (!qa) throw new Error('The checks are only available inside an All the Spaces workspace.');
    const args = ['check', dir, join(dir, 'qa-output')];
    if (values.seconds) args.push('--seconds', values.seconds);
    if (values.screen) args.push('--viewports', values.screen);
    const child = spawn(process.execPath, [qa, ...args], { stdio: 'inherit' });
    process.exitCode = await new Promise<number>((r) => child.on('close', (code) => r(code ?? 1)));
  } else if (command === 'space' || command === 'model') {
    const spaceTool = process.env.ATS_SPACE_CLI;
    if (!spaceTool)
      throw new Error('These tools are only available inside an All the Spaces workspace.');
    const tool = command === 'space' ? spaceTool : join(dirname(spaceTool), 'model-cli.ts');
    const child = spawn(process.execPath, [tool, ...(passThrough ?? []), '--dir', dir], {
      stdio: 'inherit',
    });
    process.exitCode = await new Promise<number>((r) => child.on('close', (code) => r(code ?? 1)));
  } else if (command === 'assets' && sub === 'search') {
    const words = rest.join(' ');
    const found = await search(words, values.type as AssetType | undefined);
    if (!found.length) console.log(`Nothing found for "${words}".`);
    for (const f of found)
      console.log(
        `${f.id.padEnd(28)} ${f.type.padEnd(9)} ${f.name}${f.categories.length ? `  (${f.categories.slice(0, 3).join(', ')})` : ''}`,
      );
    if (found.length)
      console.log('\nAdd one with: ats assets add <id>   (all CC0: free to use, no credit needed)');
  } else if (command === 'assets' && sub === 'add' && rest[0]) {
    // A place keeps its models in models/ (where its plan points to them).
    const place = await access(join(dir, 'plan.json')).then(
      () => true,
      () => false,
    );
    const result = await add(dir, rest[0], values.res as string, place ? 'models' : undefined);
    const lockPath = join(dir, 'assets.lock.json');
    let lock: { assets: Record<string, unknown>[]; [k: string]: unknown } = { assets: [] };
    try {
      lock = JSON.parse(await readFile(lockPath, 'utf8'));
    } catch {}
    lock.assets = [
      ...(lock.assets ?? []).filter((a) => !result.files.includes(String(a.path))),
      ...result.files.map((path) => ({ path, ...result.credit })),
    ];
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    console.log(`Added ${result.credit.title} (${result.type}):`);
    for (const f of result.files) console.log(`  ${f}`);
    console.log(
      place && result.type === 'models'
        ? `Recorded in assets.lock.json. Use it in plan.json as "model": "${result.files[0]}" (or "polyhaven:${rest[0]}").`
        : 'Recorded in assets.lock.json. Load it by relative path, e.g. ./assets/…',
    );
  } else {
    console.log(HELP);
    if (command && command !== 'help') process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exitCode = 1;
});
