// Opens the dev app to your own devices on your tailnet, over HTTPS with a trusted certificate
// (Tailscale Serve), so phones need nothing installed: `pnpm dev:tailnet on | off | status`.
//
// On: Tailscale Serve sends https://<this machine>.<tailnet>.ts.net:45481 (the app) and :45482
// (creations, a separate origin) to Caddy's loopback tailnet ports, and .env's public URLs point
// there; voice chat's audio ports are published on this machine's tailnet address. Off: removes exactly those two Serve entries and puts the URLs back. Nothing else in the
// Tailscale configuration is touched, and only devices on your tailnet can reach it.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const ENV = '.env';
const SAVED = '.env.tailnet-saved';
const KEYS = ['ATS_PUBLIC_URL', 'ATS_PLAY_URL', 'ATS_VOICE_IP'];
const [command = 'status'] = process.argv.slice(2);

const read = () => readFileSync(ENV, 'utf8');
const env = Object.fromEntries(
  read()
    .split('\n')
    .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]),
);
const setEnv = (values) => {
  let text = read();
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    text = new RegExp(`^${key}=.*$`, 'm').test(text)
      ? text.replace(new RegExp(`^${key}=.*$`, 'm'), line)
      : `${text.replace(/\n?$/, '\n')}${line}\n`;
  }
  writeFileSync(ENV, text);
};

const tailscale = (...args) =>
  execFileSync('tailscale', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
function machine() {
  try {
    return JSON.parse(tailscale('status', '--json')).Self.DNSName.replace(/\.$/, '');
  } catch {
    console.error('Tailscale is not installed or not connected on this machine.');
    process.exit(1);
  }
}
const serveConfig = () => {
  try {
    return JSON.parse(tailscale('serve', 'status', '--json') || '{}');
  } catch {
    return {};
  }
};

// Tailnet HTTPS port → Caddy's loopback port for it.
const routes = [
  ['app', Number(env.ATS_TAILNET_APP_HTTPS ?? 45481), Number(env.ATS_PORT_TAILNET_APP ?? 45084)],
  ['play', Number(env.ATS_TAILNET_PLAY_HTTPS ?? 45482), Number(env.ATS_PORT_TAILNET_PLAY ?? 45085)],
];
const host = machine();
const target = (local) => `http://127.0.0.1:${local}`;
/** What a tailnet port serves now: null if nothing, else its proxy target (or "something else"). */
function serving(config, port) {
  if (!config.TCP?.[String(port)]) return null;
  return config.Web?.[`${host}:${port}`]?.Handlers?.['/']?.Proxy ?? 'something else';
}
/** This machine's tailnet address (voice chat's audio goes straight to it). */
const tailnetIp = () => tailscale('ip', '-4').trim().split('\n')[0];
const recreateCaddy = () =>
  execFileSync(
    'docker',
    [
      'compose',
      '-p',
      'ats-dev',
      '-f',
      'deploy/compose/compose.dev.yml',
      '--env-file',
      ENV,
      'up',
      '-d',
      '--no-deps',
      '--force-recreate',
      'caddy',
      'livekit',
    ],
    { stdio: 'ignore' },
  );
const isOn = () => env.ATS_PUBLIC_URL?.startsWith(`https://${host}:`);

if (command === 'on') {
  const config = serveConfig();
  for (const [name, port, local] of routes) {
    const now = serving(config, port);
    if (now && now !== target(local)) {
      console.error(
        `Tailnet port ${port} already serves ${now}. Pick a free one for ${name} in .env ` +
          `(ATS_TAILNET_${name.toUpperCase()}_HTTPS) and run this again.`,
      );
      process.exit(1);
    }
  }
  for (const [, port, local] of routes)
    tailscale('serve', '--bg', `--https=${port}`, target(local));
  if (!isOn())
    writeFileSync(SAVED, JSON.stringify(Object.fromEntries(KEYS.map((k) => [k, env[k]]))));
  const [app, play] = routes.map(([, port]) => `https://${host}:${port}`);
  // The localhost address redirects here meanwhile (sign-ins only work at one address).
  setEnv({
    ATS_PUBLIC_URL: app,
    ATS_PLAY_URL: play,
    ATS_VOICE_IP: tailnetIp(),
    ATS_TAILNET_APP_URL: app,
  });
  recreateCaddy();
  console.log(`On. Restart \`pnpm dev\`, then open ${app}`);
  console.log('on this computer or any phone signed in to your Tailscale (with Tailscale on).');
  console.log('Sign in again there; `pnpm dev:tailnet off` goes back to the localhost address.');
} else if (command === 'off') {
  const config = serveConfig();
  for (const [, port, local] of routes)
    if (serving(config, port) === target(local)) tailscale('serve', `--https=${port}`, 'off');
  const saved = existsSync(SAVED) ? JSON.parse(readFileSync(SAVED, 'utf8')) : {};
  setEnv({
    ATS_PUBLIC_URL: saved.ATS_PUBLIC_URL ?? `http://${env.ATS_APP_HOST}:${env.ATS_PORT_HTTP}`,
    ATS_PLAY_URL: saved.ATS_PLAY_URL ?? `http://${env.ATS_PLAY_HOST}:${env.ATS_PORT_HTTP}`,
    ATS_VOICE_IP: saved.ATS_VOICE_IP ?? '127.0.0.1',
    ATS_TAILNET_APP_URL: '',
  });
  rmSync(SAVED, { force: true });
  recreateCaddy();
  console.log(
    `Off. Restart \`pnpm dev\`, then open http://${env.ATS_APP_HOST}:${env.ATS_PORT_HTTP}`,
  );
} else if (command === 'status') {
  const config = serveConfig();
  console.log(isOn() ? `On: ${env.ATS_PUBLIC_URL}` : `Off: ${env.ATS_PUBLIC_URL}`);
  for (const [name, port, local] of routes) {
    const now = serving(config, port);
    console.log(
      `  ${name}: https://${host}:${port} → ${now === target(local) ? `Caddy :${local}` : (now ?? 'not served')}`,
    );
  }
} else {
  console.log('Usage: pnpm dev:tailnet on | off | status');
  process.exitCode = 2;
}
