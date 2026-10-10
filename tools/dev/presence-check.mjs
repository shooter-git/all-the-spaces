// Dev helper: two people in the same space. The member walks; the Architect should see them.
//   node tools/dev/presence-check.mjs <spaceId> <outDir>
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const [spaceId, outDir = '.data/shots'] = process.argv.slice(2);
const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split('\n')
    .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]),
);
const base = env.ATS_PUBLIC_URL;
const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
});

async function person(email, password, { signUpWithInvite } = {}) {
  const context = await browser.newContext({ viewport: { width: 960, height: 540 } });
  const headers = { origin: base };
  if (signUpWithInvite) {
    const res = await context.request.post(`${base}/api/auth/sign-up/email`, {
      headers: { ...headers, 'x-ats-invite': signUpWithInvite },
      data: { name: 'Sam Member', email, password },
    });
    if (res.ok())
      await context.request.post(`${base}/api/invites/accept`, {
        headers,
        data: { token: signUpWithInvite },
      });
  }
  const signIn = await context.request.post(`${base}/api/auth/sign-in/email`, {
    headers,
    data: { email, password },
  });
  if (!signIn.ok()) throw new Error(`sign-in failed for ${email}: ${signIn.status()}`);
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`[${email}] page error:`, e.message));
  await page.goto(`${base}/space/${spaceId}`);
  await page.waitForFunction(() => window.__atsViewer?.isReady, null, { timeout: 90_000 });
  return { context, page };
}

const architect = await person(env.DEV_ARCHITECT_EMAIL, env.DEV_ARCHITECT_PASSWORD);
// Make sure the member account exists (an invite from the Architect, used once).
const me = await (await architect.context.request.get(`${base}/api/me`)).json();
const invite = await architect.context.request.post(
  `${base}/api/groups/${me.groups[0].groupId}/invite-links`,
  {
    headers: { origin: base },
    data: { maxUses: 1 },
  },
);
const token = new URL((await invite.json()).url).hash.slice(1);
const member = await person(env.DEV_MEMBER_EMAIL, env.DEV_MEMBER_PASSWORD, {
  signUpWithInvite: token,
});

// Put the Architect in the lobby looking into the room, and walk the member in front of them.
await architect.page.evaluate(() => {
  window.__atsViewer.teleport([4, 0, 5.2], 0);
});
await member.page.evaluate(() => {
  window.__atsViewer.teleport([2.5, 0, 2.5], -Math.PI / 2);
});
await member.page.keyboard.down('KeyW');
await member.page.waitForTimeout(1500);
await member.page.keyboard.up('KeyW');
await architect.page.waitForTimeout(1500);

const seen = await architect.page.evaluate(() => ({
  avatars: window.__atsViewer.avatars.count,
  people: document.querySelector('[aria-label^="People here"]')?.textContent,
}));
console.log('Architect sees:', JSON.stringify(seen));
await architect.page.screenshot({ path: `${outDir}/presence-architect.png` });

// Interest management: send the member to the upper floor; the Architect should stop receiving them.
await member.page.evaluate(() => window.__atsViewer.travelTo('quiet'));
await architect.page.waitForTimeout(2000);
const afterAway = await architect.page.evaluate(() => ({
  avatars: window.__atsViewer.avatars.count,
  people: document.querySelector('[aria-label^="People here"]')?.textContent,
}));
console.log('After the member goes upstairs:', JSON.stringify(afterAway));
await browser.close();
