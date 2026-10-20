import { Button } from '@ats/ui';
import { useEffect, useRef, useState } from 'react';
import { setSharing, sharing } from '../../lib/perf.ts';
import type { SoundPrefs } from '../../lib/sound.ts';

/** Sound in the space, sharing how smoothly it runs, and the numbers for how it's running. */
export function SpaceSettings({
  sound,
  onSound,
  showPerf,
  onTogglePerf,
  onClose,
}: {
  sound: SoundPrefs;
  onSound: (prefs: SoundPrefs) => void;
  showPerf: boolean;
  onTogglePerf: () => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [share, setShare] = useState(sharing);
  useEffect(() => {
    dialog.current?.showModal();
    if (document.pointerLockElement) document.exitPointerLock();
  }, []);
  return (
    <dialog ref={dialog} className="ats-sheet" onClose={onClose} aria-label="Sound and settings">
      <div className="ats-stack space-travel">
        <h2>Sound and settings</h2>
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
          <Button variant="primary" onClick={() => dialog.current?.close()}>
            Close
          </Button>
        </div>
      </div>
    </dialog>
  );
}
