import { type Db, schema } from '@ats/db';
import { eq } from 'drizzle-orm';

/**
 * Whether a group has voice chat: the server has it set up (LiveKit), and the group's Architects
 * haven't turned it off. The real-time service hands out the passes.
 */
export async function voiceFor(
  db: Db,
  env: { LIVEKIT_API_KEY?: string | undefined },
  groupId: string,
) {
  const [settings] = await db
    .select({ voice: schema.groupSettings.voice })
    .from(schema.groupSettings)
    .where(eq(schema.groupSettings.groupId, groupId));
  const allowed = settings?.voice ?? true;
  return { allowed, available: Boolean(env.LIVEKIT_API_KEY) && allowed };
}
