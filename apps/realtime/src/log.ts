import pino from 'pino';

/** The real-time service's messages, one JSON line each (like the server's). */
export const log = pino({ level: 'info' });
