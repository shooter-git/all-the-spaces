import { readFile } from 'node:fs/promises';
import { Terminal } from '@xterm/headless';
import { describe, expect, it } from 'vitest';
import {
  findSignInLink,
  type ScreenLine,
  signInLinkOn,
  stillShown,
  waitingForSignIn,
} from '../src/lib/sign-in-link.ts';

/** A screen of `cols` columns showing `text` the way a terminal wraps it. */
function wrap(text: string, cols: number, soft: boolean): ScreenLine[] {
  const out: ScreenLine[] = [];
  for (let i = 0; i < text.length; i += cols)
    out.push({ text: text.slice(i, i + cols), wrapped: soft && i > 0 });
  return out;
}
const line = (text: string): ScreenLine => ({ text, wrapped: false });

// The shape Claude Code 2.1.285 prints for a Claude subscription.
const URL_ =
  'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference&code_challenge=b3kFDNLqOHLMiYfGuo_tbpopD2O3eR-6Ntt0UqiIbM8&code_challenge_method=S256&state=B1NQcQWkobT_RaNN8k7U3M3UGeqkOVofz056pP1HkoQ';

describe('findSignInLink', () => {
  it('puts back together a link the terminal wrapped over many rows', () => {
    const screen = [
      line(' Browser didn’t open? Use the url below to sign in:'),
      line(''),
      ...wrap(URL_, 46, true),
      line(''),
      line('  Paste code here if prompted >'),
    ];
    expect(findSignInLink(screen)).toBe(URL_);
  });

  it('and one a program broke over full-width rows itself', () => {
    const screen = [line('Sign in:'), ...wrap(URL_, 46, false), line('  Paste code here >')];
    expect(findSignInLink(screen)).toBe(URL_);
  });

  it('follows a link drawn narrower than this screen (a smaller one shares the session)', () => {
    const rows = wrap(URL_, 40, false).map((r) => ({ ...r, text: r.text }));
    const screen = [line('Sign in:'), ...rows, line(''), line('  Paste code here >')];
    expect(findSignInLink(screen)).toBe(URL_);
  });

  it('stops at the end of the link, not at the next word', () => {
    const screen = [...wrap(URL_, 46, false), line('Continue'), line('  Paste code here >')];
    expect(findSignInLink(screen)).toBe(URL_);
  });

  it('takes the newest, and leaves punctuation after it', () => {
    const screen = [
      line('Old: https://claude.ai/oauth/authorize?state=old'),
      line('Open https://auth.openai.com/codex/device.'),
    ];
    expect(findSignInLink(screen)).toBe('https://auth.openai.com/codex/device');
  });

  it('never offers a link to anywhere else', () => {
    const screen = [
      line('https://claude.ai.evil.example/oauth/authorize'),
      line('https://claude.com.evil.example/cai/oauth/authorize'),
      line('https://notclaude.com/cai/oauth/authorize'),
      line('https://example.com/login'),
      line('http://claude.ai/oauth/authorize'),
    ];
    expect(findSignInLink(screen)).toBeNull();
  });
});

describe('on the real screen', () => {
  it('finds Claude Code 2.1.285’s own sign-in link, whole, at the width it was drawn', async () => {
    // Recorded from the installed Claude Code (a throwaway session, never signed in) on a
    // 46-column terminal: it breaks the link over full rows itself.
    const recording = await readFile(
      new URL('./fixtures/claude-code-2.1.285-login-46cols.bin', import.meta.url),
    );
    const term = new Terminal({ cols: 46, rows: 40, allowProposedApi: true });
    await new Promise<void>((done) => term.write(new Uint8Array(recording), done));
    const link = signInLinkOn(term.buffer.active);
    expect(link).toMatch(/^https:\/\/claude\.com\/cai\/oauth\/authorize\?code=true&client_id=/);
    expect(link).toMatch(/&state=[\w-]+$/);
    expect(new URL(link as string).searchParams.get('redirect_uri')).toBe(
      'https://platform.claude.com/oauth/code/callback',
    );

    // While its sign-in screen shows, a link it copied is still there; then it isn't.
    expect(stillShown(term.buffer.active, link as string)).toBe(true);
    expect(waitingForSignIn(term.buffer.active)).toBe(true);
    await new Promise<void>((done) =>
      term.write('\x1b[3J\x1b[2J\x1b[HLogin successful.\r\n', done),
    );
    expect(stillShown(term.buffer.active, link as string)).toBe(false);
    expect(waitingForSignIn(term.buffer.active)).toBe(false);
    term.dispose();
  });
});
