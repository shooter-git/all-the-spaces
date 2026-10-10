import { type Db, schema } from '@ats/db';

/** One entry in the audit log (never terminal content or secrets). */
export type AuditEntry = Omit<typeof schema.auditLog.$inferInsert, 'id' | 'createdAt'>;

/** Adds an entry to the audit log; pass the transaction when it belongs to one. */
export const record = (db: Pick<Db, 'insert'>, entry: AuditEntry) =>
  db.insert(schema.auditLog).values(entry);
