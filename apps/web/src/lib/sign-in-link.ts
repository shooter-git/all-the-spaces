/**
 * Finds the assistant's sign-in link on the terminal screen, so a phone can open it with one tap
 * (a link wrapped over many lines is nearly impossible to select with a finger).
 *
 * It looks only at what's already on the screen, in this browser, and only for the assistants'
 * own sign-in pages: anything else a workspace prints (it runs AI-written code) never becomes a
 * button. Nothing it sees is kept or sent anywhere.
 */
// Checked against the CLIs themselves: Claude Code 2.1.285 signs subscriptions in at
// claude.com/cai/oauth/authorize and Console accounts at platform.claude.com.
const SIGN_IN_HOSTS = [
  'claude.com',
  'claude.ai',
  'platform.claude.com',
  'console.anthropic.com',
  'auth.openai.com',
  'chatgpt.com',
];
const LINK = new RegExp(
  `https://(?:${SIGN_IN_HOSTS.map((h) => h.replace(/\./g, '\\.')).join('|')})/[^\\s"'<>\\\\]+`,
  'g',
);

/** One row of the terminal: its text, and whether it carries on the row before (soft wrap). */
export interface ScreenLine {
  text: string;
  wrapped: boolean;
}

/**
 * The newest sign-in link on screen, or null. A link the terminal wrapped is put back together,
 * and so is one a program broke over rows itself: it runs to the end of its row, and the rows
 * after it are link and nothing else, each as long as the first (the width it was drawn at, which
 * may be narrower than this screen when a smaller one shares the session) until a shorter last
 * piece.
 */
export function findSignInLink(lines: ScreenLine[]): string | null {
  const logical: string[] = [];
  let width = 0;
  let open = false;
  for (const { text, wrapped } of lines) {
    const last = logical.length - 1;
    if (wrapped && last >= 0) {
      logical[last] += text;
      continue;
    }
    if (open && last >= 0 && /^\S+$/.test(text) && text.length <= width) {
      logical[last] += text;
      open = text.length === width;
      continue;
    }
    logical.push(text);
    width = text.length;
    open = /https:\/\/\S+$/.test(text);
  }
  for (let i = logical.length - 1; i >= 0; i--) {
    const found = (logical[i] as string).match(LINK);
    if (found) return trimEnd(found[found.length - 1] as string);
  }
  return null;
}

/** The terminal's buffer, as much of it as this needs (xterm's own, or the headless one). */
interface Buffer {
  length: number;
  getLine(
    y: number,
  ): { isWrapped: boolean; translateToString(trimRight?: boolean): string } | undefined;
}

/** The newest sign-in link in the last few hundred rows of a terminal's buffer. */
export function signInLinkOn(buffer: Buffer): string | null {
  const lines: ScreenLine[] = [];
  for (let y = Math.max(0, buffer.length - 300); y < buffer.length; y++) {
    const row = buffer.getLine(y);
    if (row) lines.push({ text: row.translateToString(true), wrapped: row.isWrapped });
  }
  return findSignInLink(lines);
}

/**
 * Whether a link is still on screen: its last few characters are (rows run together, so an end
 * split over two rows still counts). Used to let go of a link once the sign-in screen has gone.
 */
export function stillShown(buffer: Buffer, link: string): boolean {
  let text = '';
  for (let y = Math.max(0, buffer.length - 300); y < buffer.length; y++)
    text += buffer.getLine(y)?.translateToString(true) ?? '';
  return text.includes(link.slice(-12));
}

/** What an assistant shows while it waits for a sign-in (its link above, perhaps off screen). */
const WAITING_FOR_SIGN_IN = [/Paste code here if prompted/];

export function waitingForSignIn(buffer: Buffer): boolean {
  for (let y = Math.max(0, buffer.length - 60); y < buffer.length; y++) {
    const text = buffer.getLine(y)?.translateToString(true) ?? '';
    if (WAITING_FOR_SIGN_IN.some((re) => re.test(text))) return true;
  }
  return false;
}

/** Punctuation right after a link usually isn't part of it. */
const trimEnd = (url: string) => url.replace(/[).,;:!?]+$/, '');
