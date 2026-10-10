import { describe, expectTypeOf, it } from 'vitest';
import type { Sent, Studio, StudioBuild } from '../src/index.ts';

// These are checked by `tsc` (pnpm typecheck); at run time they only have to load.
describe('Sent', () => {
  it('lets a Date stand for a string, as JSON sends it', () => {
    expectTypeOf<{ at: Date }>().toExtend<Sent<{ at: string }>>();
    expectTypeOf<{ at: Date | null }>().toExtend<Sent<{ at: string | null }>>();
    expectTypeOf<{ list: { at: Date }[] }>().toExtend<Sent<{ list: { at: string }[] }>>();
    expectTypeOf<{ at: string }>().toExtend<Sent<{ at: string }>>();
  });

  it('keeps everything else as strict as the type', () => {
    expectTypeOf<{ status: Date }>().not.toExtend<Sent<{ status: 'ready' | 'failed' }>>();
    expectTypeOf<{ n: string }>().not.toExtend<Sent<{ n: number }>>();
    expectTypeOf<{ at: null }>().not.toExtend<Sent<{ at: string }>>();
    expectTypeOf<{ list: { n: string }[] }>().not.toExtend<Sent<{ list: { n: number }[] }>>();
    expectTypeOf<{ pair: [number, number] }>().toExtend<Sent<{ pair: [number, number] }>>();
    expectTypeOf<{ pair: string[] }>().not.toExtend<Sent<{ pair: [number, number] }>>();
  });

  it('checks a whole reply', () => {
    const build = {
      id: 'b',
      status: 'passed',
      step: null,
      title: null,
      creationId: null,
      objectKey: null,
      versionId: null,
      publish: false,
      qa: null,
      error: null,
      createdAt: new Date(),
      finishedAt: null,
      source: null,
    } satisfies Sent<StudioBuild>;
    expectTypeOf(build).toExtend<Sent<StudioBuild>>();
    expectTypeOf<Studio['builds'][number]>().toEqualTypeOf<StudioBuild>();
  });
});
