import { Button } from '@ats/ui';
import type { SpaceViewer } from '@ats/viewer-core';
import { useEffect, useRef, useState } from 'react';
import { setSharing, sharing } from '../../lib/perf.ts';
import type { SoundPrefs } from '../../lib/sound.ts';

export function TravelMenu({
  viewer,
  sound,
  onSound,
  onClose,
  showPerf,
  onTogglePerf,
  onLeave,
  unread,
  onNotifications,
  onRequests,
}: {
  viewer: React.RefObject<SpaceViewer | null>;
  sound: SoundPrefs;
  onSound: (prefs: SoundPrefs) => void;
  onClose: () => void;
  showPerf: boolean;
  onTogglePerf: () => void;
  onLeave: () => void;
  unread: number;
  onNotifications: () => void;
  onRequests: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [share, setShare] = useState(sharing);
  const targets = viewer.current?.travelTargets() ?? [];
  const floors = [...new Set(targets.map((t) => t.floorName))];
  useEffect(() => {
    dialog.current?.showModal();
    if (document.pointerLockElement) document.exitPointerLock();
  }, []);
  return (
    <dialog ref={dialog} className="ats-sheet" onClose={onClose} aria-label="Menu">
      <div className="ats-stack space-travel">
        <div className="ats-row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <Button
            onClick={() => {
              dialog.current?.close();
              onNotifications();
            }}
          >
            Notifications{unread ? ` (${unread})` : ''}
          </Button>
          <Button
            onClick={() => {
              dialog.current?.close();
              onRequests();
            }}
          >
            My requests
          </Button>
        </div>
        <h2>Go to…</h2>
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
        <div className="space-sound">
          <h3>Sound</h3>
          <label className="space-sound-row">
            <input
              type="checkbox"
              checked={sound.on}
              onChange={(e) => onSound({ ...sound, on: e.target.checked })}
            />
            Footsteps, room sounds and message alerts
          </label>
          <label className="space-sound-row">
            <span>Volume</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={sound.volume}
              disabled={!sound.on}
              onChange={(e) => onSound({ ...sound, volume: Number(e.target.value) })}
            />
          </label>
        </div>
        <div className="space-sound">
          <h3>Smoothness</h3>
          <label className="space-sound-row">
            <input
              type="checkbox"
              checked={share}
              onChange={(e) => {
                setSharing(e.target.checked);
                setShare(e.target.checked);
              }}
            />
            Share how smoothly things run on this device, so everyone starts at the right quality.
            Anonymous, and it stays on this server.
          </label>
        </div>
        <div className="ats-row" style={{ justifyContent: 'space-between', marginTop: 8 }}>
          <Button variant="ghost" onClick={onTogglePerf}>
            {showPerf ? 'Hide' : 'Show'} performance
          </Button>
          <Button variant="ghost" onClick={onLeave}>
            Leave the space
          </Button>
          <Button variant="primary" onClick={() => dialog.current?.close()}>
            Close
          </Button>
        </div>
      </div>
    </dialog>
  );
}
