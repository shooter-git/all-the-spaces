import { randomUUID } from 'node:crypto';
import { schema } from '@ats/db';
import { createStorage } from '@ats/storage';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { z } from 'zod';
import { record } from '../audit.ts';
import { assertPublicBucket, InternalAddressError } from '../bucket-address.ts';
import type { AppContext } from '../context.ts';
import { seal } from '../crypto-box.ts';
import { getInstallState } from '../install-state.ts';
import { checkOffsite, offsiteInput, sealOffsite } from '../offsite.ts';
import { sendError } from '../reply.ts';
import { setupCodeMatches } from '../setup-code.ts';
import { resetStorage } from '../storage.ts';

const groupKinds = ['family', 'household', 'company', 'building', 'other'] as const;

const completeBody = z.object({
  code: z.string().min(1),
  group: z.object({
    name: z.string().trim().min(1).max(80),
    kind: z.enum(groupKinds).default('other'),
    themeColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .default('#D3DDE8'),
  }),
  architect: z.object({
    name: z.string().trim().min(1).max(80),
    email: z.email(),
    password: z.string().min(10).max(128),
  }),
  storage: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('builtin') }),
    z.object({
      mode: z.literal('external'),
      endpoint: z.url(),
      region: z.string().min(1),
      bucket: z.string().min(1),
      accessKeyId: z.string().min(1),
      secretAccessKey: z.string().min(1),
    }),
  ]),
  backup: z.object({
    schedule: z.enum(['nightly', 'weekly', 'off']).default('nightly'),
    keepDays: z.number().int().min(1).max(365).default(14),
    /** Also copy each backup to another S3-compatible bucket. */
    offsite: offsiteInput.optional(),
  }),
});

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `${base || 'group'}-${randomUUID().slice(0, 6)}`;
}

const STORAGE_FAILED = "Couldn't reach that bucket. Check the address and keys.";
const OFFSITE_FAILED = "Couldn't save backups in that bucket. Check the address and keys.";

