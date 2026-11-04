import type { Browser } from 'playwright';
import { describe, expect, it } from 'vitest';
import { VIEWPORTS, warmUp } from '../src/harness/run.ts';
import type { QaServer } from '../src/harness/serve.ts';

const server: QaServer = {
  url: () => 'http://app.qa.localhost:1/',
  playOrigin: 'http://play.qa.localhost:1',
  close: async () => {},
};
const phone = VIEWPORTS[0];
const never = () => new Promise<never>(() => {});

/**
 * A browser with one page, which opens as `goto` does and answers each look at the app's log as
 * `look` does (with how many looks came before). Closing its context ends whatever it's waiting
 * for, as Playwright's does.
 */
function browser(
  page: { goto?: () => Promise<unknown>; look?: (n: number) => Promise<number | null> },
  newContext?: () => Promise<never>,
) {
  const seen = { contexts: [] as unknown[], closed: 0, looks: 0 };
  const stub = {
    seen,
    newContext:
      newContext ??
      (async (options: unknown) => {
        seen.contexts.push(options);
        let closed = false;
        const waiting: ((err: Error) => void)[] = [];
        const until = <T>(p: Promise<T>) =>
          new Promise<T>((resolve, reject) => {
            if (closed) return reject(new Error('Target page, context or browser has been closed'));
            waiting.push(reject);
            p.then(resolve, reject);
          });
        return {
          route: async () => {},
          newPage: async () => ({
            goto: () => until(page.goto?.() ?? Promise.resolve(null)),
            evaluate: () =>
              until((page.look ?? (async () => 0))(seen.looks++)).then((readyAt) => ({ readyAt })),
            waitForTimeout: (ms: number) => until(new Promise((r) => setTimeout(r, ms))),
          }),
          close: async () => {
            if (closed) return;
            closed = true;
            seen.closed++;
            for (const reject of waiting)
              reject(new Error('Target page, context or browser has been closed'));
          },
        };
      }),
  };
  return stub as typeof stub & Pick<Browser, 'newContext'>;
}

const opts = (said: string[]) => ({
  title: 'Creation',
  tier: 'low' as const,
  say: (line: string) => said.push(line),
});

describe('warming the browser up before the first screen', () => {
  it('opens it once, the size of the first screen, until it is ready, then closes it', async () => {
    const b = browser({ look: async (n) => (n < 3 ? null : 6123.4) });
    const said: string[] = [];
    expect(await warmUp(b, server, phone, opts(said))).toBe(6123);
    expect(b.seen.contexts).toEqual([
      {
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
        deviceScaleFactor: 1,
      },
    ]);
    expect(b.seen.closed).toBe(1);
    expect(said).toEqual([
      'Warming the browser up: opening it once at 390×844, not timed',
      'Warming the browser up: ready in 6.1 s',
    ]);
  });

  it('stops at its cap for a creation that never gets ready, and looks no more', async () => {
    const b = browser({ look: async () => null });
    const said: string[] = [];
    const started = Date.now();
    expect(await warmUp(b, server, phone, opts(said), 400)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(b.seen.closed).toBe(1);
    expect(said.at(-1)).toMatch(/stopped after \d+ s, before it was ready$/);
    const looks = b.seen.looks;
    await new Promise((r) => setTimeout(r, 300));
    expect(b.seen.looks).toBe(looks);
  });

  it('stops at its cap while the page is too busy to answer, or never finishes opening', async () => {
    for (const b of [browser({ look: never }), browser({ goto: never })]) {
      const started = Date.now();
      expect(await warmUp(b, server, phone, opts([]), 400)).toBeNull();
      expect(Date.now() - started).toBeLessThan(1000);
      expect(b.seen.closed).toBe(1);
    }
  });

  it('never fails the run: what goes wrong is left for the screens to find', async () => {
    const broken = browser({
      goto: () => Promise.reject(new Error('net::ERR_CONNECTION_REFUSED')),
    });
    const said: string[] = [];
    expect(await warmUp(broken, server, phone, opts(said), 400)).toBeNull();
    expect(broken.seen.closed).toBe(1);
    expect(said.at(-1)).toBe("Warming the browser up: it didn't get ready");

    const gone = browser({}, () => Promise.reject(new Error('Browser has been closed')));
    expect(await warmUp(gone, server, phone, opts([]), 400)).toBeNull();
  });
});
