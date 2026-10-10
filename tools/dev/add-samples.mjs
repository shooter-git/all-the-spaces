// Dev helper: adds both sample spaces to the dev group using the local dev Architect account.
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split('\n')
    .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]),
);
const base = env.ATS_PUBLIC_URL;
const signIn = await fetch(`${base}/api/auth/sign-in/email`, {
  method: 'POST',
  headers: { origin: base, 'content-type': 'application/json' },
  body: JSON.stringify({ email: env.DEV_ARCHITECT_EMAIL, password: env.DEV_ARCHITECT_PASSWORD }),
});
const cookie = signIn.headers
  .getSetCookie()
  .map((c) => c.split(';')[0])
  .join('; ');
const me = await (await fetch(`${base}/api/me`, { headers: { cookie } })).json();
const groupId = me.groups[0].groupId;
for (const sample of ['studio-apartment', 'two-floor-building']) {
  const res = await fetch(`${base}/api/groups/${groupId}/sample-spaces`, {
    method: 'POST',
    headers: { cookie, origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ sample }),
  });
  console.log(sample, res.status, (await res.json()).spaceId);
}
