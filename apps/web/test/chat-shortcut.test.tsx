// @vitest-environment happy-dom
import type { SpaceManifest } from '@ats/space-format';
import type { SpaceViewer } from '@ats/viewer-core';
import { act, useCallback, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AskFlow } from '../src/components/AskFlow.tsx';
import { useChatShortcut } from '../src/lib/chat-shortcut.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// A space with the kinds of things that have focus in one, and the chat shortcut as SpaceView
// wires it (paused while asking for something).
const viewer = {
  pickObject: vi.fn(() => 'lamp'),
  objectsInBox: vi.fn(() => []),
  snapshot: vi.fn(() => Promise.reject(new Error('no snapshot here'))),
};
const manifest = {
  rooms: [{ key: 'hall', name: 'Hall', objects: [{ key: 'lamp', label: 'Lamp' }] }],
} as unknown as SpaceManifest;

function Space({ asking }: { asking: boolean }) {
  const [chatOpen, setChatOpen] = useState(false);
  const open = useCallback(() => setChatOpen(true), []);
  const close = useCallback(() => setChatOpen(false), []);
  useChatShortcut({ chatOpen, paused: asking, open, close });
  return (
    <div>
      <output data-testid="chat">{chatOpen ? 'open' : 'closed'}</output>
      <button type="button">Go to the kitchen</button>
      <a href="#kitchen">Kitchen</a>
      <div role="menuitem" tabIndex={0}>
        Rejoin
      </div>
      <select aria-label="Quality">
        <option>Smooth</option>
      </select>
      <div contentEditable suppressContentEditableWarning>
        A note
      </div>
      <input aria-label="Message" />
      <dialog open>
        <span>In a dialog</span>
      </dialog>
      {asking && (
        <AskFlow
          viewer={{ current: viewer as unknown as SpaceViewer }}
          spaceId="s1"
          manifest={manifest}
          byObject={new Map()}
          requested={{}}
          onDone={() => {}}
          onClose={() => {}}
        />
      )}
    </div>
  );
}

let container: HTMLElement;
let root: Root;
const chat = () => container.querySelector('[data-testid="chat"]')?.textContent;
/** Presses a key on `el`, the way a keyboard does (it bubbles up to the window). */
function press(el: Element, key: string) {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  act(() => {
    el.dispatchEvent(e);
  });
  return e;
}
async function render(asking: boolean) {
  await act(async () => root.render(<Space asking={asking} />));
}

describe('the chat shortcut in a space', () => {
  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('opens the chat with Enter on the space itself, and closes it with Escape', async () => {
    await render(false);
    expect(press(document.body, 'Enter').defaultPrevented).toBe(true);
    expect(chat()).toBe('open');
    press(document.body, 'Escape');
    expect(chat()).toBe('closed');
  });

  it('leaves Enter to buttons, links, widgets, choices, typing and dialogs', async () => {
    await render(false);
    for (const selector of [
      'button',
      'a',
      '[role="menuitem"]',
      'select',
      '[contenteditable]',
      'input',
      'dialog span',
    ]) {
      const el = container.querySelector(selector) as Element;
      // Not cancelled, so a focused button or link still does what it says.
      expect(press(el, 'Enter').defaultPrevented, selector).toBe(false);
      expect(chat(), selector).toBe('closed');
    }
  });

  it('while asking for something, Enter picks what is in the middle once and the chat stays shut', async () => {
    await render(true);
    const overlay = container.querySelector('[role="application"]') as Element;
    press(overlay, 'Enter');
    await act(async () => {});
    expect(viewer.pickObject).toHaveBeenCalledTimes(1);
    expect(chat()).toBe('closed');

    // Focus starts on its "What's in the middle" button: Enter is left for the button to press.
    await render(false);
    await render(true);
    const middle = [...container.querySelectorAll('[role="application"] button')].find((b) =>
      b.textContent?.includes("What's in the middle"),
    ) as Element;
    expect(press(middle, 'Enter').defaultPrevented).toBe(false);
    expect(chat()).toBe('closed');
  });
});
