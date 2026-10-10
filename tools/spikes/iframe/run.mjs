// Runs the S4 probe in each browser engine and prints a comparison table.
//   node tools/spikes/iframe/run.mjs chromium firefox webkit
import { chromium, firefox, webkit } from 'playwright';

const engines = { chromium, firefox, webkit };
const url = process.argv.find((a) => a.startsWith('http')) ?? 'http://app-spike.localhost:45300/';
const table = new Map();

for (const name of process.argv.slice(2).filter((a) => a in engines)) {
  const browser = await engines[name].launch();
  try {
    const page = await browser.newPage();
    // *.localhost must resolve to loopback in every engine.
    await page.route('**/*', (route) => route.continue());
    await page.goto(url);
    await page.waitForFunction(() => (window.__results?.length ?? 0) > 5, null, {
      timeout: 20_000,
    });
    const results = await page.evaluate(() => window.__results);
    for (const r of results) {
      if (!table.has(r.name)) table.set(r.name, {});
      table.get(r.name)[name] = r.ok ? 'works' : `blocked (${r.detail.slice(0, 70)})`;
    }
    // Audio after a real tap inside the frame.
    const frame = page.frames().find((f) => f.url().includes('probe.html'));
    await frame.click('#tap');
    const label = await frame.textContent('#tap');
    if (!table.has('AudioContext after tap inside the frame'))
      table.set('AudioContext after tap inside the frame', {});
    table.get('AudioContext after tap inside the frame')[name] = label?.includes('running')
      ? 'works'
      : `blocked (${label})`;
  } catch (e) {
    console.error(`${name}: ${e.message.split('\n')[0]}`);
  } finally {
    await browser.close();
  }
}

const names = process.argv.slice(2).filter((a) => a in engines);
console.log(['Feature', ...names].join(' | '));
for (const [feature, row] of table)
  console.log([feature, ...names.map((n) => row[n] ?? '-')].join(' | '));
