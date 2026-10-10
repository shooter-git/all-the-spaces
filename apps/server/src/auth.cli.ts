// Used only by `pnpm auth:generate` to emit the Drizzle schema for Better Auth's tables.
import { createDb } from '@ats/db';
import { createAuth } from './auth.ts';

export const auth = createAuth({
  db: createDb('postgres://unused@localhost/unused'),
  secret: 'x'.repeat(32),
  publicUrl: 'http://app.ats.localhost',
});
