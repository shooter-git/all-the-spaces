import { BrowserClipboardProvider, ClipboardAddon } from '@xterm/addon-clipboard';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { Icon, IconButton, type IconName } from '@ats/ui';
import { useEffect, useRef, useState } from 'react';
import { closeSocket } from '../lib/live.ts';
import { findSignInLink, signInLinkOn, stillShown, waitingForSignIn } from '../lib/sign-in-link.ts';
import './terminal.css';

const KEYS: { label: string | IconName; icon?: true; seq: string; aria: string }[] = [
  { label: 'Esc', seq: '\x1b', aria: 'Escape' },
  { label: 'Tab', seq: '\t', aria: 'Tab' },
  { label: '^C', seq: '\x03', aria: 'Control C (stop)' },
  { label: 'back', icon: true, seq: '\x1b[D', aria: 'Left' },
  { label: 'arrowUp', icon: true, seq: '\x1b[A', aria: 'Up' },
  { label: 'arrowDown', icon: true, seq: '\x1b[B', aria: 'Down' },
  { label: 'arrowRight', icon: true, seq: '\x1b[C', aria: 'Right' },
  { label: 'Enter', seq: '\r', aria: 'Enter' },
];

/**
 * A terminal in a sandbox: what's typed goes straight to it and what it prints comes straight
 * back (the app never keeps or sends it anywhere). On phones a key bar adds the keys phone
 * keyboards lack, a message box for typing or dictating, and an assistant's sign-in link on screen
 * gets a button (see sign-in-link.ts).
 */
