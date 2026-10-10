import type { SpaceManifest } from '@ats/space-format';
import { Button } from '@ats/ui';
import { useEffect, useRef } from 'react';
import type { ChatPerson } from '../../lib/chat.ts';
import type { OnlinePerson } from '../../lib/presence.ts';

export function PeopleSheet({
  people,
  reconnecting,
  manifest,
  chatPeople,
  myId,
  speaking,
  onGoTo,
  onMessage,
  onClose,
}: {
  people: OnlinePerson[];
  /** Live presence dropped and is getting back in. */
  reconnecting: boolean;
  manifest: SpaceManifest;
  chatPeople: ChatPerson[];
  myId: string | null;
  /** Talking in voice chat right now (user ids). */
  speaking: string[];
  onGoTo: (roomKey: string) => void;
  onMessage: (userId: string) => void;
  onClose: () => void;
}) {
  const busy = new Set(chatPeople.filter((p) => p.dnd).map((p) => p.id));
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
    if (document.pointerLockElement) document.exitPointerLock();
  }, []);
  const visible = (key: string) => manifest.rooms.some((r) => r.key === key);
  const roomName = (key: string) =>
    manifest.rooms.find((r) => r.key === key)?.name ??
    (key === 'private' ? 'In a private area' : 'Arriving…');
  return (
    <dialog ref={dialog} className="ats-sheet" onClose={onClose} aria-label="People here">
      <div className="ats-stack">
        <h2>People here</h2>
        {people.length === 0 ? (
          <p className="ats-muted">{reconnecting ? 'Reconnecting…' : 'Connecting…'}</p>
        ) : (
          <ul className="ats-stack" style={{ listStyle: 'none', margin: 0, padding: 0, gap: 8 }}>
            {people.map((p) => (
              <li key={p.sessionId} className="ats-row" style={{ justifyContent: 'space-between' }}>
                <span className="ats-row" style={{ gap: 10 }}>
                  <span
                    aria-hidden="true"
                    style={{ width: 12, height: 12, borderRadius: '50%', background: p.color }}
                  />
                  <span>
                    {p.name}
                    <br />
                    <span className="ats-muted" style={{ fontSize: '0.85rem' }}>
                      {roomName(p.room)}
                      {busy.has(p.id) && ' · Do not disturb'}
                      {speaking.includes(p.id) && ' · talking'}
                    </span>
                  </span>
                </span>
                <span className="ats-row" style={{ gap: 6 }}>
                  {p.id !== myId && myId && (
                    <Button
                      variant="ghost"
                      onClick={() => {
                        dialog.current?.close();
                        onMessage(p.id);
                      }}
                    >
                      Message
                    </Button>
                  )}
                  {visible(p.room) && p.id !== myId && (
                    <Button
                      onClick={() => {
                        onGoTo(p.room);
                        dialog.current?.close();
                      }}
                    >
                      Go to
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
        <Button variant="primary" onClick={() => dialog.current?.close()}>
          Close
        </Button>
      </div>
    </dialog>
  );
}
