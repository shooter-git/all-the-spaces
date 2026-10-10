// Manual smoke test: node --env-file=../../.env scripts/garage.smoke.ts
import { bootstrapGarage, createStorage } from '../src/index.ts';

const env = process.env;
const opts = {
  adminUrl: `http://127.0.0.1:${env.ATS_PORT_S3_ADMIN}`,
  adminToken: env.GARAGE_ADMIN_TOKEN ?? '',
  accessKeyId: env.S3_ACCESS_KEY_ID ?? '',
  secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? '',
  bucket: env.S3_BUCKET ?? 'ats',
};
await bootstrapGarage(opts);
await bootstrapGarage(opts); // idempotent
const s3 = createStorage({
  endpoint: `http://127.0.0.1:${env.ATS_PORT_S3}`,
  region: env.S3_REGION ?? 'garage',
  bucket: opts.bucket,
  accessKeyId: opts.accessKeyId,
  secretAccessKey: opts.secretAccessKey,
});
await s3.check();
await s3.put('smoke/hello.txt', 'hello', 'text/plain');
console.log('read back:', new TextDecoder().decode(await s3.getBytes('smoke/hello.txt')));
await s3.delete('smoke/hello.txt');
console.log('storage OK');
