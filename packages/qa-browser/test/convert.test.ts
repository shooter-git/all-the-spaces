import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Document, NodeIO, type TypedArray } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { afterAll, describe, expect, it } from 'vitest';
import { convertAssets, type FfmpegRunner } from '../src/convert.ts';

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

/**
 * A screen like a picture show's: a grid with two sets of UVs and a plain colour (no texture
 * uses either set, its own shader does), and an empty node the code finds by name.
 */
function screenModel(): Document {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const n = 32;
  const position: number[] = [];
  const normal: number[] = [];
  const uv: number[] = [];
  const indices: number[] = [];
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      position.push((x / (n - 1)) * 6 - 3, (y / (n - 1)) * 3.6, 0);
      normal.push(0, 0, 1);
      uv.push(x / (n - 1), 1 - y / (n - 1));
      if (x < n - 1 && y < n - 1) {
        const i = y * n + x;
        indices.push(i, i + 1, i + n, i + 1, i + n + 1, i + n);
      }
    }
  const accessor = (type: 'VEC2' | 'VEC3' | 'SCALAR', array: TypedArray) =>
    doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
  const primitive = doc
    .createPrimitive()
    .setAttribute('POSITION', accessor('VEC3', new Float32Array(position)))
    .setAttribute('NORMAL', accessor('VEC3', new Float32Array(normal)))
    .setAttribute('TEXCOORD_0', accessor('VEC2', new Float32Array(uv)))
    .setAttribute('TEXCOORD_1', accessor('VEC2', new Float32Array(uv)))
    .setIndices(accessor('SCALAR', new Uint16Array(indices)))
    .setMaterial(doc.createMaterial('screen').setBaseColorFactor([0.9, 0.9, 0.89, 1]));
  const screen = doc
    .createNode('screen')
    .setMesh(doc.createMesh('screen').addPrimitive(primitive))
    .addChild(doc.createNode('hang_point').setTranslation([0, 4, 0]));
  doc.createScene().addChild(screen);
  return doc;
}

/** A chest lid hinged at its node's origin: a fine grid from x 0.5 to 1.5, off that origin. */
function lidModel(): Document {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const n = 32;
  const position: number[] = [];
  const indices: number[] = [];
  for (let z = 0; z < n; z++)
    for (let x = 0; x < n; x++) {
      position.push(0.5 + x / (n - 1), 0.2, (z / (n - 1)) * 0.8 - 0.4);
      if (x < n - 1 && z < n - 1) {
        const i = z * n + x;
        indices.push(i, i + n, i + 1, i + 1, i + n, i + n + 1);
      }
    }
  const primitive = doc
    .createPrimitive()
    .setAttribute(
      'POSITION',
      doc.createAccessor().setType('VEC3').setArray(new Float32Array(position)).setBuffer(buffer),
    )
    .setIndices(
      doc.createAccessor().setType('SCALAR').setArray(new Uint16Array(indices)).setBuffer(buffer),
    );
  const lid = doc
    .createNode('lid')
    .setTranslation([0, 1, -0.4])
    .setMesh(doc.createMesh('lid').addPrimitive(primitive));
  doc.createScene().addChild(doc.createNode('chest').addChild(lid));
  return doc;
}

describe('converting models', () => {
  it('keeps the UVs and empty nodes a creation’s own code uses', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ats-qa-convert-'));
    dirs.push(dir);
    const io = new NodeIO()
      .registerExtensions(ALL_EXTENSIONS)
      .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
    const glb = await io.writeBinary(screenModel());
    await writeFile(join(dir, 'screen.glb'), glb);

    const result = await convertAssets(dir, [{ path: 'screen.glb', bytes: glb.byteLength }], 'mid');
    expect(result.conversions.map((c) => c.path)).toEqual(['screen.glb']);

    await MeshoptDecoder.ready;
    const out = await io.read(join(dir, 'screen.glb'));
    const names = out
      .getRoot()
      .listNodes()
      .map((n) => n.getName());
    expect(names).toContain('screen');
    expect(names).toContain('hang_point');
    const [primitive] = out.getRoot().listMeshes()[0]?.listPrimitives() ?? [];
    expect(primitive?.listSemantics()).toEqual(
      expect.arrayContaining(['POSITION', 'NORMAL', 'TEXCOORD_0', 'TEXCOORD_1']),
    );
  });

  it('keeps each part’s own transform, so parts the code turns turn around their joint', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ats-qa-convert-'));
    dirs.push(dir);
    const io = new NodeIO()
      .registerExtensions(ALL_EXTENSIONS)
      .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
    const glb = await io.writeBinary(lidModel());
    await writeFile(join(dir, 'chest.glb'), glb);

    const result = await convertAssets(dir, [{ path: 'chest.glb', bytes: glb.byteLength }], 'mid');
    expect(result.conversions.map((c) => c.path)).toEqual(['chest.glb']);

    await MeshoptDecoder.ready;
    const out = await io.read(join(dir, 'chest.glb'));
    const lid = out
      .getRoot()
      .listNodes()
      .find((n) => n.getName() === 'lid');
    expect(lid?.getTranslation()).toEqual([0, 1, -0.4]);
    expect(lid?.getRotation()).toEqual([0, 0, 0, 1]);
    expect(lid?.getScale()).toEqual([1, 1, 1]);
    const position = lid?.getMesh()?.listPrimitives()[0]?.getAttribute('POSITION');
    expect(position?.getComponentType()).toBe(5126);
    expect(position?.getNormalized()).toBe(false);
    expect(position?.getMin([])).toEqual([0.5, 0.2, -0.4].map(Math.fround));
  });
});

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** What ffmpeg's loudness filter ends with. */
const summary = (lufs: number, peak: number) =>
  `[Parsed_ebur128_0 @ 0x0] Summary:\n  Integrated loudness:\n    I:  ${lufs} LUFS\n  True peak:\n    Peak: ${peak} dBFS\n`;

