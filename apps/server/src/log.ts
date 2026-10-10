import type { FastifyBaseLogger } from 'fastify';

/** Where the server's own messages go: the app's logger (pino), also outside requests. */
export type Log = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;

/** For code run without an app (tests, one-off tools): says nothing. */
export const silent: Log = { info() {}, warn() {}, error() {} };