export async function setupRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, env, auth } = ctx;
  const limited = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  /** Only whoever holds the setup code, and only until setup is finished. */
  const refused = async (body: unknown) => {
    const code = z.object({ code: z.string() }).safeParse(body).data?.code ?? '';
    const state = await getInstallState(db);
    if (state?.setupCompletedAt) return { status: 409, error: 'Setup is already finished.' };
    if (
      !state?.setupCodeHash ||
      !setupCodeMatches(code, state.setupCodeHash, env.BETTER_AUTH_SECRET)
    ) {
      return { status: 403, error: 'That setup code is not right. Check the installer output.' };
    }
    return null;
  };

  /**
   * Tries a bucket typed into setup. What went wrong is only logged: the answer would otherwise
   * tell anyone what's listening where on the server's network.
   */
  const tryBucket = async (
    endpoint: string,
    attempt: () => Promise<void>,
    failed: string,
    log: FastifyBaseLogger,
  ): Promise<string | null> => {
    try {
      await assertPublicBucket(endpoint, env.S3_ENDPOINT);
      await attempt();
      return null;
    } catch (err) {
      if (err instanceof InternalAddressError) return err.message;
      log.warn({ err, endpoint }, 'Bucket check failed during setup');
      return failed;
    }
  };

  app.get('/api/setup/status', async () => {
    const state = await getInstallState(db);
    return { setupComplete: Boolean(state?.setupCompletedAt), publicUrl: env.ATS_PUBLIC_URL };
  });

  app.post('/api/setup/verify-code', limited, async (req, reply) => {
    const refusal = await refused(req.body);
    if (refusal) return sendError(reply, refusal.status, refusal.error);
    return { ok: true };
  });

  // Both checks take the setup code too: `{ code, ...details }`.
  app.post('/api/setup/test-storage', limited, async (req, reply) => {
    const refusal = await refused(req.body);
    if (refusal) return sendError(reply, refusal.status, refusal.error);
    const body = completeBody.shape.storage.parse(req.body);
    if (body.mode === 'builtin') return { ok: true };
    const error = await tryBucket(
      body.endpoint,
      () => createStorage({ ...body }).check(),
      STORAGE_FAILED,
      req.log,
    );
    return error ? sendError(reply, 400, error) : { ok: true };
  });

  app.post('/api/setup/test-offsite', limited, async (req, reply) => {
    const refusal = await refused(req.body);
    if (refusal) return sendError(reply, refusal.status, refusal.error);
    const body = offsiteInput.parse(req.body);
    const error = await tryBucket(body.endpoint, () => checkOffsite(body), OFFSITE_FAILED, req.log);
    return error ? sendError(reply, 400, error) : { ok: true };
  });

  app.post('/api/setup/complete', limited, async (req, reply) => {
    const refusal = await refused(req.body);
    if (refusal) return sendError(reply, refusal.status, refusal.error);
    const body = completeBody.parse(req.body);
    const { storage, backup } = body;
    if (storage.mode === 'external') {
      const error = await tryBucket(
        storage.endpoint,
        () => createStorage({ ...storage }).check(),
        STORAGE_FAILED,
        req.log,
      );
      if (error) return sendError(reply, 400, error);
    }

    if (backup.offsite) {
      const offsite = backup.offsite;
      const error = await tryBucket(
        offsite.endpoint,
        () => checkOffsite(offsite),
        OFFSITE_FAILED,
        req.log,
      );
      if (error) return sendError(reply, 400, error);
    }

    // Claim the install before creating anyone: of two submissions at once, only one gets past
    // here. Everything after this either finishes the install or gives the claim back.
    const claimed = await db
      .update(schema.installState)
      .set({ setupCompletedAt: new Date() })
      .where(and(eq(schema.installState.id, 1), isNull(schema.installState.setupCompletedAt)))
      .returning({ id: schema.installState.id });
    if (claimed.length === 0) return sendError(reply, 409, 'Setup is already finished.');
    const release = () =>
      db
        .update(schema.installState)
        .set({ setupCompletedAt: null })
        .where(eq(schema.installState.id, 1));

    let finished = false;
    try {
      // Create the Architect through Better Auth so password hashing and the session are standard.
      const signUp = await auth.api.signUpEmail({
        body: {
          name: body.architect.name,
          email: body.architect.email,
          password: body.architect.password,
        },
        asResponse: true,
      });
      if (!signUp.ok) {
        const detail = (await signUp.json().catch(() => ({}))) as { message?: string };
        // Returned, not sent: the answer goes out after the claim is given back.
        reply.code(400);
        return { error: detail.message ?? 'Could not create the account.' };
      }
      const { user, token } = (await signUp.json()) as {
        user: { id: string };
        token: string | null;
      };
      if (!token) {
        // Everyone confirms their email (the server sends email), but whoever holds the setup
        // code runs this server: their address counts as confirmed, so a mail problem can't lock
        // them out of a new install.
        const confirmed = await db
          .update(schema.user)
          .set({ emailVerified: true })
          .where(eq(schema.user.id, user.id))
          .returning({ id: schema.user.id });
        if (confirmed.length === 0) {
          reply.code(400);
          return { error: 'That email already has an account.' };
        }
      }

      const groupId = randomUUID();
      try {
        await db.transaction(async (tx) => {
          await tx.insert(schema.groups).values({
            id: groupId,
            name: body.group.name,
            slug: slugify(body.group.name),
            kind: body.group.kind,
            themeColor: body.group.themeColor,
            createdAt: new Date(),
          });
          await tx.insert(schema.memberships).values({
            id: randomUUID(),
            organizationId: groupId,
            userId: user.id,
            role: 'architect',
            createdAt: new Date(),
          });
          await tx
            .update(schema.installState)
            .set({
              setupCompletedAt: new Date(),
              setupCodeHash: null,
              publicUrl: env.ATS_PUBLIC_URL,
              storageMode: body.storage.mode,
              externalStorage:
                body.storage.mode === 'external'
                  ? {
                      endpoint: body.storage.endpoint,
                      region: body.storage.region,
                      bucket: body.storage.bucket,
                      accessKeyId: body.storage.accessKeyId,
                      secretAccessKeyEnc: seal(
                        body.storage.secretAccessKey,
                        env.BETTER_AUTH_SECRET,
                        'storage',
                      ),
                    }
                  : null,
              backup: {
                schedule: body.backup.schedule,
                keepDays: body.backup.keepDays,
                offsite: body.backup.offsite
                  ? sealOffsite(body.backup.offsite, env.BETTER_AUTH_SECRET, env.ATS_PUBLIC_URL)
                  : undefined,
              },
              updatedAt: new Date(),
            })
            .where(eq(schema.installState.id, 1));
          await record(tx, {
            groupId,
            actorUserId: user.id,
            action: 'setup.completed',
            metadata: {
              storageMode: body.storage.mode,
              backup: body.backup.schedule,
              offsiteBackup: Boolean(body.backup.offsite),
            },
          });
        });
      } catch (err) {
        // Leave no half-finished install behind: the wizard can simply be submitted again.
        await db.delete(schema.user).where(eq(schema.user.id, user.id));
        throw err;
      }

      finished = true;
      resetStorage();
      const signedIn = token
        ? signUp
        : await auth.api.signInEmail({
            body: { email: body.architect.email, password: body.architect.password },
            asResponse: true,
          });
      for (const cookie of signedIn.headers.getSetCookie()) reply.header('set-cookie', cookie);
      return { ok: true, groupId };
    } finally {
      if (!finished) await release();
    }
  });
}
