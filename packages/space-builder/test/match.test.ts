import { readFileSync } from 'node:fs';
import { SpacePlan } from '@ats/space-format';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { cameraFor, groundAt, shotsFrom, sideBySide } from '../src/match.ts';

const plan = SpacePlan.parse(
  JSON.parse(
    readFileSync(new URL('../../../samples/sloping-site/plan.json', import.meta.url), 'utf8'),
  ),
);

describe('matching photos of a place', () => {
  it('reads a manifest whatever it calls things, and says which photos it can’t place', () => {
    const { shots, skipped } = shotsFrom({
      images: [
        { filename: 'a.jpg', lat: '30.27', lng: -97.75, heading: 270, pitch: 10, width: 1280 },
        { file: 'b.jpg', at: [20, 40], heading: 0, hfov: 60, cameraHeight: 1.6 },
        { path: 'c.jpg', latitude: 30.27, longitude: -97.75, heading: 90, vfov: 50 },
        { filename: 'aerial.jpg', lat: 30.27, lng: -97.75 },
        { filename: 'study.pdf', heading: 10 },
        { note: 'not a photo' },
      ],
    });
    expect(shots).toEqual([
      { file: 'a.jpg', lat: 30.27, lng: -97.75, heading: 270, pitch: 10, cameraHeight: 2.5 },
      { file: 'b.jpg', at: [20, 40], heading: 0, pitch: 0, fov: 60, cameraHeight: 1.6 },
      {
        file: 'c.jpg',
        lat: 30.27,
        lng: -97.75,
        heading: 90,
        pitch: 0,
        vfov: 50,
        cameraHeight: 2.5,
      },
    ]);
    expect(skipped).toEqual([
      'aerial.jpg: no heading (which way it looks)',
      'study.pdf: no position (lat and lng, or at)',
    ]);
    // A plain list works too.
    expect(shotsFrom([{ file: 'd.jpg', at: [0, 0], heading: 0 }]).shots).toHaveLength(1);
  });

  it('stands the camera on the ground where it was, looking where the photo looks', () => {
    // On the sloping street, 8 m up its 10 m: the street is 0.8 m up there.
    expect(groundAt(plan, 20, 32)).toBeCloseTo(0.8);
    // Beyond the street: the nearest outdoor ground (the street's far edge, 1 m up).
    expect(groundAt(plan, 20, 60)).toBeCloseTo(1);
    // Over the ramp and the deck above: the lowest floor there.
    expect(groundAt(plan, 44, 12)).toBeCloseTo(1.5);

    const cam = cameraFor(
      plan,
      undefined,
      { file: 'x.jpg', at: [20, 32], heading: 0, pitch: 0, cameraHeight: 2.5 },
      16 / 9,
    );
    expect(cam.position[1]).toBeCloseTo(3.3);
    // Heading 0 on a north-up plan looks towards -z, level.
    expect(cam.target[0]).toBeCloseTo(20);
    expect(cam.target[2]).toBeLessThan(32);
    expect(cam.target[1]).toBeCloseTo(cam.position[1]);
    expect(cam.fov).toBe(75);
    // A vertical field of view becomes the horizontal one for the photo's shape.
    const wide = cameraFor(
      plan,
      undefined,
      { file: 'x.jpg', at: [0, 30], heading: 90, pitch: 20, vfov: 60, cameraHeight: 2.5 },
      2,
    );
    expect(wide.fov).toBeCloseTo(98.2, 1);
    expect(wide.target[0]).toBeGreaterThan(0);
    expect(wide.target[1]).toBeGreaterThan(wide.position[1]);
    // By latitude and longitude, it needs to know where the place is.
    expect(() =>
      cameraFor(
        plan,
        undefined,
        { file: 'x.jpg', lat: 1, lng: 2, heading: 0, pitch: 0, cameraHeight: 2.5 },
        1,
      ),
    ).toThrow(/needs a "site"/);
  });

  it('sets the photo, the drawing and both together side by side', async () => {
    const photo = await sharp({
      create: { width: 1280, height: 720, channels: 3, background: '#808080' },
    })
      .jpeg()
      .toBuffer();
    const render = await sharp({
      create: { width: 960, height: 540, channels: 4, background: '#204060ff' },
    })
      .png()
      .toBuffer();
    const meta = await sharp(await sideBySide(photo, render, 'a.jpg')).metadata();
    expect([meta.width, meta.height]).toEqual([640 * 3 + 16, 360 + 30]);
  });
});
