import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

/**
 * Bucket addresses typed into setup must be out on the internet: the server sits on a private
 * network next to the database, the built-in storage's admin side and the supervisor, and a
 * bucket check is a request to wherever the address points.
 */
const inside = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, including cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 3], // multicast and reserved, up to 255.255.255.255
] as const)
  inside.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const)
  inside.addSubnet(net, bits, 'ipv6');

/** Whether an IP address is on a private, loopback, link-local or otherwise non-public network. */
export function isInternalAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped) return inside.check(mapped, 'ipv4');
  const family = isIP(address);
  if (family === 0) return true;
  return inside.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

export class InternalAddressError extends Error {}

/**
 * Refuses a bucket address that isn't plain http(s), or whose host is (or resolves to) an internal
 * address. The built-in storage's own address is the one exception. A name that doesn't resolve
 * is left to fail when the bucket is checked.
 */
export async function assertPublicBucket(endpoint: string, builtin?: string): Promise<void> {
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new InternalAddressError('Bucket addresses start with https:// (or http://).');
  }
  if (builtin && safeOrigin(builtin) === url.origin) return;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host)
    ? [host]
    : await lookup(host, { all: true, verbatim: true }).then(
        (found) => found.map((a) => a.address),
        () => [],
      );
  if (addresses.some(isInternalAddress)) {
    throw new InternalAddressError(
      "That address is on this server's own network. Use the bucket's public address.",
    );
  }
}

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
