import type { Room } from '@ats/space-format';
import { useMemo } from 'react';
import { useVoiceChat, type VoiceTarget } from '../../components/VoiceButton.tsx';
import type { OpenedCreation } from '../../lib/creations.ts';
import type { Presence } from '../../lib/presence.ts';

/** The voice chat of the creation session you're in (`n` counts sessions, so each is new). */
export type SessionVoice = { n: number; pass: VoiceTarget['pass'] };

/** Voice chat: the room you're standing in, or the creation session you're in. */
export function useVoiceInSpace({
  journey,
  sessionVoice,
  presence,
  room,
  onProblem,
}: {
  /** The creation you're in, if any. */
  journey: { opened: OpenedCreation } | null;
  sessionVoice: SessionVoice | null;
  presence: Presence | null;
  room: Room | null;
  onProblem: (text: string) => void;
}) {
  const voiceTarget = useMemo<VoiceTarget | null>(() => {
    if (journey)
      return journey.opened.voice && sessionVoice
        ? { key: `session:${sessionVoice.n}`, pass: sessionVoice.pass }
        : null;
    if (!presence?.voice || !room) return null;
    return { key: `room:${room.key}`, pass: presence.voicePass, whereIs: presence.whereIs };
  }, [journey, sessionVoice, presence, room]);
  return useVoiceChat(voiceTarget, onProblem);
}
