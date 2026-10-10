import { describe, expect, it } from 'vitest';
import { assistantFlags, EFFORTS, isEffort, MODELS } from '../src/assistants.ts';
import { VENDOR_CLIS } from '../src/vendor-clis.ts';

describe('choosing a model and effort', () => {
  it('gives Claude Code its own flags', () => {
    expect(assistantFlags('claude', { model: 'claude-opus-5-5', effort: 'max' })).toEqual([
      '--model',
      'claude-opus-5-5',
      '--effort',
      'max',
    ]);
    expect(assistantFlags('claude', {})).toEqual([]);
  });

  it('gives Codex its config flags, and keeps its update check and analytics off', () => {
    expect(assistantFlags('codex', { model: 'gpt-6.1-sol', effort: 'ultra' })).toEqual([
      '-c check_for_update_on_startup=false',
      '-c model="gpt-6.1-sol"',
      '-c model_reasoning_effort="ultra"',
      '-c analytics.enabled=false',
    ]);
  });

  it('never puts anything but a model name, or an effort that assistant has, on the command line', () => {
    expect(assistantFlags('claude', { model: 'x; rm -rf ~', effort: 'ultra' })).toEqual([]);
    expect(assistantFlags('codex', { model: '"$(id)"', effort: 'max' })).toEqual([
      '-c check_for_update_on_startup=false',
      '-c model_reasoning_effort="max"',
      '-c analytics.enabled=false',
    ]);
    expect(isEffort('claude', 'ultra')).toBe(false);
    expect(isEffort('codex', 'ultra')).toBe(true);
  });

  it("lists each assistant in its maker's own names", () => {
    expect(MODELS.claude.map((m) => m.value)).toContain('claude-opus-5-5');
    expect(MODELS.claude.find((m) => m.value === 'claude-haiku-5-5')).toMatchObject({
      label: 'Haiku 5.5',
      note: 'fastest',
    });
    expect(MODELS.claude.filter((m) => m.note === 'fastest')).toHaveLength(1);
    expect(MODELS.codex.map((m) => m.value)).toContain('gpt-6.1-sol');
    expect(EFFORTS.claude.map((e) => e.value)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });
});

describe('installing the assistants', () => {
  it("puts each assistant's program in the tools volume, which workspaces can't write (C2)", () => {
    // Codex's installer keeps its program under $CODEX_HOME, its sign-in folder (writable in
    // workspaces) unless pointed elsewhere.
    expect(VENDOR_CLIS.codex.installCommand('0.159.3')).toContain(
      'CODEX_HOME="$HOME/.local/share/codex" CODEX_RELEASE=0.159.3',
    );
    for (const cli of Object.values(VENDOR_CLIS)) expect(cli.binary).toMatch(/^\.local\//);
  });
});
