import { loadEgressEnv } from './env.ts';
import { createProxy } from './proxy.ts';

// The allow-list ships in deploy/; each self-hosted installation can add hosts (env.ts).
const { allow, deny, port, secret } = loadEgressEnv();
createProxy({ allow, deny, ...(secret ? { secret } : {}) }).listen(port, '0.0.0.0', () => {
  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      started: true,
      port,
      hosts: allow.length,
      openInternet: Boolean(secret),
    }),
  );
});
