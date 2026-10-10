import pino from 'pino';

/** The supervisor's messages, one JSON line each (like the server's). */
export const log = pino({ level: 'info' });

/** What the API logs with (tests pass their own). */
export type Log = Pick<typeof log, 'info'>;
