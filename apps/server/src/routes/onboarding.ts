import type { Db } from '@ats/db';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';
import { buildRoutes } from './onboarding/build.ts';
import { inputRoutes } from './onboarding/inputs.ts';
import { planRoutes } from './onboarding/plan.ts';
import { publishRoutes } from './onboarding/publish.ts';
import { onboardingShared } from './onboarding/shared.ts';

export { inputKey, LIMITS } from './onboarding/shared.ts';

/**
 * Setting up a real place: the Architect gives floor plans, photos and a description; their
 * assistant writes the plan in a space workspace; the Architect reviews a built candidate and
 * publishes it. Photos are only ever read by the assistant: they never appear in the space.
 */
export async function onboardingRoutes(app: FastifyInstance, ctx: AppContext) {
  const shared = onboardingShared(ctx);
  await inputRoutes(app, ctx, shared);
  await planRoutes(app, ctx, shared);
  await buildRoutes(app, ctx, shared);
  await publishRoutes(app, ctx, shared);
}

export type { Db };
