// Shows or changes who owns this server in the app (ADR 0012): the one account that decides
// server-wide settings there, such as which repositories creations may come from. Used by
// `ats-admin owner`:
//
//   server-owner.ts          who it is
//   server-owner.ts EMAIL    hand it to that account (one of a group's Architects)
import { createDb } from '@ats/db';
import { loadServerEnv } from '@ats/shared';
import { getInstallState } from '../install-state.ts';
import { handServerTo, OwnerError, serverOwner } from '../owner.ts';

const [email] = process.argv.slice(2);
const env = loadServerEnv();
const db = createDb(env.DATABASE_URL);

try {
  const state = await getInstallState(db);
  if (!state?.setupCompletedAt)
    throw new OwnerError('finish setup first (open your space in a browser).');
  if (email) {
    const who = await handServerTo(db, email);
    console.log(`${who.name} (${who.email}) owns this server now.`);
  } else {
    const who = await serverOwner(db);
    console.log(
      who
        ? `This server's owner is ${who.name} (${who.email}).`
        : 'Nobody owns this server in the app yet. Hand it to an Architect with: sudo ats-admin owner EMAIL',
    );
  }
} catch (err) {
  if (!(err instanceof OwnerError)) throw err;
  console.error(`Sorry — ${err.message}`);
  process.exitCode = 1;
} finally {
  await db.close();
}
