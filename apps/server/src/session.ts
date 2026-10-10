import type { Me } from '@ats/api-types';
import { type Db, schema } from '@ats/db';
import { fromNodeHeaders } from 'better-auth/node';
import { eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { AppContext } from './context.ts';

export async function getSession(ctx: AppContext, req: FastifyRequest) {
  return ctx.auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
}

/**
 * The groups this person is in, and their role in each. The column is Better Auth's plain text,
 * but only ever holds `architect` or `member`: the app writes nothing else (setup, invites, the
 * people page).
 */
export async function membershipsFor(db: Db, userId: string): Promise<Me['groups']> {
  const rows = await db
    .select({
      groupId: schema.groups.id,
      groupName: schema.groups.name,
      themeColor: schema.groups.themeColor,
      role: schema.memberships.role,
    })
    .from(schema.memberships)
    .innerJoin(schema.groups, eq(schema.groups.id, schema.memberships.organizationId))
    .where(eq(schema.memberships.userId, userId));
  return rows as Me['groups'];
}
