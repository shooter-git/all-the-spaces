import { gunzipSync } from 'node:zlib';
import { unpackTar } from '@ats/shared';
import { SourceError } from './github.ts';

/** Never unpack more than a creation's source may be (the snapshot's own limit is 300 MB). */
const MAX_UNPACKED = 300 * 1024 * 1024;

/**
 * The creation's files from a repository archive: everything in `folder` ('' for the whole
 * repository), with paths relative to it. Hosts put everything in one top folder named after the
 * repository and commit, which is dropped. Only regular files are kept (links and the like are
 * left out); the snapshot then checks every name.
 */
export function filesFrom(gzipped: Buffer, folder: string): Map<string, Uint8Array> {
  let tar: Buffer;
  try {
    tar = gunzipSync(gzipped, { maxOutputLength: MAX_UNPACKED + 64 * 1024 * 1024 });
  } catch (err) {
    throw new SourceError(
      (err as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE'
        ? 'The repository is over 300 MB unpacked.'
        : "The repository's archive couldn't be read.",
    );
  }
  let all: Map<string, Buffer>;
  try {
    all = unpackTar(tar, MAX_UNPACKED);
  } catch {
    throw new SourceError('The repository is over 300 MB unpacked.');
  }
  const prefix = folder ? `${folder}/` : '';
  const files = new Map<string, Uint8Array>();
  for (const [name, data] of all) {
    const top = name.indexOf('/');
    if (top < 0) continue;
    const inRepository = name.slice(top + 1);
    if (!inRepository.startsWith(prefix)) continue;
    const path = inRepository.slice(prefix.length);
    if (path && !path.endsWith('/')) files.set(path, data);
  }
  if (!files.size)
    throw new SourceError(
      folder
        ? `There's nothing in ${folder} at that commit.`
        : 'The repository is empty at that commit.',
    );
  return files;
}
