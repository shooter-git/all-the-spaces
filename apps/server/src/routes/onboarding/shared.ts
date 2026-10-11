import { schema } from '@ats/db';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { isArchitect } from '../../access.ts';
import type { AppContext } from '../../context.ts';
import { zipPack } from '../../packs.ts';
import { getStorage } from '../../storage.ts';

const { spaces, spaceInputs, workspaces } = schema;

export const inputKey = (spaceId: string, name: string) => `inputs/${spaceId}/${name}.jpg`;
/** A pack's files, kept together as one zip. */
export const packKey = (spaceId: string, name: string) => `inputs/${spaceId}/${name}.zip`;
/**
 * Per place: a plan for each floor (tall buildings too), a few photos of each room, and a few
 * packs (a .zip of photos and notes on them, kept whole).
 */
export const LIMITS = { plan: 30, photo: 60, pack: 10 };

/**
 * Keeps a prepared pack with a place (so every workspace that changes it has it, in
 * `inputs/<folder>/`): as `pack-<n>`, its folder in the note (numbered if another pack has it), its
 * number of files as its width. Null when the place has as many packs as it can.
 */
export async function keepPack(
  ctx: AppContext,
  spaceId: string,
  pack: { folder: string; files: Map<string, Buffer> },
): Promise<{ name: string; folder: string; bytes: number } | null> {
  const existing = await ctx.db.select().from(spaceInputs).where(eq(spaceInputs.spaceId, spaceId));
  const packs = existing.filter((i) => i.kind === 'pack');
  if (packs.length >= LIMITS.pack) return null;
  const taken = new Set(existing.map((i) => i.name));
  let n = 1;
  while (taken.has(`pack-${n}`)) n++;
  const folders = new Set(packs.map((p) => p.note));
  let folder = pack.folder;
  for (let i = 2; folders.has(folder); i++) folder = `${pack.folder}-${i}`;
  const zip = zipPack(pack.files);
  const name = `pack-${n}`;
  await (await getStorage(ctx)).put(packKey(spaceId, name), zip, 'application/zip');
  await ctx.db.insert(spaceInputs).values({
    spaceId,
    name,
    kind: 'pack',
    note: folder,
    width: pack.files.size,
    height: 0,
    bytes: zip.byteLength,
  });
  return { name, folder, bytes: zip.byteLength };
}

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
