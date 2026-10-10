import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { filesFrom } from '../src/sources/archive.ts';
import { SourceError } from '../src/sources/github.ts';
import { loadSourceHosts } from '../src/sources/registry.ts';

const quiet = () => {
  const warned: string[] = [];
  return { warned, log: { info() {}, warn: (o: { file?: string }) => warned.push(o.file ?? '') } };
};

describe('repository hosts', () => {
  it('reads the folder: a bad file, another id or a missing token is skipped, the rest load', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sources-'));
    const host = (id: string, extra: object = {}) =>
      JSON.stringify({ id, displayName: id, kind: 'github', repositories: ['club/*'], ...extra });
    writeFileSync(
      join(dir, 'github.json'),
      host('github', { tokenEnv: 'ATS_SOURCE_GITHUB_TOKEN' }),
    );
    writeFileSync(join(dir, 'public.json'), host('public'));
    writeFileSync(join(dir, 'other.json'), host('not-other'));
    writeFileSync(join(dir, 'broken.json'), '{');
    writeFileSync(
      join(dir, 'tokenless.json'),
      host('tokenless', { tokenEnv: 'ATS_SOURCE_MISSING' }),
    );
    writeFileSync(join(dir, 'notes.txt'), 'ignored');
    const { warned, log } = quiet();
    const hosts = await loadSourceHosts(dir, { ATS_SOURCE_GITHUB_TOKEN: 'ghs_x' }, log);
    expect(hosts.list().map((h) => h.def.id)).toEqual(['github', 'public']);
    expect(hosts.get('github')?.token).toBe('ghs_x');
    expect(hosts.get('public')?.token).toBeNull();
    expect(warned.sort()).toEqual(['broken.json', 'other.json', 'tokenless.json']);
    // No folder: none, quietly.
    expect((await loadSourceHosts(join(dir, 'nope'), {}, quiet().log)).list()).toEqual([]);
    expect((await loadSourceHosts(undefined, {}, quiet().log)).list()).toEqual([]);
  });
});

describe('a repository archive', () => {
  const archive = (build: (top: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), 'archive-'));
    const top = join(dir, 'club-game-abc1234');
    mkdirSync(top);
    build(top);
    return execFileSync('tar', ['--format=pax', '-czf', '-', 'club-game-abc1234'], { cwd: dir });
  };

  it('keeps the folder asked for, with paths inside it, and regular files only', () => {
    const gz = archive((top) => {
      mkdirSync(join(top, 'creation/src'), { recursive: true });
      writeFileSync(join(top, 'README.md'), 'outside');
      writeFileSync(join(top, 'creation/ats.json'), '{}');
      writeFileSync(join(top, 'creation/src/main.ts'), 'inside');
      symlinkSync('/etc/passwd', join(top, 'creation/link'));
    });
    expect([...filesFrom(gz, 'creation').keys()].sort()).toEqual(['ats.json', 'src/main.ts']);
    expect([...filesFrom(gz, '').keys()].sort()).toEqual([
      'README.md',
      'creation/ats.json',
      'creation/src/main.ts',
    ]);
    expect(() => filesFrom(gz, 'elsewhere')).toThrow(/nothing in elsewhere/);
    expect(() => filesFrom(Buffer.from('not gzip'), '')).toThrow(SourceError);
  });
});
