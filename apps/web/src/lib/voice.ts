import {
  type Participant,
  type RemoteAudioTrack,
  type RemoteParticipant,
  type RemoteTrack,
  Room,
  RoomEvent,
  Track,
} from 'livekit-client';

/**
 * Voice chat (LiveKit): the people in one voice room hear each other. In the space that's the
 * room you're standing in, and each voice comes from where that person is; in a creation it's
 * the session. Passes come from the real-time service, which only hands them out for rooms you
 * may hear. Nothing is recorded, and creations never get the sound (it plays out here).
 */
export interface VoiceOptions {
  context: AudioContext;
  /** Where someone is (by user id), for voices that come from where people stand. */
  whereIs?: (identity: string) => { x: number; y: number; z: number } | null;
  /** Who else is talking right now (user ids): for ducking other sound, and showing it. */
  onSpeaking?: (identities: string[]) => void;
  /** Lost the connection (it tries again by itself), or it ended. */
  onDisconnected?: () => void;
}

export class VoiceChannel {
  private room: Room | null = null;
  private readonly panners = new Map<string, PannerNode>();
  private readonly options: VoiceOptions;
  micOn = false;

  constructor(options: VoiceOptions) {
    this.options = options;
  }

  get connected() {
    return this.room?.state === 'connected';
  }

  /** Joins a voice room with a pass (leaving any other first). */
  async join(token: string) {
    await this.leave();
    const { context } = this.options;
    const room = new Room({
      webAudioMix: { audioContext: context },
      audioCaptureDefaults: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    room.on(
      RoomEvent.TrackSubscribed,
      (track: RemoteTrack, _publication, participant: RemoteParticipant) => {
        if (track.kind !== Track.Kind.Audio) return;
        // Placed where they stand (in the space); otherwise simply heard (a creation's session).
        if (this.options.whereIs) {
          const panner = context.createPanner();
          panner.panningModel = 'HRTF';
          panner.distanceModel = 'inverse';
          panner.refDistance = 1.5;
          panner.maxDistance = 25;
          panner.rolloffFactor = 1;
          (track as RemoteAudioTrack).setWebAudioPlugins([panner]);
          this.panners.set(participant.identity, panner);
        }
        track.attach();
      },
    );
    room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, _p, participant: Participant) => {
      track.detach();
      this.panners.delete(participant.identity);
    });
    room.on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
      this.options.onSpeaking?.(speakers.filter((s) => !s.isLocal).map((s) => s.identity));
    });
    room.on(RoomEvent.Disconnected, () => {
      if (this.room === room) this.options.onDisconnected?.();
    });
    this.room = room;
    await room.connect(`${window.location.origin}/lk`, token, { autoSubscribe: true });
    if (this.micOn) await room.localParticipant.setMicrophoneEnabled(true);
  }

  /** Turns your microphone on or off (the browser asks permission the first time). */
  async setMic(on: boolean) {
    this.micOn = on;
    await this.room?.localParticipant.setMicrophoneEnabled(on);
  }

  /**
   * Puts each voice where its person stands (10 times a second). The listener is wherever the
   * space's own sound puts it: your head.
   */
  place() {
    const { context, whereIs } = this.options;
    if (!whereIs) return;
    const t = context.currentTime;
    for (const [identity, panner] of this.panners) {
      const at = whereIs(identity);
      if (!at) continue;
      panner.positionX.setTargetAtTime(at.x, t, 0.05);
      panner.positionY.setTargetAtTime(at.y + 1.6, t, 0.05);
      panner.positionZ.setTargetAtTime(at.z, t, 0.05);
    }
  }

  async leave() {
    const room = this.room;
    this.room = null;
    this.panners.clear();
    this.options.onSpeaking?.([]);
    await room?.disconnect();
  }
}
