/**
 * The AI assistants an Architect can connect, installed by the Architect's own session with
 * the vendor's official installer (never shipped or modified by us), at a version this release
 * of All the Spaces has been tested with. See docs/compliance.md.
 */
export type Provider = 'claude' | 'codex';

export interface VendorCli {
  name: string;
  vendor: string;
  version: string;
  /** The official installer, downloaded and run inside the Architect's own container. */
  installCommand: (version: string) => string;
  /** Where the installed program lives, relative to the sandbox user's home. */
  binary: string;
  /** Present once the Architect has signed in (checked for existence only; never read). */
  signedInFile: string;
  /** Starts the assistant (no prompt: the Architect types or picks every message). */
  start: string;
  /** Starts it with the vendor's own sign-in flow. */
  signIn: string;
  /** Carries on the last conversation in a workspace. */
  resume: string;
}

export const VENDOR_CLIS: Record<Provider, VendorCli> = {
  claude: {
    name: 'Claude Code',
    vendor: 'Anthropic',
    version: '2.1.285',
    installCommand: (v) =>
      `curl -fsSL https://claude.ai/install.sh -o /tmp/install.sh && bash /tmp/install.sh ${v}`,
    binary: '.local/bin/claude',
    signedInFile: '.claude-config/.credentials.json',
    start: 'claude',
    signIn: 'claude',
    resume: 'claude --continue',
  },
  codex: {
    name: 'Codex',
    vendor: 'OpenAI',
    version: '0.159.3',
    // The installer keeps the program (and its helpers: rg, bwrap) under $CODEX_HOME/packages,
    // linked from ~/.local/bin. Codex's own CODEX_HOME holds its sign-in, which every workspace
    // can write, so the installer is pointed into the tools volume instead (read-only in
    // workspaces): the program that's checked is the one that starts (docs/compliance.md, C2).
    installCommand: (v) =>
      `curl -fsSL https://chatgpt.com/codex/install.sh -o /tmp/install.sh && CODEX_HOME="$HOME/.local/share/codex" CODEX_RELEASE=${v} CODEX_NON_INTERACTIVE=true sh /tmp/install.sh`,
    binary: '.local/bin/codex',
    signedInFile: '.codex/auth.json',
    start: 'codex',
    signIn: 'codex login --device-auth',
    resume: 'codex resume --last',
  },
};

export const PROVIDERS = Object.keys(VENDOR_CLIS) as Provider[];
