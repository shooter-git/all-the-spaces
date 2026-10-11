import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../src/space-cli.ts', import.meta.url));
const kit = fileURLToPath(new URL('../../../tools/dev/onboarding-kit/building/', import.meta.url));

// Each step starts Node and draws real images: give them time on a busy machine.
describe('ats-space on a building with several floors', { timeout: 30_000 }, () => {
  let dir = '';
  const ats = (...args: string[]) =>
    run(process.execPath, ['--experimental-strip-types', cli, '--dir', dir, ...args]);

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ats-space-cli-'));
    await mkdir(join(dir, 'inputs'));
    await copyFile(join(kit, 'plan-1-ground-floor.jpg'), join(dir, 'inputs/plan-1.jpg'));
    await copyFile(join(kit, 'plan-3-top-floor.jpg'), join(dir, 'inputs/plan-3.jpg'));
    // What a new workspace starts with: one placeholder floor, nothing else yet.
    await writeFile(
      join(dir, 'plan.json'),
      JSON.stringify({
        name: 'Building',
        spaceType: 'building',
        floors: [{ key: 'f1', name: 'Building', elevation: 0, height: 2.6 }],
        rooms: [],
        openings: [],
        furniture: [],
        spawns: [],
      }),
    );
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('calibrates each floor’s drawing before the plan has that floor', async () => {
    for (const [floor, image] of [
      ['ground', 'inputs/plan-1.jpg'],
      ['top', 'inputs/plan-3.jpg'],
    ] as const) {
      const scaled = await ats('scale', '90,90', '282,90', '3', '--image', image, '--floor', floor);
      expect(scaled.stdout).toContain(`${floor}: 64.0 pixels per metre`);
      expect(scaled.stdout).toContain(`no floor "${floor}" yet`);
      await ats('origin', '90,90', '--floor', floor);
    }
    const trace = JSON.parse(await readFile(join(dir, 'trace.json'), 'utf8'));
    expect(Object.keys(trace.floors)).toEqual(['ground', 'top']);
    expect(trace.floors.top).toEqual({
      image: 'inputs/plan-3.jpg',
      metresPerPixel: 3 / 192,
      origin: [90, 90],
    });
    await expect(ats('origin', '1,1', '--floor', '../x')).rejects.toThrow(/isn't a floor key/);
  });

  it('draws every floor of the plan over its own drawing', async () => {
    await copyFile(join(kit, 'truth.json'), join(dir, 'plan.json'));
    const { stdout } = await ats('overlay');
    expect(stdout).toContain('overlay-ground.png (Ground floor) over inputs/plan-1.jpg');
    expect(stdout).toContain('overlay-first.png (First floor): no calibration');
    expect(stdout).toContain('overlay-top.png (Top floor) over inputs/plan-3.jpg');
    for (const f of ['overlay.png', 'overlay-ground.png', 'overlay-first.png', 'overlay-top.png'])
      expect((await stat(join(dir, 'preview', f))).size).toBeGreaterThan(1000);
  });
});

describe('ats-space from the outside in', { timeout: 30_000 }, () => {
  let dir = '';
  const ats = (...args: string[]) =>
    run(process.execPath, ['--experimental-strip-types', cli, '--dir', dir, ...args]);
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ats-space-outside-'));
    await copyFile(join(kit, 'plan-1-ground-floor.jpg'), join(dir, 'aerial.jpg'));
    await writeFile(
      join(dir, 'plan.json'),
      JSON.stringify({ name: 'Shop', spaceType: 'building', floors: [], rooms: [], spawns: [] }),
    );
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('turns an aerial view straight, and says the bearing and where its pixels land', async () => {
    const { stdout } = await ats('straighten', 'aerial.jpg', '-20', '--mark', '10,10');
    expect(stdout).toContain('faces a compass bearing of 20.0°');
    const turned = await readFile(join(dir, 'preview/plan-aerial.png'));
    expect(turned.length).toBeGreaterThan(0);
    // The marked corner pixel, turned 20° anticlockwise about the middle of the picture.
    const sharp = (await import('sharp')).default;
    const before = await sharp(join(dir, 'aerial.jpg')).metadata();
    const after = await sharp(turned).metadata();
    const a = (-20 * Math.PI) / 180;
    const [dx, dy] = [10 - (before.width ?? 0) / 2, 10 - (before.height ?? 0) / 2];
    const x = Math.round(dx * Math.cos(a) - dy * Math.sin(a) + (after.width ?? 0) / 2);
    const y = Math.round(dx * Math.sin(a) + dy * Math.cos(a) + (after.height ?? 0) / 2);
    expect(stdout).toContain(`Pixel 10,10 of aerial.jpg is at ${x},${y}`);
  });

  it('puts the plan on the map from a point of it, south of the equator and west too', async () => {
    await ats('site', '-33.8568,151.2153', '--plan', '10,0', '--bearing', '-30');
    const { site } = JSON.parse(await readFile(join(dir, 'plan.json'), 'utf8'));
    expect(site.bearing).toBe(-30);
    const { planPoint } = await import('@ats/space-format');
    const [x, z] = planPoint(site, -33.8568, 151.2153);
    expect(x).toBeCloseTo(10, 1);
    expect(z).toBeCloseTo(0, 1);
  });
});
