import { type Db, schema } from '@ats/db';
import { eq } from 'drizzle-orm';
import { generateSetupCode, hashSetupCode } from './setup-code.ts';

const { installState } = schema;

export async function getInstallState(db: Db) {
  const [row] = await db.select().from(installState).where(eq(installState.id, 1));
  return row;
}

/**
 * Makes sure an unfinished installation has a setup code. Returns the plain code only when a new
 * one was created (it is shown once, in the server log, and only its hash is stored).
 */
export async function ensureSetupCode(db: Db, secret: string): Promise<string | null> {
  const state = await getInstallState(db);
  if (state?.setupCompletedAt || state?.setupCodeHash) return null;
  const code = generateSetupCode();
  await db
    .insert(installState)
    .values({ id: 1, setupCodeHash: hashSetupCode(code, secret) })
    .onConflictDoUpdate({
      target: installState.id,
      set: { setupCodeHash: hashSetupCode(code, secret) },
    });
  return code;
}

export async function resetSetupCode(db: Db, secret: string): Promise<string> {
  const code = generateSetupCode();
  await db
    .insert(installState)
    .values({ id: 1, setupCodeHash: hashSetupCode(code, secret) })
    .onConflictDoUpdate({
      target: installState.id,
      set: { setupCodeHash: hashSetupCode(code, secret) },
    });
  return code;
}
