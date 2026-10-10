/**
 * Baking a place's rooms side by side through the supervisor (lighting.ts's supervisorBaker),
 * against a fake supervisor that keeps every build to its cap the way the real one does: never
 * more bakes at once than it allows, every room finished, and a room that fails costs only itself.
 */

import { packTar } from '@ats/shared';
import type { BakeInput, BakeOutput } from '@ats/space-builder';
import { describe, expect, it } from 'vitest';
import { supervisorBaker } from '../src/lighting.ts';
import type { Supervisor } from '../src/studio/supervisor.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A room's bake input; `margin` tells the fake which room it is. */
const roomInput = (i: number) =>
  ({
    receiver: { positions: [0, 0, 0], faces: [[0]], faceGroup: [0], groups: [] },
    occluders: { positions: [], faces: [] },
    lights: [],
    hdri: null,
    hdriStrength: 1,
    hdriRotation: 0,
    resolution: 2,
    samples: 1,
    margin: i,
  }) satisfies BakeInput;

/**
 * A supervisor with `cap` places for bakes across every build (`others` of them taken by other
 * builds until `othersFor` ms have passed). Each room bakes for a few milliseconds; `failing`
 * rooms end as Blender failing.
 */
function fakeSupervisor(opts: {
  cap: number;
  others?: number;
  othersFor?: number;
  failing?: number[];
}) {
  const started = Date.now();
  const calls: { act: string; body?: Record<string, unknown> }[] = [];
  /** What each slot of this build is baking: the room, and when it ends. */
  const slots = new Map<number, { room: number; ends: number }>();
  let most = 0;
  const others = () => (Date.now() - started < (opts.othersFor ?? 0) ? (opts.others ?? 0) : 0);
  const sup: Supervisor = {
    async call(act, _claims, body) {
      calls.push({ act, ...(body ? { body } : {}) });
      if (act === 'bake.slots') return { parallel: opts.cap, cpus: 2 } as never;
      if (act === 'bake.init') return { ok: true } as never;
      if (act === 'bake.room') {
        await sleep(2);
        const slot = body?.slot as number;
        if (slots.size + others() >= opts.cap) return { ok: false, busy: true } as never;
        if (slots.has(slot)) throw new Error(`slot ${slot} is still baking`);
        const room = JSON.parse(Buffer.from(String(body?.input), 'base64').toString()).margin;
        slots.set(slot, { room, ends: Date.now() + 5 + (room % 3) * 5 });
        most = Math.max(most, slots.size + others());
        return { ok: true } as never;
      }
      if (act === 'bake.wait') {
        const s = slots.get(body?.slot as number);
        if (!s) throw new Error('nothing is baking there');
        await sleep(Math.max(0, Math.min(s.ends - Date.now(), 3)));
        if (Date.now() < s.ends) return { done: false } as never;
        slots.delete(body?.slot as number);
        const failed = opts.failing?.includes(s.room);
        return {
          done: true,
          code: failed ? 1 : 0,
          error: failed ? 'Error: Python: Traceback\nRuntimeError: out of tiles' : '',
        } as never;
      }
      if (act === 'bake.delete') return { ok: true } as never;
      throw new Error(`unexpected ${act}`);
    },
    async raw(act, _claims, body) {
      calls.push({ act, ...(body ? { body } : {}) });
      return packTar(
        new Map([
          ['meta.json', Buffer.from(JSON.stringify({ width: 2, height: 2, seconds: 1 }))],
          ['uv2.f32', new Uint8Array(8)],
          ['lightmap.f32', new Uint8Array(64)],
        ]),
      );
    },
    terminalUrl: () => '',
  };
  return { sup, calls, most: () => most };
}

describe('baking rooms side by side through the supervisor', () => {
  it('never runs more at once than the supervisor allows, and finishes every room', async () => {
    const f = fakeSupervisor({ cap: 3 });
    const job = await supervisorBaker(f.sup);
    expect(job.parallel).toBe(3);
    // Every room asked for at once (more than the builder ever asks for).
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => job.run(roomInput(i))),
    );
    await job.done();
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(f.most()).toBe(3);
    const rooms = f.calls.filter((c) => c.act === 'bake.room');
    expect(rooms).toHaveLength(10);
    expect(new Set(rooms.map((c) => c.body?.slot))).toEqual(new Set([0, 1, 2]));
    expect(f.calls.filter((c) => c.act === 'bake.delete')).toHaveLength(1);
    expect((results[0] as PromiseFulfilledResult<BakeOutput>).value.meta.width).toBe(2);
  });

  it("keeps baking the other rooms when one fails, and says why that one wasn't", async () => {
    const f = fakeSupervisor({ cap: 2, failing: [4] });
    const job = await supervisorBaker(f.sup);
    const results = await Promise.allSettled(
      Array.from({ length: 7 }, (_, i) => job.run(roomInput(i))),
    );
    await job.done();
    expect(results.map((r) => r.status)).toEqual([
      'fulfilled',
      'fulfilled',
      'fulfilled',
      'fulfilled',
      'rejected',
      'fulfilled',
      'fulfilled',
    ]);
    expect((results[4] as PromiseRejectedResult).reason.message).toBe(
      'the bake job failed: RuntimeError: out of tiles',
    );
    expect(f.most()).toBeLessThanOrEqual(2);
  });

  it("waits for a free place while other builds' bakes fill them, then carries on", async () => {
    // Two of three places are taken by another build for the first 40 ms.
    const f = fakeSupervisor({ cap: 3, others: 2, othersFor: 40 });
    const job = await supervisorBaker(f.sup, 5);
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) => job.run(roomInput(i))),
    );
    await job.done();
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(f.most()).toBeLessThanOrEqual(3);
    const asked = f.calls.filter((c) => c.act === 'bake.room');
    // Some asks were turned away (busy) and asked again; every room was started once in the end.
    expect(asked.length).toBeGreaterThan(6);
  });

  it('stops starting rooms when the build stops, and clears the job away once', async () => {
    const f = fakeSupervisor({ cap: 2 });
    const job = await supervisorBaker(f.sup);
    const runs = Promise.allSettled(Array.from({ length: 8 }, (_, i) => job.run(roomInput(i))));
    // Stopped while the first rooms are starting.
    await sleep(1);
    await job.done();
    const results = await runs;
    const deletedAt = f.calls.findIndex((c) => c.act === 'bake.delete');
    expect(deletedAt).toBeGreaterThan(-1);
    // Nothing was started after it was cleared away, and it was cleared once.
    expect(f.calls.slice(deletedAt + 1).filter((c) => c.act === 'bake.room')).toEqual([]);
    expect(f.calls.filter((c) => c.act === 'bake.delete')).toHaveLength(1);
    const stopped = results.filter(
      (r) => r.status === 'rejected' && r.reason.message === 'the build stopped',
    );
    expect(stopped.length).toBeGreaterThanOrEqual(6);
  });

  it('bakes one room at a time when the supervisor says nothing about its places', async () => {
    const f = fakeSupervisor({ cap: 1 });
    const call = f.sup.call;
    f.sup.call = (async (act, claims, body) => {
      if (act === 'bake.slots') throw new Error('Not allowed');
      return call(act, claims, body);
    }) as Supervisor['call'];
    const job = await supervisorBaker(f.sup);
    expect(job.parallel).toBe(1);
    await Promise.all([job.run(roomInput(0)), job.run(roomInput(1))]);
    await job.done();
    expect(f.most()).toBe(1);
  });
});
