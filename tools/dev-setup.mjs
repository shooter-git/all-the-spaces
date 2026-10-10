// Creates .env from .env.example with fresh random secrets. Never overwrites an existing .env.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

if (existsSync('.env')) {
  console.log('.env already exists — leaving it untouched.');
  process.exit(0);
}

const generators = {
  __generate__: () => randomBytes(32).toString('base64url'),
  __generate_hex32__: () => randomBytes(32).toString('hex'),
  // Garage access key IDs are "GK" + 24 hex characters.
  __generate_garage_key_id__: () => `GK${randomBytes(12).toString('hex')}`,
  // LiveKit API keys are a name for the secret: any string.
  __generate_livekit_key__: () => `LK${randomBytes(12).toString('hex')}`,
};

const out = readFileSync('.env.example', 'utf8').replace(
  /__generate(?:_hex32|_garage_key_id|_livekit_key)?__/g,
  (token) => generators[token](),
);
writeFileSync('.env', out, { mode: 0o600 });
console.log('Created .env with fresh secrets.');
