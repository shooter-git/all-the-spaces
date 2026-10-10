import type { AssistantChoice } from '@ats/api-types';
import { type Db, schema } from '@ats/db';
import { assistantFlags, isEffort, MODEL_NAME, type Provider, VENDOR_CLIS } from '@ats/shared';
import { eq, inArray } from 'drizzle-orm';

const { studioSettings } = schema;

/** The Studio settings of a group whose Architects haven't changed any. */
const defaults = (groupId: string): typeof studioSettings.$inferSelect => ({
  groupId,
  claudeModel: null,
  codexModel: null,
  codexEffort: null,
  claudeEffort: null,
  idleMinutes: 120,
  sessionHours: 4,
  telemetry: false,
  requireDeviceTest: false,
  deleteInputsAfterPublish: false,
  openInternet: false,
});

/** A group's Studio settings, or the defaults when an Architect hasn't changed any. */
export async function settingsFor(db: Db, groupId: string) {
  const [row] = await db.select().from(studioSettings).where(eq(studioSettings.groupId, groupId));
  return row ?? defaults(groupId);
}

/** The Studio settings of several groups at once, by group. */
export async function settingsForGroups(db: Db, groupIds: string[]) {
  const rows = groupIds.length
    ? await db.select().from(studioSettings).where(inArray(studioSettings.groupId, groupIds))
    : [];
  return new Map(
    groupIds.map((id) => [id, rows.find((r) => r.groupId === id) ?? defaults(id)] as const),
  );
}

export type StudioSettingsRow = Awaited<ReturnType<typeof settingsFor>>;

/** The model and effort a workspace runs with: its own choice, or else the group's default. */
export function assistantChoice(
  ws: { provider: Provider; model: string | null; effort: string | null },
  settings: StudioSettingsRow,
): AssistantChoice {
  const claude = ws.provider === 'claude';
  const model = ws.model || (claude ? settings.claudeModel : settings.codexModel) || null;
  const effort = ws.effort || (claude ? settings.claudeEffort : settings.codexEffort) || null;
  return {
    model: model && MODEL_NAME.test(model) ? model : null,
    effort: isEffort(ws.provider, effort) ? effort : null,
  };
}

/** The command that starts (or carries on) an assistant, with its model and effort. */
export function startCommand(
  ws: { provider: Provider; model: string | null; effort: string | null },
  settings: StudioSettingsRow,
  what: 'start' | 'resume' = 'start',
) {
  const cli = VENDOR_CLIS[ws.provider];
  const flags = assistantFlags(ws.provider, {
    ...assistantChoice(ws, settings),
    telemetry: settings.telemetry,
  });
  return [what === 'start' ? cli.start : cli.resume, ...flags].join(' ');
}