export function Terminal({ target, onActivity }: { target: string; onActivity?: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const socket = useRef<WebSocket | null>(null);
  const term = useRef<XTerm | null>(null);
  const [state, setState] = useState<'connecting' | 'open' | 'closed'>('connecting');
  const [attempt, setAttempt] = useState(0);
  /** The assistant's sign-in link, while it's on screen. */
  const [signIn, setSignIn] = useState<string | null>(null);
  /** A sign-in link the assistant copied (Claude Code's "c to copy"), while its screen shows. */
  const [copiedLink, setCopiedLink] = useState<string | null>(null);
  const [hidden, setHidden] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  /**
   * The message box (phones): dictation and autocorrect revise what they've typed as they go,
   * which a terminal can't take back (each revision arrived as more text). Written here first,
   * the message reaches the terminal once, finished.
   */
  const [composing, setComposing] = useState(false);
  const [message, setMessage] = useState('');
  const messageBox = useRef<HTMLTextAreaElement>(null);
  // A dropped connection (the network blinked) comes back by itself a few times before asking.
  const retries = useRef(0);
  /** How far back in the session's history a swipe has scrolled (0: the live screen). */
  const back = useRef(0);
  const [scrolled, setScrolled] = useState(false);
  /** When the session was last asked for again to bring a sign-in link's start (see look). */
  const refetched = useRef(0);
  /** The person was typing in the terminal when it reconnected (keep the keyboard up). */
  const typing = useRef(false);
  // Kept in a ref so a new callback never reconnects the terminal.
  const activity = useRef(onActivity);
  activity.current = onActivity;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` reconnects on purpose
  useEffect(() => {
    if (!box.current) return;
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    const t = new XTerm({
      fontFamily: '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace',
      fontSize: matchMedia('(max-width: 600px)').matches ? 12 : 13.5,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: false,
      theme: dark
        ? {
            background: '#1c1b21',
            foreground: '#eeebf0',
            cursor: '#a9bfd9',
            selectionBackground: '#3a4655',
          }
        : {
            background: '#fbf9f7',
            foreground: '#2e2c33',
            cursor: '#3f5b7c',
            selectionBackground: '#d7e0ea',
          },
    });
    const fit = new FitAddon();
    t.loadAddon(fit);
    // Text copied in the terminal session (tmux, the assistant) reaches the browser's clipboard;
    // a sign-in link copied that way also gets the button. The session can never read the
    // clipboard: a workspace runs AI-written code.
    const browserClipboard = new BrowserClipboardProvider();
    t.loadAddon(
      new ClipboardAddon(undefined, {
        readText: () => '',
        writeText: async (selection, text) => {
          const link = findSignInLink([{ text: text.trim(), wrapped: false }]);
          if (link === text.trim()) setCopiedLink(link);
          await Promise.resolve(browserClipboard.writeText(selection, text)).catch(() => {});
        },
      }),
    );
    t.open(box.current);
    // The whole box in the terminal's colour (round its text, and under the last row).
    box.current.style.background = t.options.theme?.background ?? '';
    fit.fit();
    term.current = t;
    // Look for a sign-in link on screen a moment after output settles (only here, in the page).
    let looking: number | undefined;
    const look = () => {
      const screen = t.buffer.active;
      let found = signInLinkOn(screen);
      // tmux draws on the alternate screen; the history a joining screen gets first is in the
      // normal one. A link from there counts only while its (unique) end is still on screen.
      if (!found && screen !== t.buffer.normal) {
        const earlier = signInLinkOn(t.buffer.normal);
        if (earlier && stillShown(screen, earlier)) found = earlier;
      }
      setSignIn(found);
      setCopiedLink((link) => (link && stillShown(screen, link) ? link : null));
      // Waiting for a sign-in whose link has scrolled off a small screen: join the session again
      // (the history comes first), at most once a minute.
      if (!found && waitingForSignIn(screen) && Date.now() - refetched.current > 60_000) {
        refetched.current = Date.now();
        setAttempt((n) => n + 1);
      }
    };
    const parsed = t.onWriteParsed(() => {
      window.clearTimeout(looking);
      looking = window.setTimeout(look, 250);
    });
    const url = new URL('/api/studio/terminal', window.location.href);
    url.protocol = url.protocol.replace('http', 'ws');
    url.searchParams.set('target', target);
    url.searchParams.set('cols', String(t.cols));
    url.searchParams.set('rows', String(t.rows));
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    socket.current = ws;
    const encoder = new TextEncoder();
    let retry: number | undefined;
    ws.onopen = () => {
      retries.current = 0;
      setState('open');
      // Ready to type on a keyboard. On a phone, focusing pops the keyboard up over the page, so
      // only when the person was already typing here; otherwise a tap on the terminal does it.
      if (matchMedia('(pointer: fine)').matches || typing.current) t.focus();
    };
    ws.onclose = () => {
      if (retries.current >= 3) return setState('closed');
      retries.current++;
      setState('connecting');
      retry = window.setTimeout(() => setAttempt((n) => n + 1), 700 * retries.current);
    };
    ws.onmessage = (e) => t.write(new Uint8Array(e.data as ArrayBuffer));
    back.current = 0;
    setScrolled(false);
    const input = t.onData((d) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      toLive(ws);
      const bytes = encoder.encode(d);
      for (let i = 0; i < bytes.length; i += 8192) ws.send(bytes.subarray(i, i + 8192));
      activity.current?.();
    });
    const resize = t.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    });
    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {}
    });
    observer.observe(box.current);

    // A swipe scrolls the session's history (tmux keeps it; a finger can't send tmux a scroll
    // wheel), or the assistant's own conversation when it scrolls itself (the supervisor decides).
    // One message every 80 ms at most, with however many rows the finger moved.
    const screen = box.current;
    let lastY: number | null = null;
    let carry = 0;
    let pending = 0;
    let flushing: number | undefined;
    const flush = () => {
      flushing = undefined;
      if (pending && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'scroll', lines: pending }));
        back.current = Math.max(0, back.current + pending);
        setScrolled(back.current > 0);
      }
      pending = 0;
    };
    const touchStart = (e: TouchEvent) => {
      lastY = e.touches.length === 1 ? (e.touches[0]?.clientY ?? null) : null;
      carry = 0;
    };
    const touchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY;
      if (lastY === null || y === undefined || e.touches.length !== 1) return;
      carry += y - lastY;
      lastY = y;
      const row = screen.clientHeight / Math.max(1, t.rows);
      const lines = Math.trunc(carry / row);
      if (lines) {
        carry -= lines * row;
        pending += lines; // the finger moving down shows what came before
        flushing ??= window.setTimeout(flush, 80);
      }
      e.preventDefault();
    };
    const touchEnd = () => {
      lastY = null;
    };
    screen.addEventListener('touchstart', touchStart, { passive: true });
    screen.addEventListener('touchmove', touchMove, { passive: false });
    screen.addEventListener('touchend', touchEnd);
    return () => {
      screen.removeEventListener('touchstart', touchStart);
      screen.removeEventListener('touchmove', touchMove);
      screen.removeEventListener('touchend', touchEnd);
      window.clearTimeout(flushing);
      observer.disconnect();
      input.dispose();
      resize.dispose();
      window.clearTimeout(retry);
      window.clearTimeout(looking);
      parsed.dispose();
      typing.current = screen.contains(document.activeElement);
      ws.onopen = null;
      ws.onclose = null;
      ws.onmessage = null;
      closeSocket(ws);
      t.dispose();
      term.current = null;
    };
  }, [target, attempt]);

  /** Back to the live screen first, so what's typed reaches the assistant (not tmux). */
  const toLive = (ws: WebSocket) => {
    if (back.current <= 0 || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'live' }));
    back.current = 0;
    setScrolled(false);
  };
  const send = (seq: string) => {
    const ws = socket.current;
    if (ws?.readyState === WebSocket.OPEN) {
      toLive(ws);
      ws.send(new TextEncoder().encode(seq));
    }
    term.current?.focus();
  };
  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) term.current?.paste(text);
    } catch {
      term.current?.focus();
    }
  };

  /** Puts the message into the terminal as one paste; `andSend` presses Enter after it. */
  const deliver = (andSend: boolean) => {
    // Nothing that could end the paste early or act as a key.
    const text = [...message]
      .filter((c) => c === '\n' || c === '\t' || (c >= ' ' && c !== '\u007f'))
      .join('')
      .trimEnd();
    if (!text || socket.current?.readyState !== WebSocket.OPEN) return;
    term.current?.paste(text);
    // Enter as its own key press, just after the paste (the assistant then sends it).
    if (andSend) window.setTimeout(() => send('\r'), 120);
    else term.current?.focus();
    setMessage('');
    setComposing(false);
  };

  const link = signIn ?? copiedLink;
  const copyLink = async () => {
    if (!link) return;
    await navigator.clipboard.writeText(link).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      },
      () => {},
    );
  };

  return (
    <div className="terminal">
      {link && link !== hidden && (
        <div className="terminal-signin" role="status">
          <span className="terminal-signin-text">
            <Icon name="key" size={16} />
            Your assistant wants you to sign in.
          </span>
          <a
            className="ats-button ats-button--primary"
            href={link}
            target="_blank"
            rel="noopener noreferrer"
          >
            <Icon name="externalLink" size={16} />
            Open the sign-in page
          </a>
          <IconButton
            icon={copied ? 'check' : 'copy'}
            label={copied ? 'Copied' : 'Copy the sign-in link'}
            onClick={() => void copyLink()}
          />
          <IconButton icon="close" label="Hide this" onClick={() => setHidden(link)} />
        </div>
      )}
      <div className="terminal-screen" ref={box} />
      {scrolled && (
        <button
          type="button"
          className="ats-button ats-button--primary terminal-live"
          onClick={() => {
            if (socket.current) toLive(socket.current);
            term.current?.focus();
          }}
        >
          <Icon name="arrowDown" size={16} />
          Live
        </button>
      )}
      {state === 'closed' && (
        <div className="terminal-closed">
          <p>The terminal disconnected.</p>
          <button
            type="button"
            className="ats-button ats-button--primary"
            onClick={() => setAttempt((n) => n + 1)}
          >
            Reconnect
          </button>
        </div>
      )}
      {composing && (
        <div className="terminal-compose">
          <textarea
            ref={messageBox}
            className="terminal-compose-text"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setComposing(false);
            }}
            placeholder="Type or dictate a message"
            aria-label="Message for the terminal"
            rows={3}
            autoCapitalize="sentences"
            autoCorrect="on"
            spellCheck
            enterKeyHint="enter"
          />
          <div className="terminal-compose-actions">
            <IconButton
              icon="close"
              label="Close the message box"
              onClick={() => setComposing(false)}
            />
            <button
              type="button"
              className="ats-button ats-button--ghost"
              disabled={!message.trim()}
              onClick={() => deliver(false)}
            >
              Add to terminal
            </button>
            <button
              type="button"
              className="ats-button ats-button--primary"
              disabled={!message.trim()}
              onClick={() => deliver(true)}
            >
              <Icon name="send" size={16} />
              Send
            </button>
          </div>
        </div>
      )}
      <div className="terminal-keys" role="toolbar" aria-label="Terminal keys">
        <button
          type="button"
          aria-pressed={composing}
          onClick={() => {
            setComposing((open) => !open);
            // Focused straight away, so the keyboard (and its microphone) comes up.
            window.setTimeout(() => messageBox.current?.focus(), 0);
          }}
        >
          <Icon name="edit" size={16} />
          Message
        </button>
        {KEYS.map((k) => (
          <button key={k.aria} type="button" aria-label={k.aria} onClick={() => send(k.seq)}>
            {k.icon ? <Icon name={k.label as IconName} size={16} /> : k.label}
          </button>
        ))}
        <button type="button" onClick={() => void paste()}>
          <Icon name="copy" size={16} />
          Paste
        </button>
      </div>
    </div>
  );
}