describe('checking sound levels', () => {
  it('checks several sounds at once and reports them in file order', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ats-qa-convert-'));
    dirs.push(dir);
    const names = ['a.mp3', 'b.ogg', 'c.wav', 'd.mp3', 'e.m4a', 'f.opus', 'g.mp3', 'h.wav'];
    for (const n of names) await writeFile(join(dir, n), 'x'.repeat(100));
    let running = 0;
    let most = 0;
    const run: FfmpegRunner = async (args) => {
      if (args[0] === '-version') return { stdout: 'ffmpeg', stderr: '' };
      running++;
      most = Math.max(most, running);
      const input = args[args.indexOf('-i') + 1] ?? '';
      const i = names.findIndex((n) => input.endsWith(n));
      // Earlier files take longer, so they finish after later ones.
      await new Promise((r) => setTimeout(r, (names.length - i) * 5));
      running--;
      if (names[i] === 'c.wav') throw new Error('Invalid data found when processing input');
      if (args.includes('null'))
        return { stdout: '', stderr: summary(i % 2 ? -20 : -8, i % 2 ? -6 : -0.2) };
      await writeFile(args.at(-1) ?? '', 'x'.repeat(10 + i));
      return { stdout: '', stderr: '' };
    };
    const files = names.map((path) => ({ path, bytes: 100 }));
    const result = await convertAssets(dir, files, 'mid', run);

    expect(most).toBe(Math.min(4, availableParallelism()));
    // The loud ones (every other file, but not the one that couldn't be read), in file order.
    expect(result.conversions.map((c) => [c.path, c.after])).toEqual([
      ['a.mp3', 10],
      ['e.m4a', 14],
      ['g.mp3', 16],
    ]);
    expect(result.conversions[0]?.action).toMatch(/^made 8\.0 dB quieter/);
    expect(result.notes).toEqual([
      "c.wav: sound level couldn't be checked (Invalid data found when processing input)",
    ]);
    expect(files.map((f) => f.bytes)).toEqual([10, 100, 100, 100, 14, 100, 16, 100]);
    expect(await readFile(join(dir, 'e.m4a'), 'utf8')).toBe('x'.repeat(14));
  });

  it.skipIf(!hasFfmpeg)('brings loud sounds down with the real ffmpeg', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ats-qa-convert-'));
    dirs.push(dir);
    // The sine source is at an eighth of full scale (about -22 LUFS): 6× is loud.
    const volumes = { 'loud-1.wav': 6, 'quiet.wav': 1, 'loud-2.wav': 6 };
    const names = Object.keys(volumes);
    for (const [n, volume] of Object.entries(volumes))
      execFileSync('ffmpeg', [
        ...['-hide_banner', '-loglevel', 'error', '-f', 'lavfi'],
        ...['-i', 'sine=frequency=440:duration=1', '-af', `volume=${volume}`, join(dir, n)],
      ]);
    const files = await Promise.all(
      names.map(async (path) => ({ path, bytes: (await readFile(join(dir, path))).byteLength })),
    );
    const result = await convertAssets(dir, files, 'mid');
    expect(result.notes).toEqual([]);
    expect(result.conversions.map((c) => c.path)).toEqual(['loud-1.wav', 'loud-2.wav']);
    for (const c of result.conversions) expect(c.action).toMatch(/^made [\d.]+ dB quieter/);
  });
});
