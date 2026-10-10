// @vitest-environment happy-dom
import { act, type ReactNode, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pictures } from '../src/components/Pictures.tsx';
import { RejoinCard } from '../src/routes/SpaceView.tsx';
import { PublishDialog } from '../src/routes/Workspace.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;
/** happy-dom has no :modal; showModal() being called is what makes a dialog modal. */
let modal: () => boolean;
const button = (label: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(label));
const dialog = () => container.querySelector('dialog');

beforeEach(() => {
  const shown = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
  modal = () => shown.mock.contexts.at(-1) === dialog() && Boolean(dialog()?.open);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

/** A button that opens a dialog, as the pages have. */
function Opener({ label, dialog }: { label: string; dialog: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        {label}
      </button>
      {open && dialog(() => setOpen(false))}
    </>
  );
}

/** Opens with the keyboard's focus on the opener, as a keyboard user would. */
function openWith(label: string) {
  const opener = button(label) as HTMLButtonElement;
  opener.focus();
  act(() => opener.click());
  return opener;
}

describe('dialogs', () => {
  it('Publish is a modal dialog; Cancel closes it and focus goes back to Publish', () => {
    const publish = vi.fn();
    act(() =>
      root.render(
        <Opener
          label="Publish…"
          dialog={(close) => <PublishDialog onClose={close} onPublish={publish} />}
        />,
      ),
    );
    const opener = openWith('Publish…');
    expect(modal()).toBe(true);
    expect(dialog()?.getAttribute('aria-labelledby')).toBe('publish-title');
    act(() => button('Cancel')?.click());
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(publish).not.toHaveBeenCalled();
  });

  it('a large picture is a modal dialog; closing it returns focus to its thumbnail', () => {
    const pictures = [{ name: 'hall-corner-1', kind: 'room', path: 'p1', at: Date.now() }];
    act(() =>
      root.render(
        <Pictures
          workspaceId="w1"
          pictures={pictures as Parameters<typeof Pictures>[0]['pictures']}
        />,
      ),
    );
    const thumbnail = container.querySelector('.pictures-grid button') as HTMLButtonElement;
    thumbnail.focus();
    act(() => thumbnail.click());
    expect(modal()).toBe(true);
    expect(dialog()?.getAttribute('aria-label')).toBe('Hall, corner 1');
    act(() => button('Close')?.click());
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(thumbnail);
  });

  it('the Rejoin card is a modal dialog; Not now closes it and gives focus back', () => {
    const notNow = vi.fn();
    act(() =>
      root.render(
        <Opener
          label="Play"
          dialog={(close) => (
            <RejoinCard
              title="Marbles"
              onNotNow={() => {
                notNow();
                close();
              }}
              onRejoin={() => {}}
            />
          )}
        />,
      ),
    );
    const opener = openWith('Play');
    expect(modal()).toBe(true);
    act(() => button('Not now')?.click());
    expect(notNow).toHaveBeenCalledOnce();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
