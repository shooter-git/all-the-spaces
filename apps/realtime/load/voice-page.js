// Runs inside each test person's browser page (voice-check.ts), after livekit-client's UMD build:
// joins voice with a fake microphone and keeps track of who it hears.
/* global LivekitClient */
window.voice = { heard: new Set(), talking: new Set(), left: new Set(), room: null };

window.voiceJoin = async (url, token) => {
  const L = LivekitClient;
  const v = window.voice;
  const room = new L.Room();
  room.on(L.RoomEvent.TrackSubscribed, (track, _pub, who) => {
    if (track.kind !== 'audio') return;
    v.heard.add(who.identity);
    track.attach();
  });
  room.on(L.RoomEvent.ParticipantDisconnected, (who) => v.left.add(who.identity));
  room.on(L.RoomEvent.ActiveSpeakersChanged, (speakers) => {
    for (const s of speakers) if (!s.isLocal) v.talking.add(s.identity);
  });
  await room.connect(url, token);
  await room.localParticipant.setMicrophoneEnabled(true);
  v.room = room;
};

/** Bytes of sound received from everyone else so far. */
window.voiceBytes = async () => {
  let total = 0;
  for (const who of window.voice.room.remoteParticipants.values())
    for (const pub of who.audioTrackPublications.values()) {
      const stats = await pub.track?.getReceiverStats();
      total += stats?.bytesReceived ?? 0;
    }
  return total;
};
