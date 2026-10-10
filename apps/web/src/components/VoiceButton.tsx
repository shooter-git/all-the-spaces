import { Icon } from '@ats/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { sound } from '../lib/sound.ts';
// Voice chat (and LiveKit with it) only loads when someone first chooses to talk.
import type { VoiceChannel } from '../lib/voice.ts';

export type VoiceStatus = 'off' | 'joining' | 'on' | 'muted';

/** Where voice chat goes: the room you're in, or the creation session you're in. */
export interface VoiceTarget {
  /** Changes when you move to another voice room. */
  key: string;
  pass: () => Promise<{ token: string } | { error: string }>;
  /** Voices come from where people stand (the space); without it they're simply heard. */
  whereIs?: (userId: string) => { x: number; y: number; z: number } | null;
}

/**
 * Voice chat that follows you: on once you choose to talk, then into each room (or session) you
 * go into. Other sound dips while people talk.
 */
export function useVoiceChat(target: VoiceTarget | null, onProblem: (text: string) => void) {
  const [status, setStatus] = useState<VoiceStatus>('off');
  const [speaking, setSpeaking] = useState<string[]>([]);
  const channel = useRef<VoiceChannel | null>(null);
  /** The person wants voice on (it rejoins as they move). */
  const wanted = useRef(false);
  const mic = useRef(true);
  const targetRef = useRef(target);
  targetRef.current = target;
  const problem = useRef(onProblem);
  problem.current = onProblem;

  const connect = useCallback(async () => {
    const t = targetRef.current;
    await channel.current?.leave();
    channel.current = null;
    if (!t) return setStatus('off');
    setStatus('joining');
    const answer = await t.pass();
    if (targetRef.current?.key !== t.key) return; // moved on meanwhile
    if ('error' in answer) {
      setStatus('off');
      if (answer.error === 'off') {
        wanted.current = false;
        problem.current("Voice chat isn't on here.");
      }
      return;
    }
    const { VoiceChannel } = await import('../lib/voice.ts');
    if (targetRef.current?.key !== t.key) return;
    const c = new VoiceChannel({
      context: sound.context(),
      ...(t.whereIs ? { whereIs: t.whereIs } : {}),
      onSpeaking: setSpeaking,
      onDisconnected: () => {
        if (channel.current === c) setStatus('off');
      },
    });
    channel.current = c;
    try {
      await c.join(answer.token);
      await c.setMic(mic.current);
    } catch (e) {
      // No microphone (or not allowed): still listen.
      if ((e as Error).name === 'NotAllowedError' || (e as Error).name === 'NotFoundError') {
        mic.current = false;
        problem.current('No microphone: you can listen, and turn it on in your browser to talk.');
      } else {
        setStatus('off');
        problem.current("Couldn't join voice chat. Try again in a moment.");
        return;
      }
    }
    setStatus(mic.current ? 'on' : 'muted');
  }, []);

  // Into each new room (or session) while voice is on; out of it when there's nowhere to talk.
  // biome-ignore lint/correctness/useExhaustiveDependencies: follows the voice room, by its key
  useEffect(() => {
    if (wanted.current) void connect();
  }, [target?.key, connect]);
  useEffect(
    () => () => {
      void channel.current?.leave();
    },
    [],
  );
  // Voices follow the people who speak.
  useEffect(() => {
    if (status !== 'on' && status !== 'muted') return;
    const t = window.setInterval(() => channel.current?.place(), 100);
    return () => window.clearInterval(t);
  }, [status]);
  // Everything else dips while someone talks.
  useEffect(() => {
    sound.duck(speaking.length > 0);
  }, [speaking]);
  useEffect(() => () => sound.duck(false), []);

  return {
    status,
    speaking,
    start: () => {
      wanted.current = true;
      mic.current = true;
      void connect();
    },
    toggleMic: () => {
      mic.current = !mic.current;
      setStatus(mic.current ? 'on' : 'muted');
      channel.current?.setMic(mic.current).catch(() => {
        mic.current = false;
        setStatus('muted');
      });
    },
    stop: () => {
      wanted.current = false;
      setSpeaking([]);
      setStatus('off');
      void channel.current?.leave();
      channel.current = null;
    },
  };
}

/** Talk / Mute, and leaving voice chat. */
export function VoiceButton({ voice }: { voice: ReturnType<typeof useVoiceChat> }) {
  const others = voice.speaking.length;
  if (voice.status === 'off' || voice.status === 'joining')
    return (
      <button
        type="button"
        className="space-icon-button"
        onClick={voice.start}
        disabled={voice.status === 'joining'}
        aria-label="Join voice chat"
      >
        <Icon name="mic" />
        <span className="space-wide-only">{voice.status === 'joining' ? 'Joining…' : 'Talk'}</span>
      </button>
    );
  return (
    <span className="voice-controls">
      <button
        type="button"
        className="space-icon-button voice-mic"
        data-on={voice.status === 'on'}
        onClick={voice.toggleMic}
        aria-label={voice.status === 'on' ? 'Mute your microphone' : 'Unmute your microphone'}
      >
        <Icon name={voice.status === 'on' ? 'mic' : 'micOff'} />
        <span className="space-wide-only">{voice.status === 'on' ? 'Mute' : 'Unmute'}</span>
        {others > 0 && (
          <span className="voice-talking" aria-hidden="true">
            {' '}
            · {others} talking
          </span>
        )}
      </button>
      <button
        type="button"
        className="space-icon-button"
        onClick={voice.stop}
        aria-label="Leave voice chat"
        title="Leave voice chat"
      >
        <Icon name="close" />
      </button>
    </span>
  );
}
