import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isBundlePath, playHeaders, typeOf } from '@ats/shared';

const here = dirname(fileURLToPath(import.meta.url));

/** The two browser scripts, bundled once per process. */
let scripts: Promise<{ host: string; instrument: string }> | null = null;
function browserScripts() {
  scripts ??= (async () => {
    const { build } = await import('vite');
    const bundle = async (entry: string, format: 'es' | 'iife') => {
      const out = await build({
        configFile: false,
        envDir: false,
        logLevel: 'silent',
        build: {
          write: false,
          minify: false,
          lib: {
            entry: join(here, 'browser', entry),
            formats: [format],
            name: 'qa',
            fileName: 'x',
          },
        },
      });
      const outputs = (Array.isArray(out) ? out : [out]) as { output: { code?: string }[] }[];
      return outputs[0]?.output[0]?.code ?? '';
    };
    return {
      host: await bundle('host.ts', 'es'),
      instrument: await bundle('instrument.ts', 'iife'),
    };
  })();
  return scripts;
}

const HOST_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>QA</title>
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; background: #f5f1ee; }
  iframe { position: fixed; inset: 0; width: 100%; height: 100%; border: 0; display: block; }
  .bar { position: fixed; top: 6px; left: 6px; z-index: 2; }
  .bar button { width: 44px; height: 44px; padding: 0; border: 0; background: none; display: grid; place-items: center; }
  .bar span { width: 34px; height: 34px; border-radius: 11px; border: 1px solid rgb(255 255 255 / 0.5);
    background: rgb(245 241 238 / 0.36); backdrop-filter: blur(14px); box-shadow: 0 2px 12px rgb(46 44 51 / 0.14);
    color: #2e2c33; font: 18px/32px system-ui, sans-serif; text-align: center; }
</style></head>
<body>
<iframe sandbox="allow-scripts allow-pointer-lock" allow="autoplay; fullscreen" referrerpolicy="no-referrer" title="Creation"></iframe>
<div class="bar"><button type="button" aria-label="Menu"><span>≡</span></button></div>
<script type="module" src="/host.js"></script>
</body></html>`;

export interface QaServer {
  /** The page to open: it shows the creation the way the app does. */
  url(opts: { title: string; tier: string }): string;
  playOrigin: string;
  close(): Promise<void>;
}

/**
 * Serves a built creation the way the play origin does (same headers, same sealed frame), with
 * the instrumentation added first in its page, next to a stand-in app page.
 */
export async function serveCreation(
  distDir: string,
  /** What the stand-in app answers connector calls with (the project's qa/connectors). */
  connectors: unknown = null,
): Promise<QaServer> {
  const { host, instrument } = await browserScripts();
  let appOrigin = '';
  let playOrigin = '';
  const server: Server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      const onPlay = req.headers.host === new URL(playOrigin).host;
      if (!onPlay) {
        if (url.pathname === '/host.js') {
          res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
          return res.end(host);
        }
        if (url.pathname === '/connectors.json') {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify(connectors));
        }
        if (url.pathname === '/') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          return res.end(HOST_PAGE);
        }
        res.writeHead(404);
        return res.end();
      }
      const base = `${playOrigin}/c/qa/`;
      const path = decodeURIComponent(url.pathname.replace(/^\/c\/qa\//, ''));
      if (path === '__qa/instrument.js') {
        res.writeHead(200, playHeaders('text/javascript; charset=utf-8', base, appOrigin));
        return res.end(instrument);
      }
      const type = typeOf(path);
      if (!url.pathname.startsWith('/c/qa/') || !isBundlePath(path) || !type) {
        res.writeHead(404);
        return res.end();
      }
      let body: Buffer | string = await readFile(join(distDir, path));
      if (path === 'index.html') {
        // Watch everything from the very start: the instrumentation runs before the creation.
        body = body
          .toString('utf8')
          .replace(/<head([^>]*)>/i, '<head$1><script src="__qa/instrument.js"></script>');
      }
      res.writeHead(200, playHeaders(type, base, appOrigin));
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  appOrigin = `http://app.qa.localhost:${port}`;
  playOrigin = `http://play.qa.localhost:${port}`;
  return {
    url: ({ title, tier }) =>
      `${appOrigin}/?${new URLSearchParams({ src: `${playOrigin}/c/qa/index.html`, title, tier })}`,
    playOrigin,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
