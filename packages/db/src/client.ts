import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.ts';

export function createDb(url: string) {
  const sql = postgres(url, { max: 10, onnotice: () => {} });
  return Object.assign(drizzle(sql, { schema }), { close: () => sql.end() });
}

export type Db = ReturnType<typeof createDb>;
