import type { Tier } from './budgets.ts';

export type CheckStatus = 'pass' | 'fail' | 'warn';

/** One thing that was checked, in plain words, with how to fix it when it failed. */
export interface Check {
  id: string;
  status: CheckStatus;
  title: string;
  detail?: string | undefined;
  fix?: string;
  /** Which screen it happened on, when it's specific to one. */
  where?: string;
}

export interface ViewportResult {
  name: string;
  label: string;
  width: number;
  height: number;
  touch: boolean;
  screenshots: { name: string; file: string }[];
  readyMs: number | null;
  initialBytes: number;
  metrics: Metrics | null;
}

export interface Metrics {
  drawCalls: { p95: number; max: number };
  triangles: { p95: number; max: number };
  frameMs: { p50: number; p95: number };
  frames: number;
  textureBytes: number;
  gpuBytes: number;
  voices: number;
  directToSpeakers: number;
  peak: number;
  clippedMoments: number;
  heapBytes: number;
  errors: string[];
  blocked: { what: string; directive: string }[];
  contexts: number;
}

export interface Report {
  format: 1;
  ok: boolean;
  createdAt: string;
  durationMs: number;
  creation: { title: string; tier: Tier; sessionMode: string; saveVersion: number | null };
  checks: Check[];
  viewports: ViewportResult[];
  /** The heaviest numbers across every screen. */
  summary: {
    drawCalls: number;
    triangles: number;
    textureMB: number;
    gpuMB: number;
    voices: number;
    heapMB: number;
    initialMB: number;
    totalMB: number;
    frameMsP95: number;
  } | null;
  build: {
    files: number;
    bytes: number;
    conversions: { path: string; action: string; before: number; after: number }[];
    notes: string[];
  } | null;
  source: { hash: string; files: number; bytes: number } | null;
  credits: { path: string; license: string; source?: string; title?: string; author?: string }[];
  dependencies: { name: string; version: string; license: string }[];
  /** Screenshot used as the creation's picture. */
  thumbnail: string | null;
}

export const sortChecks = (checks: Check[]) => {
  const rank = { fail: 0, warn: 1, pass: 2 };
  return [...checks].sort((a, b) => rank[a.status] - rank[b.status]);
};

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** A self-contained page for the report (screenshots are files next to it). */
export function reportHtml(r: Report): string {
  const failed = r.checks.filter((c) => c.status === 'fail').length;
  const warned = r.checks.filter((c) => c.status === 'warn').length;
  const verdict = r.ok
    ? warned
      ? `Ready, with ${warned} thing${warned === 1 ? '' : 's'} worth a look`
      : 'Ready'
    : `${failed} thing${failed === 1 ? '' : 's'} to fix before it can be published`;
  const checks = sortChecks(r.checks)
    .map(
      (c) => `<li class="${c.status}"><span class="dot" aria-hidden="true"></span><div>
  <strong>${esc(c.title)}</strong>${c.where ? ` <span class="where">${esc(c.where)}</span>` : ''}
  ${c.detail ? `<p>${esc(c.detail)}</p>` : ''}${c.fix && c.status !== 'pass' ? `<p class="fix">${esc(c.fix)}</p>` : ''}
</div></li>`,
    )
    .join('\n');
  const shots = r.viewports
    .flatMap((v) =>
      v.screenshots.map(
        (s) =>
          `<figure><img src="${esc(s.file)}" alt="${esc(`${v.label}: ${s.name}`)}" loading="lazy"><figcaption>${esc(v.label)} · ${esc(s.name)}</figcaption></figure>`,
      ),
    )
    .join('\n');
  const s = r.summary;
  const numbers = s
    ? `<table><tbody>
<tr><th>Draw calls per frame</th><td>${s.drawCalls}</td></tr>
<tr><th>Triangles per frame</th><td>${s.triangles.toLocaleString('en')}</td></tr>
<tr><th>Texture memory</th><td>${s.textureMB.toFixed(1)} MB</td></tr>
<tr><th>Graphics memory</th><td>${s.gpuMB.toFixed(1)} MB</td></tr>
<tr><th>Sounds at once</th><td>${s.voices}</td></tr>
<tr><th>Script memory</th><td>${s.heapMB.toFixed(1)} MB</td></tr>
<tr><th>Download before it's ready</th><td>${s.initialMB.toFixed(1)} MB</td></tr>
<tr><th>Whole download</th><td>${s.totalMB.toFixed(1)} MB</td></tr>
</tbody></table>`
    : '';
  const conversions = r.build?.conversions.length
    ? `<h2>Made lighter</h2><ul class="plain">${r.build.conversions
        .map((c) => `<li>${esc(c.path)}: ${esc(c.action)} (${mb(c.before)} → ${mb(c.after)})</li>`)
        .join('')}</ul>`
    : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(r.creation.title)}: checks</title>
<style>
:root { --paper: #f5f1ee; --ink: #2e2c33; --muted: #6b6770; --line: #e2dcd6; --ai: #3f5b7c; --good: #4f7a5a; --warn: #a8782a; --bad: #9a4a45; }
@media (prefers-color-scheme: dark) { :root { --paper: #1f1e23; --ink: #ece7e2; --muted: #a39fa8; --line: #34323a; --ai: #8fa9c8; --good: #8db898; --warn: #d6aa5c; --bad: #d98c85; } }
body { margin: 0; background: var(--paper); color: var(--ink); font: 15px/1.5 system-ui, sans-serif; }
main { max-width: 860px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 1.5rem; margin: 0 0 4px; } h2 { font-size: 1.05rem; margin: 32px 0 8px; }
.verdict { font-size: 1.1rem; color: ${r.ok ? 'var(--good)' : 'var(--bad)'}; margin: 0 0 4px; }
.meta { color: var(--muted); margin: 0; }
ul.checks { list-style: none; padding: 0; margin: 0; border-top: 1px solid var(--line); }
ul.checks li { display: flex; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--line); }
ul.checks p { margin: 2px 0 0; } .fix { color: var(--ai); } .where { color: var(--muted); font-size: .9em; }
.dot { flex: none; width: 10px; height: 10px; border-radius: 50%; margin-top: 7px; }
.pass .dot { background: var(--good); } .warn .dot { background: var(--warn); } .fail .dot { background: var(--bad); }
.shots { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; }
figure { margin: 0; } img { width: 100%; border-radius: 8px; border: 1px solid var(--line); background: #fff; }
figcaption { color: var(--muted); font-size: .85em; }
table { border-collapse: collapse; } th, td { text-align: left; padding: 4px 16px 4px 0; font-weight: normal; } th { color: var(--muted); }
ul.plain { padding-left: 18px; }
</style></head><body><main>
<h1>${esc(r.creation.title)}</h1>
<p class="verdict">${esc(verdict)}</p>
<p class="meta">Checked for ${esc(r.creation.tier)}-powered devices and up · ${esc(new Date(r.createdAt).toUTCString())}</p>
<h2>Checks</h2><ul class="checks">${checks}</ul>
${shots ? `<h2>On each screen</h2><div class="shots">${shots}</div>` : ''}
${numbers ? `<h2>The heaviest moments</h2>${numbers}` : ''}
${conversions}
</main></body></html>`;
}
