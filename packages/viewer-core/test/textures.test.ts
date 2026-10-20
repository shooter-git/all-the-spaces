import { Group, Mesh, MeshStandardMaterial, PlaneGeometry, Texture } from 'three';
import { describe, expect, it } from 'vitest';
import { sharpen } from '../src/textures.ts';

describe('textures seen at a glance', () => {
  it('are drawn sharply: every texture of every material gets the level asked for', () => {
    const map = new Texture();
    const normalMap = new Texture();
    const room = new Group();
    room.add(new Mesh(new PlaneGeometry(), new MeshStandardMaterial({ map, normalMap })));
    sharpen(room, 8);
    expect(map.anisotropy).toBe(8);
    expect(normalMap.anisotropy).toBe(8);
  });
});
