import { Button, Icon, Section } from '@ats/ui';
import { useRef } from 'react';
import { useInstall } from '../lib/pwa.ts';

/** Offers to put the space on the home screen, with a step-by-step guide on iPhone and iPad. */
export function InstallCard({ name }: { name: string }) {
  const install = useInstall();
  const dialog = useRef<HTMLDialogElement>(null);
  if (install.mode === 'installed' || install.mode === 'unavailable') return null;

  return (
    <Section title="Add to your home screen">
      <p className="ats-muted">{name} opens full-screen like an app, in portrait or landscape.</p>
      <div>
        {install.mode === 'prompt' ? (
          <Button onClick={install.install}>
            <Icon name="download" size={16} />
            Install
          </Button>
        ) : (
          <Button onClick={() => dialog.current?.showModal()}>
            <Icon name="info" size={16} />
            Show me how
          </Button>
        )}
      </div>
      <dialog ref={dialog} className="ats-sheet" aria-label="How to add to your home screen">
        <div className="ats-stack">
          <h2>Add to Home Screen</h2>
          <ol style={{ margin: 0, paddingLeft: '1.25rem', lineHeight: 1.8 }}>
            <li>
              Tap the <strong>Share</strong> button (the square with an arrow).
            </li>
            <li>
              Scroll down and tap <strong>Add to Home Screen</strong>.
            </li>
            <li>
              Tap <strong>Add</strong>. {name} will appear with your other apps.
            </li>
          </ol>
          <Button block onClick={() => dialog.current?.close()}>
            Got it
          </Button>
        </div>
      </dialog>
    </Section>
  );
}
