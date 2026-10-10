import { schema } from '@ats/db';
import type { SpaceAccess } from '@ats/shared';
import { manifestFiles, type SpaceManifest, viewerManifest } from '@ats/space-format';
import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { notFound, requireArchitect, requireUser } from '../access.ts';
import { record } from '../audit.ts';
import type { AppContext } from '../context.ts';
import { noEvents } from '../events.ts';
import { manifestOf } from '../manifests.ts';
import { spaceAccess, spaceAccessMany, visibleRooms } from '../privacy.ts';
import { sendError } from '../reply.ts';
import { membershipsFor } from '../session.ts';
import { chunkKey, createSampleSpace, SAMPLES, type SampleName } from '../spaces.ts';
import { getStorage } from '../storage.ts';

const { spaces, spaceVersions, roomPolicies, roomAccess, memberships, user } = schema;

const CONTENT_TYPES: Record<string, string> = {
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
  bin: 'application/octet-stream',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  ktx2: 'image/ktx2',
  hdr: 'image/vnd.radiance',
};

/**
 * Room access per space, kept for a second: file requests arrive in bursts of dozens. Changes
 * made through this server clear it straight away.
 */
const accessCache = new Map<string, { at: number; access: Promise<SpaceAccess> }>();

/** What one person may see of a version: the filtered manifest and the files it may fetch. */
const views = new Map<string, { manifest: SpaceManifest | null; files: Set<string> }>();
function viewOf(versionId: string, manifest: SpaceManifest, visible: Set<string>) {
  const key = `${versionId}:${[...visible].sort().join(',')}`;
  let view = views.get(key);
  if (!view) {
    const filtered = viewerManifest(manifest, visible);
    view = { manifest: filtered, files: filtered ? manifestFiles(filtered) : new Set() };
    if (views.size > 500) views.clear();
    views.set(key, view);
  }
  return view;
}

/**
 * A little drawing of a space for its card: the rooms of its lowest floor someone may see, as
 * rectangles seen from above (metres, from the corner), and how much of it they may see.
 */
export interface SpaceSketch {
  floors: number;
  rooms: number;
  width: number;
  depth: number;
  /** x, z, width, depth, and 1 for outdoors. */
  ground: [number, number, number, number, 0 | 1][];
}
const round = (n: number) => Math.round(n * 10) / 10;
export function sketchOf(m: SpaceManifest | null): SpaceSketch | null {
  if (!m || m.rooms.length === 0) return null;
  const floors = m.floors.filter((f) => m.rooms.some((r) => r.floorKey === f.key));
  const lowest = floors.reduce((a, b) => (b.index < a.index ? b : a));
  const rooms = m.rooms.filter((r) => r.floorKey === lowest.key);
  const x0 = Math.min(...rooms.map((r) => r.bounds.min[0] ?? 0));
  const z0 = Math.min(...rooms.map((r) => r.bounds.min[2] ?? 0));
  const x1 = Math.max(...rooms.map((r) => r.bounds.max[0] ?? 0));
  const z1 = Math.max(...rooms.map((r) => r.bounds.max[2] ?? 0));
  return {
    floors: floors.length,
    rooms: m.rooms.length,
    width: round(x1 - x0),
    depth: round(z1 - z0),
    ground: rooms.map((r) => {
      const [ax = 0, , az = 0] = r.bounds.min;
      const [bx = 0, , bz = 0] = r.bounds.max;
      return [round(ax - x0), round(az - z0), round(bx - ax), round(bz - az), r.isOutdoor ? 1 : 0];
    }),
  };
}

/**
 * A place being set up: its details still to finish (`details`), its workspace never started
 * (`start`) or asleep (`asleep`), the assistant at work (`working`), a version building
 * (`building`) or built and waiting to be checked (`review`), or the last build failed (`failed`).
 */
export type DraftStage =
  | 'details'
  | 'start'
  | 'asleep'
  | 'working'
  | 'building'
  | 'review'
  | 'failed';

