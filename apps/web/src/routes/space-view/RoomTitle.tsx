import { useEffect, useState } from 'react';

/** How long a room's name stays up after walking into it. */
export const ROOM_TITLE_MS = 3500;

/**
 * The room just walked into, named for a moment at the top of the screen and then gone, so the
 * view has the screen (the menu says where you are any time). It stays in the page while hidden,
 * so screen readers still hear each new room.
 */
export function RoomTitle({
  roomKey,
  name,
  under,
}: {
  roomKey: string;
  name: string;
  /** A smaller line under the name: the floor, or the space's name. */
  under?: string | null;
}) {
  const [shown, setShown] = useState(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: shows again for each new room
  useEffect(() => {
    setShown(true);
    const t = window.setTimeout(() => setShown(false), ROOM_TITLE_MS);
    return () => window.clearTimeout(t);
  }, [roomKey]);
  return (
    <div className="washi-glass space-room-title" data-shown={shown} aria-live="polite">
      <strong>{name}</strong>
      {under && <span>{under}</span>}
    </div>
  );
}
