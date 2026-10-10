import { randomUUID } from 'node:crypto';
import { type Db, schema } from '@ats/db';
import { and, eq } from 'drizzle-orm';
import { open, seal } from '../crypto-box.ts';
import { GrantError, refreshTokens, type Tokens } from './oauth.ts';
import type { Connector } from './registry.ts';

const { connectorLinks } = schema;

export type LinkRow = typeof connectorLinks.$inferSelect;

const purpose = (linkId: string) => `connector-token:${linkId}`;

export async function findLink(db: Db, userId: string, connectorId: string) {
  const [row] = await db
    .select()
    .from(connectorLinks)
    .where(and(eq(connectorLinks.userId, userId), eq(connectorLinks.connectorId, connectorId)));
  return row ?? null;
}

/** Stores (or replaces) a person's link, its tokens sealed for this link alone. */
export async function saveLink(
  db: Db,
  secret: string,
  userId: string,
  connectorId: string,
  tokens: Tokens,
): Promise<LinkRow> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: connectorLinks.id })
      .from(connectorLinks)
      .where(and(eq(connectorLinks.userId, userId), eq(connectorLinks.connectorId, connectorId)))
      .for('update');
    const id = existing?.id ?? randomUUID();
    const values = {
      scopes: tokens.scopes,
      accessTokenEnc: seal(tokens.accessToken, secret, purpose(id)),
      refreshTokenEnc: tokens.refreshToken ? seal(tokens.refreshToken, secret, purpose(id)) : null,
      accessExpiresAt: tokens.expiresAt,
      linkedAt: new Date(),
      lastUsedAt: null,
      brokenAt: null,
      // A new link is checked afresh (routes.ts, linkCheck): nothing from the last one carries over.
      accountName: null,
      checkedAt: null,
    };
    const [row] = existing
      ? await tx.update(connectorLinks).set(values).where(eq(connectorLinks.id, id)).returning()
      : await tx
          .insert(connectorLinks)
          .values({ id, userId, connectorId, ...values })
          .returning();
    return row as LinkRow;
  });
}

export const markBroken = (db: Db, linkId: string) =>
  db.update(connectorLinks).set({ brokenAt: new Date() }).where(eq(connectorLinks.id, linkId));

export function tokensOf(link: LinkRow, secret: string) {
  return {
    accessToken: open(link.accessTokenEnc, secret, purpose(link.id)),
    refreshToken: link.refreshTokenEnc
      ? open(link.refreshTokenEnc, secret, purpose(link.id))
      : null,
  };
}

/** The link no longer works: the person needs to link again. */
export class LinkBrokenError extends Error {}

// One refresh at a time per link: services that rotate refresh tokens refuse the second of two
// refreshes made with the same token, which would wrongly break the link.
const refreshing = new Map<string, Promise<LinkRow>>();

/**
 * Gets a new access token with the refresh token and stores both. A refusal from the service
 * (the grant was revoked or expired) breaks the link; being unreachable doesn't.
 */
export function refreshLink(
  db: Db,
  secret: string,
  connector: Connector,
  link: LinkRow,
): Promise<LinkRow> {
  const running = refreshing.get(link.id);
  if (running) return running;
  const job = (async () => {
    // Someone else may have refreshed it a moment ago.
    const [fresh] = await db.select().from(connectorLinks).where(eq(connectorLinks.id, link.id));
    if (!fresh || fresh.brokenAt) throw new LinkBrokenError();
    if (fresh.accessTokenEnc !== link.accessTokenEnc) return fresh;
    const { refreshToken } = tokensOf(fresh, secret);
    if (!refreshToken) {
      await markBroken(db, fresh.id);
      throw new LinkBrokenError();
    }
    let tokens: Tokens;
    try {
      tokens = await refreshTokens(connector, { refreshToken, scopes: fresh.scopes });
    } catch (err) {
      if (err instanceof GrantError) {
        await markBroken(db, fresh.id);
        throw new LinkBrokenError();
      }
      throw err;
    }
    const [row] = await db
      .update(connectorLinks)
      .set({
        scopes: tokens.scopes,
        accessTokenEnc: seal(tokens.accessToken, secret, purpose(fresh.id)),
        refreshTokenEnc: tokens.refreshToken
          ? seal(tokens.refreshToken, secret, purpose(fresh.id))
          : null,
        accessExpiresAt: tokens.expiresAt,
      })
      .where(eq(connectorLinks.id, fresh.id))
      .returning();
    return row as LinkRow;
  })().finally(() => refreshing.delete(link.id));
  refreshing.set(link.id, job);
  return job;
}