export async function spaceRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db } = ctx;

  const accessOf = (spaceId: string) => {
    const cached = accessCache.get(spaceId);
    if (cached && Date.now() - cached.at < 1000) return cached.access;
    const access = spaceAccess(db, spaceId);
    accessCache.set(spaceId, { at: Date.now(), access });
    return access;
  };

  /** The rooms and files of a space this person may see (`access`: already looked up). */
  async function viewFor(
    found: {
      user: { id: string };
      space: { id: string };
      version: { id: string; manifest: unknown };
    },
    access?: SpaceAccess,
  ) {
    const manifest = manifestOf(found.version);
    access ??= await accessOf(found.space.id);
    const visible = visibleRooms(
      access,
      found.user.id,
      manifest.rooms.map((r) => r.key),
    );
    return viewOf(found.version.id, manifest, visible);
  }

  /**
   * The space (with its current version) if the signed-in user belongs to its group. Architects
   * may ask for another version (a candidate to review) with a `versionId` in the path.
   */
  async function accessibleSpace(
    req: FastifyRequest<{ Params: { spaceId: string; versionId?: string } }>,
    reply: FastifyReply,
  ) {
    const user = await requireUser(ctx, req, reply);
    if (!user) return null;
    if (!z.uuid().safeParse(req.params.spaceId).success) {
      await notFound(reply, 'That space does not exist.');
      return null;
    }
    const mine = await membershipsFor(db, user.id);
    const groupIds = mine.map((m) => m.groupId);
    const [space] = groupIds.length
      ? await db
          .select()
          .from(spaces)
          .where(and(eq(spaces.id, req.params.spaceId), inArray(spaces.groupId, groupIds)))
      : [];
    const isArchitect = mine.some((m) => m.groupId === space?.groupId && m.role === 'architect');
    const wanted = req.params.versionId;
    const versionId =
      wanted !== undefined
        ? isArchitect && z.uuid().safeParse(wanted).success
          ? wanted
          : null
        : space?.currentVersionId;
    const [version] =
      space && versionId
        ? await db
            .select()
            .from(spaceVersions)
            .where(and(eq(spaceVersions.id, versionId), eq(spaceVersions.spaceId, space.id)))
        : [];
    if (!space || !version) {
      // Same answer whether it doesn't exist or isn't yours: don't reveal other groups' spaces.
      await notFound(reply, 'That space does not exist.');
      return null;
    }
    return { user, isArchitect, space, version };
  }

  app.get('/api/spaces', async (req, reply) => {
    const user = await requireUser(ctx, req, reply);
    if (!user) return;
    const mine = await membershipsFor(db, user.id);
    const groupIds = mine.map((m) => m.groupId);
    if (groupIds.length === 0) return { spaces: [] };
    const architectOf = new Set(mine.filter((m) => m.role === 'architect').map((m) => m.groupId));
    const rows = await db
      .select({
        id: spaces.id,
        name: spaces.name,
        spaceType: spaces.spaceType,
        sample: spaces.sample,
        groupId: spaces.groupId,
        status: spaces.status,
        currentVersionId: spaces.currentVersionId,
        importedAt: spaces.importedAt,
        buildState: spaces.buildState,
      })
      .from(spaces)
      .where(inArray(spaces.groupId, groupIds));
    // What each card draws: only the rooms this person may see.
    const live = rows.filter((r) => r.status === 'ready' && r.currentVersionId);
    const versions = live.length
      ? await db
          .select({ id: spaceVersions.id, manifest: spaceVersions.manifest })
          .from(spaceVersions)
          .where(
            inArray(
              spaceVersions.id,
              live.map((r) => r.currentVersionId as string),
            ),
          )
      : [];
    const sketches = new Map<string, SpaceSketch | null>();
    const accesses = await spaceAccessMany(
      db,
      live.map((r) => r.id),
    );
    for (const r of live) {
      const version = versions.find((v) => v.id === r.currentVersionId);
      if (!version) continue;
      const view = await viewFor({ user, space: r, version }, accesses.get(r.id));
      sketches.set(r.id, sketchOf(view.manifest));
    }
    // A place still being set up is only for Architects (with the workspace it's built in).
    const drafts = rows
      .filter((r) => r.status === 'draft' && architectOf.has(r.groupId))
      .map((r) => r.id);
    const draftWorkspaces = drafts.length
      ? await db
          .select({
            id: schema.workspaces.id,
            spaceId: schema.workspaces.spaceId,
            architectId: schema.workspaces.architectId,
            status: schema.workspaces.status,
          })
          .from(schema.workspaces)
          .where(
            and(inArray(schema.workspaces.spaceId, drafts), eq(schema.workspaces.kind, 'space')),
          )
      : [];
    // A version built and waiting to be checked.
    const candidates = new Set(
      drafts.length
        ? (
            await db
              .select({ spaceId: spaceVersions.spaceId })
              .from(spaceVersions)
              .where(
                and(inArray(spaceVersions.spaceId, drafts), eq(spaceVersions.status, 'candidate')),
              )
          ).map((v) => v.spaceId)
        : [],
    );
    /** Where a place being set up is up to, so its card can say what's next. */
    const stageOf = (spaceId: string, buildState: string | null): DraftStage => {
      const ws = draftWorkspaces.find((w) => w.spaceId === spaceId && w.status !== 'archived');
      if (buildState === 'building') return 'building';
      if (candidates.has(spaceId)) return 'review';
      if (ws?.status === 'running') return 'working';
      if (buildState === 'failed') return 'failed';
      if (!ws) return 'details';
      return ws.status === 'ready' ? 'start' : 'asleep';
    };
    return {
      spaces: rows
        .filter((r) => r.status !== 'draft' || architectOf.has(r.groupId))
        .map(({ currentVersionId: _, importedAt, buildState, ...r }) => ({
          ...r,
          imported: Boolean(importedAt),
          ...(sketches.has(r.id) ? { sketch: sketches.get(r.id) } : {}),
          ...(r.status === 'draft'
            ? {
                workspaceId:
                  draftWorkspaces.find((w) => w.spaceId === r.id && w.architectId === user.id)
                    ?.id ?? null,
                stage: stageOf(r.id, buildState),
              }
            : {}),
        })),
      samples: Object.entries(SAMPLES).map(([key, description]) => ({ key, description })),
    };
  });

  app.post<{ Params: { groupId: string } }>(
    '/api/groups/:groupId/sample-spaces',
    async (req, reply) => {
      const user = await requireArchitect(ctx, req, reply, req.params.groupId, {
        status: 403,
        error: 'Only Architects can add spaces.',
      });
      if (!user) return;
      const { sample } = z
        .object({ sample: z.enum(Object.keys(SAMPLES) as [SampleName, ...SampleName[]]) })
        .parse(req.body);
      const { spaceId } = await createSampleSpace(
        db,
        await getStorage(ctx),
        req.params.groupId,
        sample,
        {
          env: ctx.env,
          supervisor: ctx.supervisor,
          blender: ctx.blender,
          ...(ctx.log ? { log: ctx.log } : {}),
        },
      );
      await record(db, {
        groupId: req.params.groupId,
        actorUserId: user.id,
        action: 'space.sample_added',
        target: spaceId,
        metadata: { sample },
      });
      return { spaceId };
    },
  );

  // ---- Room privacy (Architects) ----------------------------------------------------------

  /** Every room with who may see it, plus the group's members to choose from. */
  app.get<{ Params: { spaceId: string } }>('/api/spaces/:spaceId/rooms', async (req, reply) => {
    const found = await accessibleSpace(req, reply);
    if (!found) return;
    if (!found.isArchitect) {
      return sendError(reply, 403, 'Only Architects can change who sees which rooms.');
    }
    const manifest = manifestOf(found.version);
    const access = await spaceAccess(db, found.space.id);
    const rules = new Map(
      (await db.select().from(roomPolicies).where(eq(roomPolicies.spaceId, found.space.id))).map(
        (p) => [p.roomKey, p],
      ),
    );
    const floors = new Map(manifest.floors.map((f) => [f.key, f.name]));
    const people = await db
      .select({ id: user.id, name: user.name, role: memberships.role })
      .from(memberships)
      .innerJoin(user, eq(user.id, memberships.userId))
      .where(eq(memberships.organizationId, found.space.groupId));
    return {
      rooms: manifest.rooms.map((r) => ({
        key: r.key,
        name: r.name,
        floor: floors.get(r.floorKey) ?? '',
        visibility: access.rooms[r.key]?.visibility ?? 'hidden',
        people: access.rooms[r.key]?.users ?? [],
        requests: rules.get(r.key)?.requests ?? 'anyone',
        ownerId: rules.get(r.key)?.ownerId ?? null,
      })),
      people,
    };
  });

  app.put<{ Params: { spaceId: string; roomKey: string } }>(
    '/api/spaces/:spaceId/rooms/:roomKey',
    async (req, reply) => {
      const found = await accessibleSpace(req, reply);
      if (!found) return;
      if (!found.isArchitect) {
        return sendError(reply, 403, 'Only Architects can change who sees which rooms.');
      }
      const { visibility, people, requests, ownerId } = z
        .object({
          visibility: z.enum(['group', 'limited', 'hidden']),
          people: z.array(z.string().max(64)).max(500).default([]),
          /** Who may ask for things in it (unchanged when absent). */
          requests: z.enum(['anyone', 'owner', 'architects']).optional(),
          ownerId: z.string().max(64).nullable().optional(),
        })
        .parse(req.body);
      const { roomKey } = req.params;
      if (!manifestOf(found.version).rooms.some((r) => r.key === roomKey)) {
        return notFound(reply, 'That room does not exist.');
      }
      const members = new Set(
        (
          await db
            .select({ id: memberships.userId })
            .from(memberships)
            .where(eq(memberships.organizationId, found.space.groupId))
        ).map((m) => m.id),
      );
      const allowed = visibility === 'limited' ? [...new Set(people)] : [];
      if (ownerId && !members.has(ownerId)) {
        return sendError(reply, 400, 'A room’s owner must be in the group.');
      }
      if (allowed.some((id) => !members.has(id))) {
        return sendError(reply, 400, 'Rooms can only be shared with people in the group.');
      }
      const spaceId = found.space.id;
      await db.transaction(async (tx) => {
        await tx
          .insert(roomPolicies)
          .values({
            spaceId,
            roomKey,
            visibility,
            ...(requests ? { requests } : {}),
            ...(ownerId !== undefined ? { ownerId } : {}),
          })
          .onConflictDoUpdate({
            target: [roomPolicies.spaceId, roomPolicies.roomKey],
            set: {
              visibility,
              ...(requests ? { requests } : {}),
              ...(ownerId !== undefined ? { ownerId } : {}),
              updatedAt: new Date(),
            },
          });
        await tx
          .delete(roomAccess)
          .where(and(eq(roomAccess.spaceId, spaceId), eq(roomAccess.roomKey, roomKey)));
        if (allowed.length) {
          await tx
            .insert(roomAccess)
            .values(allowed.map((userId) => ({ spaceId, roomKey, userId })));
        }
        await record(tx, {
          groupId: found.space.groupId,
          actorUserId: found.user.id,
          action: 'room.visibility_changed',
          target: `${spaceId}/${roomKey}`,
          metadata: { visibility, people: allowed.length, requests, owner: ownerId ?? null },
        });
      });
      accessCache.delete(spaceId);
      await (ctx.events ?? noEvents).policyChanged(spaceId);
      return { ok: true };
    },
  );

  const manifestRoute = async (
    req: FastifyRequest<{ Params: { spaceId: string; versionId?: string } }>,
    reply: FastifyReply,
  ) => {
    const found = await accessibleSpace(req, reply);
    if (!found) return;
    reply.header('cache-control', 'private, no-cache');
    const view = await viewFor(found);
    if (!view.manifest) {
      return sendError(reply, 403, 'Nothing in this space has been shared with you yet.');
    }
    return view.manifest;
  };
  app.get('/api/spaces/:spaceId/manifest', manifestRoute);
  // A version that isn't live yet (a candidate), for Architects reviewing it.
  app.get('/api/spaces/:spaceId/versions/:versionId/manifest', manifestRoute);

  const chunkRoute = async (
    req: FastifyRequest<{ Params: { spaceId: string; versionId?: string; file: string } }>,
    reply: FastifyReply,
  ) => {
    {
      const type = CONTENT_TYPES[req.params.file.split('.').pop() ?? ''];
      if (!type || !/^[0-9a-f]{64}\.[a-z0-9]+$/.test(req.params.file))
        return reply.code(404).send();
      const found = await accessibleSpace(req, reply);
      if (!found) return;
      const path = `chunks/${req.params.file}`;
      // Only files of rooms this person may see (the same answer as for a file that doesn't exist).
      if (!(await viewFor(found)).files.has(path)) return reply.code(404).send();
      const etag = `"${req.params.file.slice(0, 64)}"`;
      reply
        .header('content-type', type)
        .header('etag', etag)
        // Content-addressed: the bytes behind this URL can never change.
        .header('cache-control', 'private, max-age=31536000, immutable');
      if (req.headers['if-none-match'] === etag) return reply.code(304).send();
      const bytes = await (await getStorage(ctx)).getBytes(chunkKey(found.space.id, path));
      return reply.send(Buffer.from(bytes));
    }
  };
  app.get('/api/spaces/:spaceId/chunks/:file', chunkRoute);
  app.get('/api/spaces/:spaceId/versions/:versionId/chunks/:file', chunkRoute);
}
