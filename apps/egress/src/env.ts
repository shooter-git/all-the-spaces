import { readFileSync } from 'node:fs';

/**
 * The proxy's settings, checked here without a schema library: the egress image has no
 * dependencies at all.
 */
export interface EgressEnv {
  /** Hosts a sandbox may reach: EGRESS_ALLOW (comma-separated) plus EGRESS_ALLOW_FILE. */
  allow: string[];
  /** Hosts never reached, even with the whole internet allowed: EGRESS_DENY_FILE. */
  deny: string[];
  port: number;
  /** Signs the passes of workspaces allowed the whole internet (32 characters or more). */
  secret?: string;
}

/** One host per line; # starts a comment. */
const hostsIn = (file: string | undefined) =>
  file
    ? readFileSync(file, 'utf8')
        .split('\n')
        .map((l) => l.replace(/#.*/, '').trim())
        .filter(Boolean)
    : [];

export function loadEgressEnv(source: NodeJS.ProcessEnv = process.env): EgressEnv {
  const port = Number(source.EGRESS_PORT ?? 3128);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`EGRESS_PORT isn't a port: ${source.EGRESS_PORT}`);
  const secret =
    source.EGRESS_SECRET && source.EGRESS_SECRET.length >= 32 ? source.EGRESS_SECRET : undefined;
  return {
    allow: [...(source.EGRESS_ALLOW ?? '').split(','), ...hostsIn(source.EGRESS_ALLOW_FILE)].filter(
      Boolean,
    ),
    deny: hostsIn(source.EGRESS_DENY_FILE),
    port,
    ...(secret ? { secret } : {}),
  };
}
