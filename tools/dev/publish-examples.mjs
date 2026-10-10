// Dev helper: checks and publishes the example creations into the newest dev studio apartment:
// the painted garden in the picture over the sofa, the journal on the desk, the marble table on
// the dining table and the paper boats in the bath.
//   node tools/dev/publish-examples.mjs [spaceId] [--candidate]
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const candidate = args.includes('--candidate');
const space =
  args.find((a) => !a.startsWith('--')) ??
  execFileSync(
    'docker',
    [
      'exec',
      'ats-dev-postgres-1',
      'psql',
      '-U',
      'ats',
      '-d',
      'ats',
      '-tAc',
      "select id from spaces where sample = 'studio-apartment' order by created_at desc limit 1",
    ],
    { encoding: 'utf8' },
  ).trim();
for (const [name, object] of [
  ['explorable-scene', 'frame-over-sofa'],
  ['close-up-journal', 'desk'],
  ['simulation-sandbox', 'dining-table'],
  ['vehicle', 'bath-tub'],
]) {
  execFileSync(
    'pnpm',
    [
      '--filter',
      '@ats/server',
      'creation:publish',
      `../../examples/${name}`,
      '--space',
      space,
      '--object',
      object,
      ...(candidate ? ['--candidate'] : []),
    ],
    { stdio: 'inherit' },
  );
}
