// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Terminal } from '../src/components/Terminal.tsx';
import { FakeSocket } from './helpers/fakes.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** xterm.js stand-in: focusing it focuses its hidden text box, as the real one does. */
const xterm = vi.hoisted(() => {
  class FakeTerm {
    static all: FakeTerm[] = [];
    options = { theme: { background: '#fbf9f7' } };
    cols = 80;
    rows = 24;
    buffer = { active: { length: 0, getLine: () => undefined }, normal: {} };
    textarea: HTMLTextAreaElement | null = null;
    focused = 0;
    constructor() {
      FakeTerm.all.push(this);
    }
    open(el: HTMLElement) {
      this.textarea = document.createElement('textarea');
      el.append(this.textarea);
    }
    focus() {
      this.focused++;
      this.textarea?.focus();
    }
    loadAddon() {}
    onWriteParsed() {
      return { dispose() {} };
    }
    onData() {
      return { dispose() {} };
    }
    onResize() {
      return { dispose() {} };
    }
    write() {}
    paste() {}
    dispose() {
      this.textarea?.remove();
    }
  }
  return { FakeTerm };
});
vi.mock('@xterm/xterm', () => ({ Terminal: xterm.FakeTerm }));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}));
vi.mock('@xterm/addon-clipboard', () => ({
  ClipboardAddon: class {},
  BrowserClipboardProvider: class {},
}));

let container: HTMLElement;
let root: Root;

/** A phone (coarse pointer) or a computer (fine pointer). */
function on(device: 'phone' | 'computer') {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(pointer: fine)' ? device === 'computer' : false,
    addEventListener() {},
    removeEventListener() {},
  }));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  xterm.FakeTerm.all = [];
  FakeSocket.all = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const connect = () => act(() => FakeSocket.last?.accept());

describe('the terminal connecting', () => {
  it("doesn't take focus on a phone, so the keyboard doesn't pop up over the page", () => {
    on('phone');
    act(() => root.render(<Terminal target="ws-1" />));
    connect();
    expect(xterm.FakeTerm.all.at(-1)?.focused).toBe(0);
  });

  it('is ready to type on a computer', () => {
    on('computer');
    act(() => root.render(<Terminal target="ws-1" />));
    connect();
    expect(xterm.FakeTerm.all.at(-1)?.focused).toBe(1);
  });

  it('on a phone, keeps the keyboard up when it reconnects while you were typing', () => {
    on('phone');
    act(() => root.render(<Terminal target="ws-1" />));
    connect();
    // A tap on the terminal: its text box gets focus.
    act(() => xterm.FakeTerm.all.at(-1)?.textarea?.focus());
    act(() => FakeSocket.last?.close());
    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(FakeSocket.all).toHaveLength(2);
    connect();
    expect(xterm.FakeTerm.all.at(-1)?.focused).toBe(1);
  });

  it("on a phone, doesn't reconnect into focus when you weren't typing", () => {
    on('phone');
    act(() => root.render(<Terminal target="ws-1" />));
    connect();
    act(() => FakeSocket.last?.close());
    act(() => {
      vi.advanceTimersByTime(700);
    });
    connect();
    expect(xterm.FakeTerm.all.map((t) => t.focused)).toEqual([0, 0]);
  });
});
