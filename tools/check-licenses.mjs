// Fails if any production dependency uses a licence outside the allow-list.
// The project must stay free and open source; copyleft beyond MPL (file-level) needs a human decision.
import { execFileSync } from 'node:child_process';

const ALLOWED = new Set([
  'MIT',
  'MIT-0',
  'ISC',
  '0BSD',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  'MPL-2.0',
  'OFL-1.1', // fonts
  'Unlicense',
  'CC0-1.0',
  'BlueOak-1.0.0',
  'Python-2.0',
]);

/**
 * Reviewed exceptions: specific packages under a licence that isn't allowed in general.
 * - libvips (image processing, via sharp): LGPL-3.0, shipped as an unmodified, dynamically
 *   linked library that can be swapped out, which the LGPL permits alongside AGPL code.
 * - libheif-js (iPhone HEIC photos): LGPL-3.0, likewise unmodified and replaceable.
 */
const REVIEWED = [
  { name: /^@img\/sharp-libvips-/, license: 'LGPL-3.0-or-later' },
  // libheif (decodes iPhone HEIC photos on the server, via heic-decode): LGPL-3.0, its own
  // unmodified npm package (WebAssembly), replaceable the same way as libvips.
  { name: /^libheif-js$/, license: 'LGPL-3.0' },
];

// Only installed dependencies are listed: the project's own workspace packages (@ats/*, AGPL, and
// @allthespaces/*, MIT) never are, so nothing is skipped by name. Their licences are in
// docs/licensing.md.
const raw = execFileSync('pnpm', ['licenses', 'list', '--prod', '--json'], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
const byLicense = JSON.parse(raw);
const problems = [];
for (const [license, pkgs] of Object.entries(byLicense)) {
  // Accept "A OR B" when any option is allowed, and "A AND B" when every part is.
  const options = license.replace(/[()]/g, '').split(/\s+OR\s+/);
  const ok = (option) => option.split(/\s+AND\s+/).every((part) => ALLOWED.has(part.trim()));
  if (options.some(ok)) continue;
  for (const p of pkgs) {
    if (REVIEWED.some((r) => r.license === license && r.name.test(p.name))) continue;
    problems.push(`${p.name}@${p.versions?.join(',') ?? '?'}: ${license}`);
  }
}
if (problems.length > 0) {
  console.error('Dependencies with licences that need review:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`Licences OK (${Object.keys(byLicense).join(', ')}).`);
