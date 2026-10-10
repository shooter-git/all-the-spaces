import type { StudioSettings } from '@ats/api-types';
import { schema } from '@ats/db';
import { isEffort } from '@ats/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isArchitect, notFound, requireUser } from '../../access.ts';
import { record } from '../../audit.ts';
import type { AppContext } from '../../context.ts';
import { settingsFor } from '../../studio/settings.ts';

const { studioSettings } = schema;

/** A group's Studio settings, for its Architects. */
export async function studioSettingsRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db } = ctx;

  // ---- Settings -----------------------------------------------------------------------------

  app.get<{ Params: { groupId: string } }>(
    '/api/groups/:groupId/studio-settings',
    async (req, reply) => {
      const me = await requireUser(ctx, req, reply);
      if (!me) return;
      if (!(await isArchitect(db, me.id, req.params.groupId))) return notFound(reply);
      return (await settingsFor(db, req.params.groupId)) satisfies StudioSettings;
    },
  );
  app.put<{ Params: { groupId: string } }>(
    '/api/groups/:groupId/studio-settings',
    async (req, reply) => {
      const me = await requireUser(ctx, req, reply);
      if (!me) return;
      if (!(await isArchitect(db, me.id, req.params.groupId))) return notFound(reply);
      const model = z
        .string()
        .trim()
        .max(64)
        .regex(/^[\w.:-]*$/)
        .nullable();
      const body = z
        .object({
          claudeModel: model,
          codexModel: model,
          claudeEffort: z.string().max(16).nullable().default(null),
          codexEffort: z.string().max(16).nullable(),
          idleMinutes: z.number().int().min(5).max(240),
          sessionHours: z.number().int().min(1).max(24),
          telemetry: z.boolean(),
          requireDeviceTest: z.boolean(),
          deleteInputsAfterPublish: z.boolean().default(false),
          openInternet: z.boolean().default(false),
        })
        .parse(req.body);
      const values = {
        ...body,
        claudeModel: body.claudeModel || null,
        codexModel: body.codexModel || null,
        claudeEffort: isEffort('claude', body.claudeEffort) ? body.claudeEffort : null,
        codexEffort: isEffort('codex', body.codexEffort) ? body.codexEffort : null,
      };
      await db
        .insert(studioSettings)
        .values({ groupId: req.params.groupId, ...values })
        .onConflictDoUpdate({ target: studioSettings.groupId, set: values });
      await record(db, {
        groupId: req.params.groupId,
        actorUserId: me.id,
        action: 'studio.settings',
        target: null,
        metadata: values,
      });
      return { ok: true };
    },
  );
}
