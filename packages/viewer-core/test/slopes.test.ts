import { readFileSync } from 'node:fs';
import { buildSpace } from '@ats/space-builder';
import { LoadingManager } from 'three';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';
import { CollisionWorld, PlayerController } from '../src/physics.ts';
import { RoomStreamer } from '../src/streamer.ts';

const BASE = 'http://space.test/';
// three's file loader reports progress with the browser's ProgressEvent.
globalThis.ProgressEvent ??= class extends Event {} as unknown as typeof ProgressEvent;

/** The sample with open decks, a ramp and a sloping street, built and loaded as a viewer would. */
async function loaded() {
  const plan = JSON.parse(
    readFileSync(new URL('../../../samples/sloping-site/plan.json', import.meta.url), 'utf8'),
  );
  const { manifest, files } = await buildSpace(plan);
  // The built files, served from memory.
  const manager = new LoadingManager();
  manager.setURLModifier((url) => {
    const bytes = files.get(url.replace(BASE, ''));
    return bytes
      ? `data:application/octet-stream;base64,${Buffer.from(bytes).toString('base64')}`
      : url;
  });
  const gltf = new GLTFLoader(manager).setMeshoptDecoder(MeshoptDecoder);
  const loader = {
    loadAsync: async (url: string) => {
      const bytes = files.get(url.replace(BASE, ''));
      if (!bytes) throw new Error(`no ${url}`);
      return gltf.parseAsync(Buffer.from(bytes).toString('utf8'), `${BASE}chunks/`);
    },
  };
  const world = new CollisionWorld();
  const streamer = new RoomStreamer(manifest, BASE, world, { loader: loader as never });
  streamer.focus(manifest.spawns[0]?.roomKey as string);
  for (let i = 0; i < 500 && streamer.progress() < 1; i++)
    await new Promise((r) => setTimeout(r, 10));
  return { manifest, world, streamer };
}

describe('a place on a slope', () => {
  it('can be walked from the street, up the ramp, onto the upper deck', async () => {
    const { manifest, world, streamer } = await loaded();
    expect(streamer.progress()).toBe(1);
    const player = new PlayerController();
    const spawn = manifest.spawns[0];
    // The street slopes: people start on it, not under or above it.
    expect(spawn?.position[1]).toBeCloseTo(0.5, 2);
    player.teleport([22.5, (spawn?.position[1] ?? 0) + 0.2, 29], 0);
    /** Walks forward (facing `yaw`: 0 is north, -π/2 east, π/2 west) until `done`. */
    const walk = (yaw: number, done: () => boolean) => {
      player.teleport([player.position.x, player.position.y + 0.02, player.position.z], yaw);
      for (let t = 0; t < 30 && !done(); t += 1 / 60)
        player.update(1 / 60, { x: 0, z: 1, run: false }, world);
      expect(done()).toBe(true);
    };
    walk(0, () => player.position.z < 22); // north, off the street into the lower deck
    expect(player.position.y).toBeCloseTo(0, 1);
    walk(-Math.PI / 2, () => player.position.x > 44); // east, into the turn
    walk(0, () => player.position.z < 2); // north, up the ramp onto the landing
    expect(player.position.y).toBeCloseTo(3, 1);
    walk(Math.PI / 2, () => player.position.x < 36); // west, onto the upper deck
    expect(player.position.y).toBeCloseTo(3, 1);
    expect(player.onGround).toBe(true);
    streamer.dispose();
  });

  it('stands people at the floor’s height where they are, and doorways where floors meet', async () => {
    const plan = JSON.parse(
      readFileSync(new URL('../../../samples/sloping-site/plan.json', import.meta.url), 'utf8'),
    );
    const { manifest } = await buildSpace(plan);
    const room = (key: string) => manifest.rooms.find((r) => r.key === key);
    // The bench on the street, 8 m of its 10 m up a 1 m slope.
    expect(room('street')?.objects.find((o) => o.key === 'bench')?.position[1]).toBeCloseTo(0.8);
    // The ramp's top doorway is at the upper deck's height, its bottom one at the lower deck's.
    const ramp = room('ramp');
    expect(ramp?.doorways.find((d) => d.to === 'landing')?.position[1]).toBeCloseTo(3);
    expect(ramp?.doorways.find((d) => d.to === 'turn')?.position[1]).toBeCloseTo(0);
    // Its bounds reach up to the deck it climbs to (so people on it are in it).
    expect(ramp?.bounds.max[1]).toBeGreaterThanOrEqual(6);
    // Structure is part of the building: nothing to pick out on the decks but the pay machine.
    expect(room('lower-deck')?.objects.map((o) => o.key)).toEqual(['pay-machine']);
    expect(room('upper-deck')?.objects).toEqual([]);
  });
});
