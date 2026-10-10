import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pack, unpack } from '../src/tar.ts';

describe('tar', () => {
  it('round-trips files, including long paths, and agrees with GNU tar', () => {
    const long = `${'deep/'.repeat(30)}file.txt`;
    const files = new Map<string, Uint8Array>([
      ['README.md', new TextEncoder().encode('# Hello\n')],
      ['src/main.ts', new TextEncoder().encode('export {};\n')],
      [long, new TextEncoder().encode('far down')],
      ['empty.txt', new Uint8Array()],
    ]);
    const tar = pack(files);
    expect([...unpack(tar).keys()].sort()).toEqual([...files.keys()].sort());
    const dir = mkdtempSync(join(tmpdir(), 'tar-'));
    writeFileSync(join(dir, 'a.tar'), tar);
    execFileSync('tar', ['-xf', 'a.tar'], { cwd: dir });
    expect(readFileSync(join(dir, long), 'utf8')).toBe('far down');
    // …and reads what GNU tar writes.
    const gnu = execFileSync('tar', ['-cf', '-', 'README.md', long], { cwd: dir });
    expect(unpack(gnu).get(long)?.toString()).toBe('far down');
  });

  it('reads pax archives (git archive and GitHub write them), with their long paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tar-pax-'));
    // Longer than ustar's 100 + 155, so only a pax header can hold it.
    const long = `${'a-rather-long-folder-name/'.repeat(12)}file.txt`;
    execFileSync('mkdir', ['-p', join(dir, long, '..')]);
    writeFileSync(join(dir, long), 'deep');
    writeFileSync(join(dir, 'short.txt'), 'near');
    const pax = execFileSync('tar', ['--format=pax', '-cf', '-', 'short.txt', long], { cwd: dir });
    const files = unpack(pax);
    expect(files.get(long)?.toString()).toBe('deep');
    expect(files.get('short.txt')?.toString()).toBe('near');
    expect([...files.keys()].some((k) => k.includes('PaxHeaders'))).toBe(false);
  });

  it('refuses paths that would escape', () => {
    expect(() => pack(new Map([['../etc/passwd', new Uint8Array()]]))).toThrow();
    expect(() => pack(new Map([['/etc/passwd', new Uint8Array()]]))).toThrow();
  });
});
