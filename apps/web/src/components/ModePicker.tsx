import { Button, Icon } from '@ats/ui';
import { useEffect, useRef } from 'react';
import type { CreationInfo, SessionMode } from '../lib/creations.ts';
import { DoorArt } from './DoorArt.tsx';
import './mode-picker.css';

/**
 * The door into a creation: a little artwork that keeps what's inside a surprise, what it's
 * called, who's inside, and how to go in (on your own, with whoever's there, or with people you
 * invite).
 */
export function ModePicker({
  creation,
  where,
  onPick,
  onClose,
  onAsk,
}: {
  creation: CreationInfo;
  /** Where it lives, e.g. "Bookshelf · Bedroom 1". */
  where?: string | null;
  onPick: (mode: SessionMode) => void;
  onClose: () => void;
  /** Suggest a change to it, or say something's wrong (goes to the Architects). */
  onAsk?: ((kind: 'improve' | 'bug') => void) | undefined;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
    body.current?.focus();
    if (document.pointerLockElement) document.exitPointerLock();
  }, []);
  const pick = (mode: SessionMode) => {
    dialog.current?.close();
    onPick(mode);
  };
  const together = creation.playing > 0;
  return (
    <dialog
      ref={dialog}
      className="ats-sheet portal-sheet"
      onClose={onClose}
      aria-label={creation.title}
    >
      <DoorArt />
      {/* Focus starts on the dialog itself, not on a button (no ring until someone uses the keys). */}
      <div className="portal-body" tabIndex={-1} ref={body}>
        <header className="portal-head">
          {where && <span className="portal-where">{where}</span>}
          <h2>{creation.title}</h2>
          {creation.description && <p className="ats-muted">{creation.description}</p>}
          {together && (
            <p className="portal-inside">
              <span className="portal-dots" aria-hidden="true">
                {Array.from({ length: Math.min(3, creation.playing) }, (_, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: identical dots
                  <i key={i} />
                ))}
              </span>
              {creation.playing === 1 ? 'Someone is inside' : `${creation.playing} people inside`}
            </p>
          )}
        </header>
        <div className="portal-actions">
          {together && (
            <Button variant="primary" block onClick={() => pick('shared')}>
              <Icon name="people" size={16} />
              Join {creation.playing === 1 ? 'them' : `the ${creation.playing}`}
            </Button>
          )}
          <Button
            variant={together ? 'secondary' : 'primary'}
            block
            onClick={() =>
              pick(together ? 'solo' : creation.defaultMode === 'solo' ? 'solo' : 'shared')
            }
          >
            <Icon name={together ? 'account' : 'enter'} size={16} />
            {together ? 'Go in on my own' : 'Go in'}
          </Button>
          {!together && creation.defaultMode !== 'solo' && (
            <Button block onClick={() => pick('solo')}>
              <Icon name="account" size={16} />
              Go in on my own
            </Button>
          )}
        </div>
        <footer className="portal-foot">
          {onAsk && (
            <div className="mode-ask">
              <button
                type="button"
                onClick={() => {
                  dialog.current?.close();
                  onAsk('improve');
                }}
              >
                <Icon name="edit" size={14} />
                Suggest a change
              </button>
              <span aria-hidden="true">·</span>
              <button
                type="button"
                onClick={() => {
                  dialog.current?.close();
                  onAsk('bug');
                }}
              >
                <Icon name="alert" size={14} />
                Something’s wrong
              </button>
            </div>
          )}
          <Button variant="ghost" onClick={() => dialog.current?.close()}>
            Not now
          </Button>
        </footer>
      </div>
    </dialog>
  );
}
