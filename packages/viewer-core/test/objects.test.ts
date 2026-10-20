import {
  BoxGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  SphereGeometry,
} from 'three';
import { describe, expect, it } from 'vitest';
import { RoomObjects } from '../src/objects.ts';
import { freeze } from '../src/streamer.ts';

const rect = { left: 0, top: 0, width: 200, height: 100 } as DOMRect;

/** A room with an object straight ahead of the camera, and dense shapes near and far. */
function scene() {
  const root = new Group();
  const room = new Group();
  const chair = new Mesh(new BoxGeometry(0.5, 0.5, 0.5), new MeshStandardMaterial());
  chair.position.set(0, 0, -2);
  chair.userData.objectKey = 'chair';
  // A dense shape (a sculpture) within reach, off to one side.
  const near = new Mesh(new SphereGeometry(0.3, 64, 64), new MeshStandardMaterial());
  near.position.set(1.5, 0, -1);
  room.add(chair, near);
  // Another room, far away along the same line of sight.
  const away = new Group();
  const far = new Mesh(new SphereGeometry(0.3, 64, 64), new MeshStandardMaterial());
  far.position.set(0, 0, -60);
  far.userData.objectKey = 'statue';
  away.add(far);
  root.add(room, away);
  freeze(room);
  freeze(away);
  const camera = new PerspectiveCamera(60, 2, 0.05, 200);
  camera.updateMatrixWorld();
  return { root, chair, near, far, camera };
}

describe('pointing at things', () => {
  it('finds the object in the middle of the view', () => {
    const { root, camera } = scene();
    const objects = new RoomObjects(root, false);
    expect(objects.pick(camera, 100, 50, rect)).toBe('chair');
  });

  it('only tests shapes within reach, and gives the dense ones a bounds tree', () => {
    const { root, near, far, camera } = scene();
    const objects = new RoomObjects(root, false);
    objects.pick(camera, 100, 50, rect);
    expect(near.geometry.boundsTree).toBeDefined();
    expect(far.geometry.boundsTree).toBeUndefined();
  });

  it('finds things in a box drawn around them, but not beyond its reach', () => {
    const { root, chair, camera } = scene();
    const objects = new RoomObjects(root, false);
    const box = { left: 95, top: 45, width: 10, height: 10 };
    expect(objects.inBox(camera, box, rect)).toEqual(['chair']);
    // Out of the way: the statue behind it is 60 m off, beyond a box's 40 m.
    chair.visible = false;
    expect(objects.inBox(camera, box, rect)).toEqual([]);
  });
});

describe('glowing objects in a room that doesn’t move', () => {
  it('places each halo on its object', () => {
    const { root, chair } = scene();
    const objects = new RoomObjects(root, false);
    objects.setHighlighted(['chair']);
    const halos = chair.children.filter((c) => c.userData.halo);
    expect(halos.length).toBeGreaterThan(0);
    for (const h of halos) {
      expect(h.matrixAutoUpdate).toBe(false);
      expect(h.matrixWorld.equals(chair.matrixWorld)).toBe(true);
    }
  });

  it('places each halo on its object when the room glows as it arrives, before it’s placed', () => {
    const root = new Group();
    const room = new Group();
    room.position.set(5, 0, 0);
    const lamp = new Mesh(new BoxGeometry(0.3, 0.3, 0.3), new MeshStandardMaterial());
    lamp.position.set(0, 1, -2);
    lamp.userData.objectKey = 'lamp';
    room.add(lamp);
    const objects = new RoomObjects(root, false);
    objects.setHighlighted(['lamp']);
    objects.prepare(room); // as the streamer does, before `freeze`
    freeze(room);
    root.add(room);
    const halo = lamp.children.find((c) => c.userData.halo);
    expect(halo?.matrixWorld.elements.slice(12, 15)).toEqual([5, 1, -2]);
  });
});
