import { Button } from '@ats/ui';
import type { SpaceViewer } from '@ats/viewer-core';
import { useEffect, useRef } from 'react';

/** Every room in the space, floor by floor: a tap goes there. */
export function TravelMenu({
  viewer,
  onClose,
}: {
  viewer: React.RefObject<SpaceViewer | null>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const targets = viewer.current?.travelTargets() ?? [];
  const floors = [...new Set(targets.map((t) => t.floorName))];
  useEffect(() => {
    dialog.current?.showModal();
    if (document.pointerLockElement) document.exitPointerLock();
  }, []);
  return (
    <dialog ref={dialog} className="ats-sheet" onClose={onClose} aria-label="Go to another room">
      <div className="ats-stack space-travel">
        <h2>Go to another room</h2>
        {floors.map((floor) => (
          <div key={floor}>
            {floors.length > 1 && <h3>{floor}</h3>}
            <ul>
              {targets
                .filter((t) => t.floorName === floor)
                .map((t) => (
                  <li key={t.roomKey}>
                    <Button
                      block
                      onClick={() => {
                        viewer.current?.travelTo(t.roomKey);
                        dialog.current?.close();
                      }}
                    >
                      {t.roomName}
                    </Button>
                  </li>
                ))}
            </ul>
          </div>
        ))}
        <div className="ats-row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
          <Button variant="primary" onClick={() => dialog.current?.close()}>
            Close
          </Button>
        </div>
      </div>
    </dialog>
  );
}
