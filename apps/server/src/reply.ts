import type { FastifyReply } from 'fastify';

/** Replies with an error status and the `{ error }` body the web app shows people. */
export const sendError = (reply: FastifyReply, status: number, error: string) =>
  reply.code(status).send({ error });
