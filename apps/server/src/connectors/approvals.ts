import type { DeclaredConnector, StudioVersionConnector } from '@ats/api-types';
import { type Db, schema } from '@ats/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { ConnectorRegistry } from './registry.ts';

const { creationVersionConnectors } = schema;

type Approval = typeof creationVersionConnectors.$inferSelect;

/** The connectors a version says it uses (its ats.json `connectors`). */
export const declaredBy = (version: { details: { connectors?: DeclaredConnector[] } | null }) =>
  version.details?.connectors ?? [];

/** Every approval for these versions. */
export async function approvalsFor(db: Pick<Db, 'select'>, versionIds: string[]) {
  if (!versionIds.length) return [];
  return db
    .select()
    .from(creationVersionConnectors)
    .where(inArray(creationVersionConnectors.versionId, versionIds));
}

/** What a version declares that isn't approved yet (empty: it may go live). */
export function unapproved(declared: DeclaredConnector[], approvals: Approval[]) {
  return declared.flatMap((d) => {
    const ok = approvals.find((a) => a.connectorId === d.id)?.ops ?? [];
    const missing = d.ops.filter((op) => !ok.includes(op));
    return missing.length ? [{ id: d.id, ops: missing }] : [];
  });
}

/** Records an approval (adding to what was approved before for this version and connector). */
export async function approve(
  db: Pick<Db, 'insert' | 'update'>,
  versionId: string,
  connectors: { id: string; ops: string[] }[],
  by: string | null,
) {
  for (const c of connectors) {
    const ops = [...new Set(c.ops)];
    if (!ops.length) continue;
    const added = await db
      .update(creationVersionConnectors)
      .set({
        ops: sql`(select array_agg(distinct o order by o) from unnest(${creationVersionConnectors.ops} || ${sql.param(ops)}::text[]) as o)`,
        approvedBy: by,
        approvedAt: new Date(),
      })
      .where(
        and(
          eq(creationVersionConnectors.versionId, versionId),
          eq(creationVersionConnectors.connectorId, c.id),
        ),
      )
      .returning({ versionId: creationVersionConnectors.versionId });
    if (!added.length)
      await db
        .insert(creationVersionConnectors)
        .values({ versionId, connectorId: c.id, ops, approvedBy: by });
  }
}

/** A version's connectors as an Architect reviews them. */
export function reviewOf(
  declared: DeclaredConnector[],
  approvals: Approval[],
  registry: ConnectorRegistry,
): StudioVersionConnector[] {
  return declared.map((d) => {
    const installed = registry.get(d.id);
    const approval = approvals.find((a) => a.connectorId === d.id);
    return {
      ...d,
      displayName: installed?.def.displayName ?? null,
      operations: d.ops.map((name) => {
        const op = installed?.def.operations[name];
        return {
          name,
          kind: op?.kind ?? null,
          scope: op?.scope ?? null,
          method: op?.method ?? null,
        };
      }),
      approvedOps: approval?.ops ?? [],
      approvedAt: approval?.approvedAt.toISOString() ?? null,
    };
  });
}
