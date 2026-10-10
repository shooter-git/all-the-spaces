import type { VersionChanges } from '@ats/api-types';
import { type Db, schema } from '@ats/db';
import type { SpaceManifest } from '@ats/space-format';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { OPEN } from './commissions.ts';

const { commissionEvents, commissions, creations, spaces, spaceVersions } = schema;

type Room = SpaceManifest['rooms'][number];

/** What a room is made of: if this is unchanged, the room is exactly as it was (same files). */
const fingerprint = (r: Room) =>
  JSON.stringify([r.lods, r.collision, r.lightmap ?? null, r.objects.map((o) => o.key)]);

const objectsOf = (m: SpaceManifest) =>
  new Map(
    m.rooms.flatMap((r) =>
      r.objects.map((o) => [o.key, { ...o, roomKey: r.key, roomName: r.name }] as const),
    ),
  );

/** How a new version differs from the live one (null: nothing is live yet). */
export function diffVersions(live: SpaceManifest | null, next: SpaceManifest): VersionChanges {
  const before = new Map((live?.rooms ?? []).map((r) => [r.key, r]));
  const after = new Map(next.rooms.map((r) => [r.key, r]));
  const brief = (r: Room) => ({ key: r.key, name: r.name });
  const rooms: VersionChanges['rooms'] = { added: [], removed: [], changed: [], unchanged: [] };
  for (const r of next.rooms) {
    const old = before.get(r.key);
    if (!old) rooms.added.push(brief(r));
    else if (fingerprint(old) === fingerprint(r)) rooms.unchanged.push(brief(r));
    else rooms.changed.push(brief(r));
  }
  for (const r of live?.rooms ?? []) if (!after.has(r.key)) rooms.removed.push(brief(r));

  const was = live ? objectsOf(live) : new Map();
  const now = objectsOf(next);
  const objects: VersionChanges['objects'] = { added: [], removed: [], moved: [] };
  for (const [key, o] of now) {
    const old = was.get(key);
    if (!old) objects.added.push({ key, label: o.label, room: o.roomName });
    else if (
      old.roomKey !== o.roomKey ||
      Math.hypot(old.position[0] - o.position[0], old.position[2] - o.position[2]) > 0.05
    )
      objects.moved.push({ key, label: o.label, from: old.roomName, to: o.roomName });
  }
  for (const [key, o] of was)
    if (!now.has(key)) objects.removed.push({ key, label: o.label, room: o.roomName });
  return { rooms, objects };
}

/** Where every creation in a space is now (creation id → object key, or null on the shelf). */
export async function placementsOf(db: Db, spaceId: string) {
  const rows = await db
    .select({ id: creations.id, objectKey: creations.objectKey })
    .from(creations)
    .where(eq(creations.spaceId, spaceId));
  return Object.fromEntries(rows.map((r) => [r.id, r.objectKey])) as Record<string, string | null>;
}

/** Remembers where everything is, on the live version (so going back to it restores this). */
export async function recordPlacements(db: Db, spaceId: string) {
  const [space] = await db
    .select({ current: spaces.currentVersionId })
    .from(spaces)
    .where(eq(spaces.id, spaceId));
  if (!space?.current) return;
  await db
    .update(spaceVersions)
    .set({ placements: await placementsOf(db, spaceId) })
    .where(eq(spaceVersions.id, space.current));
}

/** Creations whose object isn't in this version: each needs a new home, or the shelf. */
export async function homelessIn(db: Db, spaceId: string, next: SpaceManifest) {
  const keys = new Set(next.rooms.flatMap((r) => r.objects.map((o) => o.key)));
  const rows = await db
    .select({ id: creations.id, title: creations.title, objectKey: creations.objectKey })
    .from(creations)
    .where(and(eq(creations.spaceId, spaceId), isNotNull(creations.objectKey)));
  return rows.filter((c) => !keys.has(c.objectKey as string));
}

/** Free objects in a version: ones that don't hold a creation (after `moves` are applied). */
export function freeObjects(
  next: SpaceManifest,
  placements: Record<string, string | null>,
): Set<string> {
  const taken = new Set(Object.values(placements).filter(Boolean));
  return new Set(
    next.rooms.flatMap((r) => r.objects.map((o) => o.key)).filter((k) => !taken.has(k)),
  );
}

/**
 * Puts creations where a version says they were. Creations made after it keep their object if it
 * exists there, and otherwise wait on the shelf; nothing is ever deleted, and saved data stays.
 */
export async function applyPlacements(
  db: Db,
  spaceId: string,
  version: { manifest: SpaceManifest; placements: Record<string, string | null> | null },
) {
  const keys = new Set(version.manifest.rooms.flatMap((r) => r.objects.map((o) => o.key)));
  const now = await placementsOf(db, spaceId);
  const wanted: Record<string, string | null> = {};
  for (const [id, key] of Object.entries(now)) {
    const then = version.placements && id in version.placements ? version.placements[id] : key;
    wanted[id] = then && keys.has(then) ? then : null;
  }
  // One creation per object: if two want the same one, the one that had it then keeps it.
  const holder = new Map<string, string>();
  for (const [id, key] of Object.entries(wanted)) {
    if (!key) continue;
    const other = holder.get(key);
    if (other && version.placements?.[other] === key) wanted[id] = null;
    else {
      if (other) wanted[other] = null;
      holder.set(key, id);
    }
  }
  for (const [id, key] of Object.entries(wanted))
    if (now[id] !== key)
      await db.update(creations).set({ objectKey: key }).where(eq(creations.id, id));
  return wanted;
}

/**
 * Open requests about objects that are gone: they stay open (an Architect may still build them),
 * now about a new object in the same room. Their timeline says what happened.
 */
export async function orphanRequests(db: Db, spaceId: string, next: SpaceManifest) {
  const keys = new Set(next.rooms.flatMap((r) => r.objects.map((o) => o.key)));
  const rows = await db
    .select()
    .from(commissions)
    .where(
      and(
        eq(commissions.spaceId, spaceId),
        inArray(commissions.status, OPEN),
        isNotNull(commissions.objectKey),
      ),
    );
  const gone = rows.filter((c) => !keys.has(c.objectKey as string));
  if (!gone.length) return;
  await db
    .update(commissions)
    .set({ objectKey: null })
    .where(
      inArray(
        commissions.id,
        gone.map((c) => c.id),
      ),
    );
  await db.insert(commissionEvents).values(
    gone.map((c) => ({
      commissionId: c.id,
      note: `The ${c.objectLabel?.toLowerCase() ?? 'object'} it was for isn't in the place any more.`,
    })),
  );
}
