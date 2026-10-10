import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
/** Runs `ats` as a workspace's terminal would, without the workspace's tools unless given. */
const ats = (args: string[], env: Record<string, string> = {}) => {
  const { ATS_QA_CLI: _qa, ATS_SPACE_CLI: _space, ...rest } = process.env;
  const r = spawnSync(process.execPath, [cli, ...args], {
    env: { ...rest, ...env },
    encoding: 'utf8',
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

describe('ats', () => {
  it('explains itself for help, and for no command at all', () => {
    for (const args of [['help'], []]) {
      const r = ats(args);
      expect(r.code).toBe(0);
      expect(r.out).toContain('ats qa');
      expect(r.out).toContain('ats assets add <id>');
    }
  });

  it('shows the help with a failing exit code for a command it does not know', () => {
    const r = ats(['frobnicate']);
    expect(r.code).toBe(2);
    expect(r.out).toContain('ats — for building a creation');
  });

  it('says the checks and space tools only work inside a workspace', () => {
    expect(ats(['qa'])).toMatchObject({
      code: 1,
      err: 'The checks are only available inside an All the Spaces workspace.\n',
    });
    expect(ats(['space', 'check'])).toMatchObject({
      code: 1,
      err: 'These tools are only available inside an All the Spaces workspace.\n',
    });
  });

  it('passes `ats space …` through to the space tool as it is, with the project folder', () => {
    // A stand-in tool that prints the arguments it was given.
    const echo = fileURLToPath(new URL('./fixtures/echo-args.mjs', import.meta.url));
    const r = ats(['space', 'scale', '1,2', '3,4', '5'], {
      ATS_SPACE_CLI: echo,
    });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual(['scale', '1,2', '3,4', '5', '--dir', process.cwd()]);
  });
});
