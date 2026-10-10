// Prints a fresh one-time setup code (only while setup is unfinished).
// Used by the installer and by `ats-admin setup-code`.
import { createDb } from '@ats/db';
import { loadServerEnv } from '@ats/shared';
import { getInstallState, resetSetupCode } from '../install-state.ts';

const env = loadServerEnv();
const db = createDb(env.DATABASE_URL);
try {
  const state = await getInstallState(db);
  if (state?.setupCompletedAt) {
    console.log('Setup is already finished. Sign in at', env.ATS_PUBLIC_URL);
  } else {
    const code = await resetSetupCode(db, env.BETTER_AUTH_SECRET);
    console.log(`Setup code: ${code}`);
    console.log(`Open ${env.ATS_PUBLIC_URL}/setup and enter it to finish installing.`);
  }
} finally {
  await db.close();
}
