import { Button, Icon, Notice, Section } from '@ats/ui';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { ManageLayout } from '../components/ManageLayout.tsx';
import { Terminal } from '../components/Terminal.tsx';
import type { Me } from '../lib/api.ts';
import {
  type Assistant,
  assistantAction,
  loadAssistants,
  type Provider,
} from '../lib/workbench.ts';
import './studio.css';

/** What the Architect does in the terminal to sign in, in the assistant's own words and screens. */
const SIGN_IN: Record<Provider, { steps: string[]; note?: string }> = {
  claude: {
    steps: [
      'Claude Code starts in the terminal. If it asks, pick a text style and press Enter.',
      'Choose “Claude account with subscription” and press Enter.',
      'It shows a link: press Open the sign-in page (above the terminal), sign in to Claude and approve.',
      'Claude shows a code. Copy it, paste it into the terminal (the Paste key, or Ctrl+V) and press Enter.',
      'When it says you’re signed in, you can close it with Ctrl+C twice — then press “I’ve signed in”.',
    ],
    note: 'You sign in with Anthropic directly. All the Spaces never sees your password or your sign-in.',
  },
  codex: {
    steps: [
      'Codex shows a link and a one-time code in the terminal.',
      'Press Open the sign-in page (above the terminal), sign in to ChatGPT and enter the code.',
      'If it says device sign-in isn’t allowed: in ChatGPT, open Settings → Security, turn on “Device code authorization”, then try again.',
      'When the terminal says you’re signed in, press “I’ve signed in”.',
    ],
    note: 'You sign in with OpenAI directly. All the Spaces never sees your password or your sign-in.',
  },
};

/**
 * Connecting an Architect's own AI assistant: the vendor's official installer runs in the
 * Architect's private container, then they sign in with the assistant's own sign-in, in the
 * terminal. There's deliberately no field here for passwords, keys or codes.
 */
export function Assistants({ me }: { me: Me }) {
  const [list, setList] = useState<Assistant[] | null>(null);
  const [available, setAvailable] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<Provider | null>(null);
  const refresh = useCallback(
    () =>
      loadAssistants().then(
        (r) => {
          setList(r.assistants);
          setAvailable(r.available);
        },
        (e: Error) => setError(e.message),
      ),
    [],
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <ManageLayout
      me={me}
      title="AI assistants"
      intro="Creations are built by your own Claude Code or Codex, signed in with your own subscription. It runs in a private, sealed container that only you use, and only when you start it."
    >
      <div className="ats-stack">
        {error && <Notice tone="error">{error}</Notice>}
        {!available && <Notice>The Studio isn’t set up on this server yet.</Notice>}
        {list && (
          <div className="studio-assistants">
            {list.map((a) => (
              <AssistantCard
                key={a.provider}
                assistant={a}
                active={active === a.provider}
                onActivate={() => setActive(a.provider)}
                onChanged={refresh}
                disabled={!available}
              />
            ))}
          </div>
        )}
        <p className="ats-muted">
          Which model each assistant starts with, and how hard it thinks, is in{' '}
          <Link to="/group/settings">Group settings</Link>; each workspace can choose its own.
        </p>
      </div>
    </ManageLayout>
  );
}

