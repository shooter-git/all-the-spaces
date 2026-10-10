import { useRef, useState } from 'react';
import type { AskTarget } from '../../components/AskFlow.tsx';
import type { ObjectRequests } from '../../lib/requests.ts';

/** Requests shown over the space, and asking for something yourself. */
export function useRequestsOverlay() {
  /** What's been asked for on objects you can see, and the one you're pointing at. */
  const [requested, setRequested] = useState<ObjectRequests>({});
  const [pointed, setPointed] = useState<{ key: string; label: string } | null>(null);
  /** Asking for something (drawing a box), or writing a change/problem for a creation. */
  const [ask, setAsk] = useState<{ start?: AskTarget } | null>(null);
  const requestedRef = useRef(requested);
  requestedRef.current = requested;
  return { requested, setRequested, pointed, setPointed, ask, setAsk, requestedRef };
}
