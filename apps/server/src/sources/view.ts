import type { CreationSource, Sent } from '@ats/api-types';
import type { SourceHostRegistry } from './registry.ts';
import type { SourceRow } from './service.ts';

/** A creation's repository link as Architects see it. */
export function sourceView(row: SourceRow, hosts: SourceHostRegistry): Sent<CreationSource> {
  return {
    host: row.host,
    hostName: hosts.get(row.host)?.def.displayName ?? null,
    repository: row.repository,
    path: row.path,
    follows: row.follows,
    ref: row.ref,
    updateMode: row.updateMode,
    builtCommit: row.builtCommit,
    latestCommit: row.latestCommit,
    latestLabel: row.latestLabel,
    behindBy: row.behindBy,
    checkedAt: row.checkedAt,
    checkError: row.checkError,
  };
}
