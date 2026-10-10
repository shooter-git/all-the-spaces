import { BoxGeometry, type BufferGeometry } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { describe, expect, it } from 'vitest';
import { CollisionWorld, PlayerController } from '../src/physics.ts';

const box = (w: number, h: number, d: number, x: number, y: number, z: number): BufferGeometry =>
  new BoxGeometry(w, h, d).translate(x, y, z).toNonIndexed();

function simulate(
  player: PlayerController,
  world: CollisionWorld,
  seconds: number,
  move = { x: 0, z: 1, run: false },
) {
  for (let t = 0; t < seconds; t += 1 / 60) player.update(1 / 60, move, world);
}

describe('walking', () => {
  it('lands on the floor and stays there', () => {
    const world = new CollisionWorld();
    world.add('room', box(10, 0.2, 10, 0, -0.1, 0));
    const p = new PlayerController();
    p.teleport([0, 2, 0]);
    simulate(p, world, 2, { x: 0, z: 0, run: false });
    expect(p.position.y).toBeGreaterThan(-0.05);
    expect(p.position.y).toBeLessThan(0.1);
    expect(p.onGround).toBe(true);
  });

  it('stops at a wall and slides along it', () => {
    const world = new CollisionWorld();
    world.add(
      'room',
      mergeGeometries([box(10, 0.2, 10, 0, -0.1, 0), box(10, 3, 0.15, 0, 1.5, -3)]),
    );
    const p = new PlayerController();
    p.teleport([0, 0, 0], 0); // facing -Z, towards the wall
    simulate(p, world, 4);
    expect(p.position.z).toBeGreaterThan(-3 + 0.075);
    expect(p.position.z).toBeLessThan(-2.5);
    // Walking diagonally into the wall slides sideways along it.
    const x0 = p.position.x;
    simulate(p, world, 1, { x: 1, z: 1, run: false });
    expect(p.position.x - x0).toBeGreaterThan(0.5);
    expect(p.position.z).toBeGreaterThan(-3 + 0.075);
  });

  it('climbs a staircase ramp to the next floor and walks back down', () => {
    // A 41° ramp rising 3.3 m over 3.8 m towards -Z, then an upper landing.
    const rise = 3.3;
    const run = 3.8;
    const angle = Math.atan2(rise, run);
    const length = Math.hypot(rise, run);
    const ramp = new BoxGeometry(1.2, 0.05, length).rotateX(angle).translate(0, rise / 2, -run / 2);
    const world = new CollisionWorld();
    world.add(
      'stairs',
      mergeGeometries([
        box(4, 0.2, 4, 0, -0.1, 1.5),
        ramp.toNonIndexed(),
        box(4, 0.2, 3, 0, rise - 0.1, -run - 1.5),
      ]),
    );
    const p = new PlayerController();
    p.teleport([0, 0, 1], 0);
    simulate(p, world, 6);
    expect(p.position.y).toBeGreaterThan(rise - 0.1);
    // Turn around and walk down without flying off the ramp.
    p.yaw = Math.PI;
    let airborne = 0;
    // Walk down until back on the ground floor (the test floor ends at z = 3.5).
    for (let t = 0; t < 6 && p.position.z < 1; t += 1 / 60) {
      p.update(1 / 60, { x: 0, z: 1, run: false }, world);
      if (!p.onGround) airborne++;
    }
    expect(p.position.y).toBeLessThan(0.1);
    expect(p.position.z).toBeGreaterThanOrEqual(1);
    expect(airborne).toBeLessThan(5); // hugs the ramp all the way down
  });

  it('puts you back where you last stood if a floor isn’t there, instead of falling forever', () => {
    const world = new CollisionWorld();
    world.add('hall', box(4, 0.2, 4, 0, -0.1, 0));
    const p = new PlayerController();
    p.teleport([0, 0, 0], 0); // facing -Z: the hall ends at z = -2, the office beyond isn't there
    simulate(p, world, 0.5);
    expect(p.onGround).toBe(true);
    const caught = p.recoveries;
    // Walk out over the missing floor and keep going.
    simulate(p, world, 3);
    expect(p.recoveries).toBeGreaterThan(caught);
    // Back standing on the hall's floor once you stop (not teetering on its edge).
    simulate(p, world, 2, { x: 0, z: 0, run: false });
    expect(p.onGround).toBe(true);
    expect(Math.abs(p.position.y)).toBeLessThan(0.1);
    expect(p.position.z).toBeGreaterThan(-2);
    // Once the office's floor is there, you walk into it like any other.
    world.add('office', box(4, 0.2, 6, 0, -0.1, -5));
    const before = p.recoveries;
    simulate(p, world, 1.5);
    expect(p.recoveries).toBe(before);
    expect(p.position.z).toBeLessThan(-3);
    expect(Math.abs(p.position.y)).toBeLessThan(0.1);
  });
});
