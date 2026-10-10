import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';
import { architectRequestRoutes } from './requests/architect.ts';
import { memberRequestRoutes } from './requests/member.ts';
import { notificationRoutes } from './requests/notifications.ts';
import { requestShared } from './requests/shared.ts';

export { imageKey, mayAskIn } from './requests/member.ts';
export { isPushService } from './requests/notifications.ts';

/**
 * Requests: members ask for something new for an object (or a new object), a change to a
 * creation, or report something wrong with one. Asking only writes rows and tells the Architects:
 * nothing is built, and no assistant is asked anything, until an Architect opens a workspace and
 * starts their assistant themselves (docs/compliance.md, C1 and C9).
 */
export async function requestRoutes(app: FastifyInstance, ctx: AppContext) {
  const shared = requestShared(ctx);
  await memberRequestRoutes(app, ctx, shared);
  await architectRequestRoutes(app, ctx, shared);
  await notificationRoutes(app, ctx, shared);
}
