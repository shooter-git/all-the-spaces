import { Button, Card, Field, Icon, Notice } from '@ats/ui';
import { type FormEvent, useState } from 'react';
import { BrandHeader } from '../components/Brand.tsx';
import { authClient } from '../lib/auth-client.ts';

const UNREACHABLE = "Couldn't reach the server. Check you're online and try again.";

export function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    let error: { code?: string | undefined } | null;
    try {
      ({ error } = await authClient.signIn.email({ email, password, callbackURL: '/' }));
    } catch {
      setBusy(false);
      setError(UNREACHABLE);
      return;
    }
    setBusy(false);
    if (error?.code === 'EMAIL_NOT_VERIFIED')
      setError(
        "Confirm your email first. We've just sent you a new link: open it to sign in. (Check spam if it isn't there.)",
      );
    else if (error) setError('That email and password did not match.');
    else onSignedIn();
  };

  const withPasskey = async () => {
    setError(null);
    let failed: boolean;
    try {
      failed = Boolean((await authClient.signIn.passkey())?.error);
    } catch {
      // Cancelled, no passkey here, or no connection: the same way out.
      failed = true;
    }
    if (failed) setError('Passkey sign-in did not work on this device. Try your password.');
    else onSignedIn();
  };

  return (
    <main className="ats-screen">
      <div className="ats-center">
        <div className="ats-container ats-stack">
          <BrandHeader />
          <Card page>
            <form className="ats-stack" onSubmit={submit}>
              <h1>Sign in</h1>
              <Field
                label="Email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username webauthn"
                required
              />
              <Field
                label="Password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
              {error && <Notice tone="error">{error}</Notice>}
              <Button type="submit" variant="primary" block disabled={busy}>
                <Icon name="signIn" size={16} />
                {busy ? 'Signing in…' : 'Sign in'}
              </Button>
              <Button block onClick={withPasskey}>
                <Icon name="key" size={16} />
                Use a passkey instead
              </Button>
              <p
                className="ats-muted"
                style={{ margin: 0, fontSize: '0.9rem', textAlign: 'center' }}
              >
                New here? Ask your space's Architect for an invite link.
              </p>
            </form>
          </Card>
        </div>
      </div>
    </main>
  );
}
