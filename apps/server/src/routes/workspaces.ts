import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';
import { assistantRoutes } from './workspaces/assistants.ts';
import { lifecycleRoutes } from './workspaces/lifecycle.ts';
import { previewRoutes } from './workspaces/preview.ts';
import { workspaceShared } from './workspaces/shared.ts';
import { studioSettingsRoutes } from './workspaces/studio-settings.ts';
import { terminalRoutes } from './workspaces/terminal.ts';

/**
 * The Studio: Architects connect their own AI assistant, and build creations with it in
 * workspaces. Every AI turn is started by the Architect in the terminal; the app never sends a
 * prompt (docs/compliance.md).
 */
export async function workspaceRoutes(app: FastifyInstance, ctx: AppContext) {
  const shared = workspaceShared(app, ctx);
  await assistantRoutes(app, ctx, shared);
  await terminalRoutes(app, ctx, shared);
  await lifecycleRoutes(app, ctx, shared);
  await previewRoutes(app, ctx, shared);
  await studioSettingsRoutes(app, ctx);
}
