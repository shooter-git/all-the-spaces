// Verifies every dev port is free (or already held by our own `ats-dev` stack).
// Never touches whatever else is using a port — it only reports and suggests an alternative.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';

const envFile = existsSync('.env') ? '.env' : '.env.example';
const env = Object.fromEntries(
  readFileSync(envFile, 'utf8')
    .split('\n')
    .map((line) => line.match(/^\s*([A-Z0-9_]+)=(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2].trim()]),
);
const ports = Object.entries(env)
  .filter(([key]) => key.startsWith('ATS_PORT_'))
  .map(([key, value]) => [key, Number(process.env[key] ?? value)]);

function ownedByUs() {
  try {
    const out = execFileSync(
      'docker',
      [
        'ps',
        '--filter',
        'label=com.docker.compose.project=ats-dev',
        '--format',
        '{{.Names}}|{{.Ports}}',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const ours = new Set([...out.matchAll(/:(\d+)->/g)].map((m) => Number(m[1])));
    // Our Caddy uses the host's network (so it has no published ports): its ports are ours too.
    if (/^ats-dev-caddy-\d+\|/m.test(out)) {
      for (const key of [
        'ATS_PORT_HTTP',
        'ATS_PORT_HTTPS',
        'ATS_PORT_TAILNET_APP',
        'ATS_PORT_TAILNET_PLAY',
      ])
        if (env[key]) ours.add(Number(env[key]));
    }
    return ours;
  } catch {
    return new Set();
  }
}

function isFree(port) {
  return new Promise((resolve) => {
    const srv = createServer()
      .once('error', () => resolve(false))
      .once('listening', () => srv.close(() => resolve(true)))
      .listen(port, '127.0.0.1');
  });
}

async function suggest(from, taken) {
  for (let p = 45000; p <= 45999; p++) {
    if (p !== from && !taken.has(p) && (await isFree(p))) return p;
  }
  return null;
}

const ours = ownedByUs();
const claimed = new Set(ports.map(([, p]) => p));
const problems = [];
for (const [key, port] of ports) {
  if (ours.has(port) || (await isFree(port))) continue;
  // Dev servers we run on the host (web/server/realtime) may already be up from a previous `pnpm dev`.
  problems.push([key, port, await suggest(port, claimed)]);
}

if (problems.length === 0) {
  console.log(`All ${ports.length} dev ports are available (${envFile}).`);
  process.exit(0);
}
console.error('These ports are already in use by something outside this project:');
for (const [key, port, alt] of problems) {
  console.error(`  ${key}=${port}${alt ? `  → try ${key}=${alt} in .env` : ''}`);
}
console.error('Nothing was stopped or changed. Edit .env and run again.');
process.exit(1);
