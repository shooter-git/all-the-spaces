import { schema } from '@ats/db';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { isArchitect } from '../../access.ts';
import type { AppContext } from '../../context.ts';

const { spaces, workspaces } = schema;

export const inputKey = (spaceId: string, name: string) => `inputs/${spaceId}/${name}.jpg`;
/** Per place: a plan for each floor (tall buildings too), and a few photos of each room. */
export const LIMITS = { plan: 30, photo: 60 };

/** What the onboarding routes share, made once per app by `onboardingRoutes`. */
export function onboardingShared(ctx: AppContext) {
  const { db } = ctx;
  const ownSpace = async (userId: string, spaceId: string) => {
    if (!z.uuid().safeParse(spaceId).success) return null;
    const [space] = await db.select().from(spaces).where(eq(spaces.id, spaceId));
    return space && (await isArchitect(db, userId, space.groupId)) ? space : null;
  };

  /** A space workspace this Architect owns (their assistant runs in it). */
  const spaceWorkspace = async (userId: string, id: string) => {
    if (!z.uuid().safeParse(id).success) return null;
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, id));
    if (ws?.kind !== 'space' || ws.architectId !== userId || ws.status === 'archived') return null;
    return (await isArchitect(db, userId, ws.groupId)) ? ws : null;
  };

  return { ownSpace, spaceWorkspace };
}

export type OnboardingShared = ReturnType<typeof onboardingShared>;