/** One assistant: installed or not, signed in or not, and what to do next. */
export function AssistantCard({
  assistant: a,
  active,
  onActivate,
  onChanged,
  disabled,
}: {
  assistant: Assistant;
  active: boolean;
  onActivate: () => void;
  onChanged: () => Promise<unknown>;
  disabled: boolean;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<string | null>(null);
  const [terminal, setTerminal] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const state = a.installed && a.signedIn ? 'connected' : a.installed ? 'installed' : 'new';
  /** Installed before, but kept where it no longer counts (an earlier Codex): install it again. */
  const again = !a.installed && a.installedVersion !== null;

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const install = () =>
    run('install', async () => {
      onActivate();
      await assistantAction(a.provider, 'open');
      const r = await assistantAction<{ ok: boolean; version: string; log: string }>(
        a.provider,
        'install',
      );
      setLog(r.ok ? null : r.log);
      if (!r.ok) throw new Error(`${a.name} didn't install. The installer's last words are below.`);
      await onChanged();
    });
  const signIn = () =>
    run('sign-in', async () => {
      onActivate();
      setMessage(null);
      await assistantAction(a.provider, 'open');
      setTerminal(true);
      // Give the terminal a moment to attach before the sign-in starts in it.
      await new Promise((r) => setTimeout(r, 800));
      await assistantAction(a.provider, 'sign-in');
    });
  const check = () =>
    run('check', async () => {
      const r = await assistantAction<{ installed: boolean; signedIn: boolean }>(
        a.provider,
        'check',
      );
      if (r.signedIn) {
        setTerminal(false);
        setMessage(null);
        await assistantAction(a.provider, 'close');
      } else setMessage('Not signed in yet: finish the steps in the terminal, then try again.');
      await onChanged();
    });
  const forget = () =>
    run('forget', async () => {
      await assistantAction(a.provider, 'forget');
      await onChanged();
    });

  return (
    <Section title={a.name}>
      <div className="ats-stack" style={{ gap: 12 }}>
        <p className="studio-status" data-state={state}>
          <span className="studio-dot" aria-hidden="true" />
          {state === 'connected'
            ? `Connected · version ${a.installedVersion}`
            : state === 'installed'
              ? `Installed (version ${a.installedVersion}) · not signed in`
              : again
                ? 'Needs installing again'
                : 'Not connected'}
        </p>
        {a.apiKey && (
          <p className="ats-muted">
            This server gives {a.name} its own API key (set up by whoever runs it), so there’s
            nothing to sign in to: use is billed to that key.
          </p>
        )}
        {a.installed && a.installedVersion && a.installedVersion !== a.version && (
          <p className="ats-muted">
            {a.vendor}’s {a.name} {a.version} is ready (you have {a.installedVersion}).{' '}
            <strong>Update</strong> installs it with {a.vendor}’s own installer; your sign-in stays.
          </p>
        )}
        {again && (
          <p className="ats-muted">
            {a.name} is now kept where your workspaces can’t change it, so it needs installing
            again, with {a.vendor}’s own installer. Your sign-in stays.
          </p>
        )}
        {state === 'new' && !again && !a.apiKey && (
          <p className="ats-muted">
            Installs {a.vendor}’s official {a.name} (version {a.version}) into your private
            container, using {a.vendor}’s own installer. You’ll need a{' '}
            {a.provider === 'claude'
              ? 'Claude plan that includes Claude Code'
              : 'ChatGPT plan that includes Codex'}
            .
          </p>
        )}
        <div className="studio-actions-row">
          {state === 'new' && (
            <Button
              variant="primary"
              onClick={() => void install()}
              disabled={disabled || busy !== null}
            >
              <Icon name="download" size={16} />
              {busy === 'install'
                ? `Installing ${a.name}… (about a minute)`
                : `Install ${a.name}${again ? ' again' : ''}`}
            </Button>
          )}
          {state === 'installed' && !terminal && !a.apiKey && (
            <Button
              variant="primary"
              onClick={() => void signIn()}
              disabled={disabled || busy !== null}
            >
              <Icon name="key" size={16} />
              {busy === 'sign-in' ? 'Starting…' : 'Sign in'}
            </Button>
          )}
          {state === 'connected' && (
            <>
              <Button
                variant={a.installedVersion !== a.version ? 'primary' : 'ghost'}
                onClick={() => void install()}
                disabled={disabled || busy !== null}
              >
                <Icon name={a.installedVersion !== a.version ? 'download' : 'refresh'} size={16} />
                {busy === 'install'
                  ? a.installedVersion !== a.version
                    ? 'Updating…'
                    : 'Reinstalling…'
                  : a.installedVersion !== a.version
                    ? `Update to ${a.version}`
                    : 'Reinstall'}
              </Button>
              {!a.apiKey && (
                <Button
                  variant="ghost"
                  onClick={() => void forget()}
                  disabled={disabled || busy !== null}
                >
                  <Icon name="signOut" size={16} />
                  Sign out of {a.name}
                </Button>
              )}
            </>
          )}
        </div>
        {error && <Notice tone="error">{error}</Notice>}
        {log && <pre className="studio-log">{log}</pre>}
        {active && terminal && (
          <div className="studio-connect">
            <ol className="studio-steps">
              {SIGN_IN[a.provider].steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
            <div className="studio-connect-terminal">
              <Terminal target={`connect:${a.provider}`} />
            </div>
            <p className="ats-muted studio-small">{SIGN_IN[a.provider].note}</p>
            {message && <Notice>{message}</Notice>}
            <div className="studio-actions-row">
              <Button variant="primary" onClick={() => void check()} disabled={busy !== null}>
                {busy === 'check' ? 'Checking…' : 'I’ve signed in'}
              </Button>
              <Button variant="ghost" onClick={() => void signIn()} disabled={busy !== null}>
                Start again
              </Button>
            </div>
          </div>
        )}
      </div>
    </Section>
  );
}
