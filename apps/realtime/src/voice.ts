import { AccessToken, RoomServiceClient, TrackSource } from 'livekit-server-sdk';

/**
 * Voice chat passes (LiveKit). A pass lets one person talk and listen in one voice room for ten
 * minutes: the real-time service only hands one out for a room the person is in and may see, and
 * takes them out of it when they leave the room or may no longer see it.
 */
export class Voice {
  private readonly rooms: RoomServiceClient;
  private readonly config: { url: string; key: string; secret: string };

  constructor(config: { url: string; key: string; secret: string }) {
    this.config = config;
    this.rooms = new RoomServiceClient(config.url, config.key, config.secret);
  }

  static fromEnv(env: {
    LIVEKIT_URL?: string | undefined;
    LIVEKIT_API_KEY?: string | undefined;
    LIVEKIT_API_SECRET?: string | undefined;
  }): Voice | null {
    const { LIVEKIT_URL: url, LIVEKIT_API_KEY: key, LIVEKIT_API_SECRET: secret } = env;
    return url && key && secret ? new Voice({ url, key, secret }) : null;
  }

  /** A pass for `room`: the microphone only (no camera, screen or data). */
  pass(room: string, who: { id: string; name: string }): Promise<string> {
    const token = new AccessToken(this.config.key, this.config.secret, {
      identity: who.id,
      name: who.name,
      ttl: '10m',
    });
    token.addGrant({
      room,
      roomJoin: true,
      canPublish: true,
      canPublishSources: [TrackSource.MICROPHONE],
      canSubscribe: true,
      canPublishData: false,
      canUpdateOwnMetadata: false,
    });
    return token.toJwt();
  }

  /** Takes someone out of a voice room (fine if they weren't there). */
  remove(room: string, identity: string) {
    this.rooms.removeParticipant(room, identity).catch(() => {});
  }
}

/** The voice room of a room in a space: everyone in it hears each other. */
export const spaceVoiceRoom = (spaceId: string, room: string) => `space:${spaceId}:${room}`;
/** The voice room of one creation session. */
export const sessionVoiceRoom = (sessionId: string) => `session:${sessionId}`;
