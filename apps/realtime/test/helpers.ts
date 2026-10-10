import type { AddressInfo } from 'node:net';
import type { Server } from '@colyseus/core';

/**
 * Starts the server on a port the system picks, and says which. (Picking a free port first and
 * listening on it afterwards races with everything else on the machine taking that port.)
 */
export async function listenOnFreePort(server: Server): Promise<number> {
  await server.listen(0, '127.0.0.1');
  const address = server.transport.server?.address() as AddressInfo | null;
  if (!address?.port) throw new Error('The server is not listening on a port');
  return address.port;
}

/** Waits until `check` holds (polling every few ms); how long that took. */
export async function until(check: () => boolean, ms = 2000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
  return Date.now() - start;
}
