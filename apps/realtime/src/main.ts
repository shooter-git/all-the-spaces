import { loadRealtimeEnv } from '@ats/shared';
import { Server } from '@colyseus/core';
import { RedisDriver } from '@colyseus/redis-driver';
import { RedisPresence } from '@colyseus/redis-presence';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { onlyFromApp } from './cors.ts';
import { CreationRoom } from './creation-room.ts';
import { log } from './log.ts';
import { SpaceRoom } from './space-room.ts';
import { postVisits, VisitLog } from './visits.ts';
import { Voice } from './voice.ts';

// Real-time presence (SpaceRoom) and, from Phase 3, creation sessions. Shared presence in Valkey
// lets this service scale across processes.
const env = loadRealtimeEnv();
onlyFromApp(env.ATS_PUBLIC_URL);

// Colyseus serves its own HTTP routes, including GET /__healthcheck (used by Docker and Caddy).
const server = new Server({
  // Above the rooms' own limits, so oversized values get a polite refusal, not a disconnect.
  transport: new WebSocketTransport({ maxPayload: 64 * 1024 }),
  presence: new RedisPresence(env.VALKEY_URL),
  driver: new RedisDriver(env.VALKEY_URL),
  greet: false,
  gracefullyShutdown: true,
});

SpaceRoom.options = { secret: env.REALTIME_SECRET, serverUrl: env.SERVER_INTERNAL_URL };
// Voice chat, if this server has it (LiveKit): passes are handed out here, by the rooms that know
// who is where.
const voice = Voice.fromEnv(env);
SpaceRoom.voice = voice;
SpaceRoom.statsEvery = env.ATS_REALTIME_STATS;
CreationRoom.voice = voice;
// One live room per space.
server.define('space', SpaceRoom).filterBy(['spaceId', 'shard']);
// Creation sessions: shared ones are matched per creation version (so a session carries on with
// the version it started on); solo and invite sessions are private.
CreationRoom.options = { secret: env.REALTIME_SECRET };
server.define('creation', CreationRoom).filterBy(['creationId', 'versionId', 'mode']);

// Time people spend in each room and creation, for the group's Architects: coarse spans only,
// written by the server. Visits still going when this stops end now.
const visits = new VisitLog(postVisits(env.SERVER_INTERNAL_URL, env.REALTIME_SECRET)).begin();
SpaceRoom.visits = visits;
CreationRoom.visits = visits;
server.onShutdown(() => visits.stop());

await server.listen(env.ATS_PORT_REALTIME, env.HOST);
log.info({ port: env.ATS_PORT_REALTIME }, 'realtime listening');
