import { describe, expect, it } from 'vitest';
import { assertPublicBucket, isInternalAddress } from '../src/bucket-address.ts';
import { open, seal } from '../src/crypto-box.ts';
import { shortName } from '../src/routes/meta.ts';
import {
  generateSetupCode,
  hashSetupCode,
  normalizeSetupCode,
  setupCodeMatches,
} from '../src/setup-code.ts';
import { MAX_TEXT_BYTES, viewablePath, viewOf } from '../src/studio/file-view.ts';

describe('setup codes', () => {
  it('look like ABCD-EFGH-JKLM and avoid ambiguous characters', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateSetupCode();
      expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      expect(code).not.toMatch(/[01IOL]/);
    }
  });

  it('match regardless of case, spaces and dashes', () => {
    const hash = hashSetupCode('ABCD-EFGH-JKMN', 'secret');
    expect(setupCodeMatches('abcd efgh jkmn', hash, 'secret')).toBe(true);
    expect(setupCodeMatches('ABCDEFGHJKMN', hash, 'secret')).toBe(true);
    expect(setupCodeMatches('ABCD-EFGH-JKMP', hash, 'secret')).toBe(false);
    expect(setupCodeMatches('ABCD-EFGH-JKMN', hash, 'other-secret')).toBe(false);
    expect(normalizeSetupCode(' abcd-efgh-jkmn ')).toBe('ABCD-EFGH-JKMN');
  });
});

describe('crypto box', () => {
  it('round-trips and refuses the wrong key or purpose', () => {
    const sealed = seal('s3-secret', 'server-secret', 'storage');
    expect(sealed).not.toContain('s3-secret');
    expect(open(sealed, 'server-secret', 'storage')).toBe('s3-secret');
    expect(() => open(sealed, 'wrong-secret', 'storage')).toThrow();
    expect(() => open(sealed, 'server-secret', 'backups')).toThrow();
  });
});

describe('home-screen short names', () => {
  it('fit in about 12 characters', () => {
    expect(shortName('All the Spaces')).toBe('Spaces');
    expect(shortName('The Smith House')).toBe('Smith House');
    expect(shortName('Studio 4B')).toBe('Studio 4B');
    expect(shortName('Riverside Apartments Building')).toBe('Riverside');
  });
});

describe('bucket addresses typed into setup', () => {
  it('tells internal addresses from public ones', () => {
    for (const a of [
      '127.0.0.1',
      '10.1.2.3',
      '172.18.0.5',
      '192.168.1.10',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      '::',
      'fd00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
    ])
      expect(isInternalAddress(a), a).toBe(true);
    for (const a of ['1.1.1.1', '172.32.0.1', '8.8.8.8', '2606:4700::1111', '::ffff:1.1.1.1'])
      expect(isInternalAddress(a), a).toBe(false);
  });

  it("refuses the server's own network, but not the built-in storage", async () => {
    await expect(assertPublicBucket('http://127.0.0.1:3903')).rejects.toThrow(/own network/);
    await expect(assertPublicBucket('http://[::1]:3900')).rejects.toThrow(/own network/);
    await expect(assertPublicBucket('http://169.254.169.254/latest')).rejects.toThrow();
    await expect(assertPublicBucket('http://localhost:3903')).rejects.toThrow(/own network/);
    await expect(assertPublicBucket('file:///etc/passwd')).rejects.toThrow(/https/);
    await expect(
      assertPublicBucket('http://garage:3900', 'http://garage:3900'),
    ).resolves.toBeUndefined();
    // The built-in storage's admin side is still refused.
    await expect(
      assertPublicBucket('http://127.0.0.1:3903', 'http://127.0.0.1:3900'),
    ).rejects.toThrow();
    await expect(assertPublicBucket('https://1.1.1.1')).resolves.toBeUndefined();
  });
});

describe('what the Studio shows of a workspace file', () => {
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('rest'),
  ]);
  it('shows a picture only when its name and first bytes agree, as a data: address', () => {
    const view = viewOf('preview/robot.png', png);
    expect(view).toMatchObject({ kind: 'picture', bytes: png.length });
    expect(view !== 'not-shown' && view !== 'too-long' && view.kind === 'picture' && view.src).toBe(
      `data:image/png;base64,${png.toString('base64')}`,
    );
    // An HTML page named like a picture is only text; a PNG named like a script isn't a picture.
    expect(viewOf('evil.png', Buffer.from('<script>alert(1)</script>'))).toMatchObject({
      kind: 'text',
    });
    expect(viewOf('robot.ts', png)).toBe('not-shown');
  });

  it('shows text as text, and nothing binary, broken or too long', () => {
    expect(viewOf('src/main.ts', Buffer.from('const é = 1;\n'))).toEqual({
      path: 'src/main.ts',
      bytes: 14,
      kind: 'text',
      text: 'const é = 1;\n',
    });
    // An SVG is shown as its source: never drawn, so nothing in it runs.
    expect(viewOf('logo.svg', Buffer.from('<svg onload="x()"/>'))).toMatchObject({ kind: 'text' });
    expect(viewOf('model.glb', Buffer.from([0x67, 0x6c, 0x54, 0x46, 0, 0, 0, 2]))).toBe(
      'not-shown',
    );
    expect(viewOf('latin1.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9]))).toBe('not-shown');
    expect(viewOf('big.txt', Buffer.alloc(MAX_TEXT_BYTES + 1, 'a'))).toBe('too-long');
  });

  it('asks only about paths inside the workspace, and never about git itself', () => {
    expect(viewablePath('src/scenes/level.ts')).toBe(true);
    expect(viewablePath('-n file.txt')).toBe(true);
    for (const p of [
      '',
      '../etc/passwd',
      '/etc/passwd',
      'a/../b',
      'a//b',
      './a',
      '.git',
      '.git/config',
      'x\ny',
    ])
      expect(viewablePath(p), p).toBe(false);
  });
});
