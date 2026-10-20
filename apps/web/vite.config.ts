import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig, type HtmlTagDescriptor, loadEnv, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * Link previews (chat apps, social sites) need the picture's full address, and only the server
 * knows its own: in the built page, Caddy fills in the host (the `templates` directive in
 * deploy/compose/routes.caddy).
 */
export function absoluteOgImage(): Plugin {
  return {
    name: 'ats-absolute-og-image',
    apply: 'build',
    transformIndexHtml: (html) =>
      html.replace(
        '<meta property="og:image" content="/icons/og-image.png" />',
        '<meta property="og:image" content="https://{{.Host}}/icons/og-image.png" />',
      ),
  };
}

// Injects the generated iOS splash-screen <link> tags (see tools/brand-build.mjs).
function splashScreens(): Plugin {
  return {
    name: 'ats-splash-screens',
    transformIndexHtml() {
      const tags = JSON.parse(
        readFileSync('public/icons/head.json', 'utf8'),
      ) as HtmlTagDescriptor[];
      return tags.map((t) => ({ ...t, injectTo: 'head' }));
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../..', 'ATS_');
  const appHost = env.ATS_APP_HOST ?? 'app.ats.localhost';
  // Where browsers reach the app: *.localhost through Caddy, or the tailnet (`pnpm dev:tailnet`).
  const pub = new URL(env.ATS_PUBLIC_URL ?? `http://${appHost}:${env.ATS_PORT_HTTP ?? 45080}`);
  const secure = pub.protocol === 'https:';
  return {
    plugins: [
      react(),
      splashScreens(),
      absoluteOgImage(),
      VitePWA({
        // The manifest is served by the API so it can carry the group's own name and colour.
        manifest: false,
        injectRegister: false,
        registerType: 'prompt',
        workbox: {
          globPatterns: [
            '**/*.{js,css,html,woff2}',
            'icons/{favicon.svg,icon-192.png,badge-96.png}',
          ],
          // Reading PDFs is rare (adding a floor plan): fetched when used, not kept offline.
          // Nor three.js's texture transcoder (for places' KTX2 textures): places aren't kept offline.
          globIgnores: ['**/pdfjs-*.js', '**/pdf.worker*', '**/basis_transcoder*'],
          navigateFallback: '/index.html',
          navigateFallbackDenylist: [/^\/api\//, /^\/rt\//, /^\/manifest\.webmanifest$/],
          // Never cache API responses or private space data in the service worker.
          runtimeCaching: [],
          cleanupOutdatedCaches: true,
          // Shows push notifications and opens the app where they lead.
          importScripts: ['push-sw.js'],
        },
      }),
    ],
    server: {
      host: '127.0.0.1',
      allowedHosts: [appHost, pub.hostname],
      // The browser reaches Vite through Caddy (and Tailscale Serve, on the tailnet).
      hmr: {
        host: pub.hostname,
        clientPort: Number(pub.port || (secure ? 443 : 80)),
        protocol: secure ? 'wss' : 'ws',
      },
    },
    build: {
      // iOS 15.4 and later (docs/self-hosting.md).
      target: 'es2022',
      // Made for debugging, but not linked from the code: browsers never download them. The web
      // image leaves them out.
      sourcemap: 'hidden',
      rolldownOptions: {
        output: {
          // The big libraries each get a chunk of their own, loaded by the pages that use them
          // (and cached across releases that don't change them). Rolldown's form of manualChunks.
          // React has its own, first: a group takes its libraries' dependencies along, and React
          // would otherwise end up inside better-auth's chunk.
          codeSplitting: {
            groups: [
              {
                name: 'react',
                test: /[\\/]node_modules[\\/](react|react-dom|scheduler|react-router)[\\/]/,
              },
              // Named apart from the app's own pdf.ts, which is kept offline like every page. Only
              // PDF.js's code: the worker's address (`?url`) stays with pdf.ts, which needs it first.
              { name: 'pdfjs', test: /[\\/]node_modules[\\/]pdfjs-dist[\\/].*\.mjs$/ },
              { name: 'three', test: /[\\/]node_modules[\\/](three|three-mesh-bvh)[\\/]/ },
              { name: 'xterm', test: /[\\/]node_modules[\\/]@xterm[\\/]/ },
              { name: 'colyseus', test: /[\\/]node_modules[\\/]@colyseus[\\/]/ },
              {
                name: 'better-auth',
                test: /[\\/]node_modules[\\/](better-auth|@better-auth)[\\/]/,
              },
            ],
          },
        },
      },
    },
  };
});
