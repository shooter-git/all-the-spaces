import { Button, Card, Field, Icon, Notice } from '@ats/ui';
import { type FormEvent, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { BrandHeader } from '../components/Brand.tsx';
import { api, type Me } from '../lib/api.ts';
import { authClient } from '../lib/auth-client.ts';

interface InviteInfo {
  groupName: string;
  themeColor: string | null;
  role: 'architect' | 'member';
}

// Invite links carry their token in the URL fragment (#…), which browsers never send to servers.
export function Join({ me, onJoined }: { me: Me | null; onJoined: () => Promise<void> }) {
  const navigate = useNavigate();
  const [token] = useState(() => window.location.hash.slice(1));
  const [invite, setInvite] = useState<InviteInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [busy, setBusy] = useState(false);
  /** The account is made and in the group; its email needs confirming before signing in. */
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!token) {
      setError('This link is missing its invite code. Ask for a new link.');
      return;
    }
    api<InviteInfo>('/api/invites/inspect', { json: { token } }).then(setInvite, (e: Error) =>
      setError(e.message),
    );
  }, [token]);

  const accept = async () => {
    await api('/api/invites/accept', { json: { token } });
    await onJoined();
    navigate('/', { replace: true });
  };

  const createAccount = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { data, error } = await authClient.signUp.email(
        { name: form.name, email: form.email, password: form.password, callbackURL: '/' },
        { headers: { 'x-ats-invite': token } },
      );
      if (error) throw new Error(error.message ?? 'Could not create your account.');
      // Joining the group happens with the account. When the server sends email, the person
      // confirms their address (the link signs them in) before anything else.
      if (data?.token) await accept();
      else setConfirming(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="ats-screen">
      <div className="ats-center">
        <div className="ats-container ats-stack">
          <BrandHeader />
          <Card page>
            <div className="ats-stack">
              {confirming ? (
                <>
                  <h1>Check your email</h1>
                  <p style={{ margin: 0 }}>
                    We've sent a link to {form.email}. Open it to confirm it's yours, and you're in{' '}
                    {invite?.groupName}. (Check spam if it isn't there.)
                  </p>
                </>
              ) : invite ? (
                <>
                  <h1>You're invited to {invite.groupName}</h1>
                  {me?.user ? (
                    <>
                      <p style={{ margin: 0 }}>You're signed in as {me.user.name}.</p>
                      <Button
                        variant="primary"
                        block
                        disabled={busy}
                        onClick={() => accept().catch((e: Error) => setError(e.message))}
                      >
                        Join {invite.groupName}
                      </Button>
                    </>
                  ) : (
                    <form className="ats-stack" onSubmit={createAccount}>
                      <Field
                        label="Your name"
                        value={form.name}
                        onChange={(e) => setForm({ ...form, name: e.target.value })}
                        autoComplete="name"
                        required
                      />
                      <Field
                        label="Email"
                        type="email"
                        value={form.email}
                        onChange={(e) => setForm({ ...form, email: e.target.value })}
                        autoComplete="email"
                        required
                      />
                      <Field
                        label="Choose a password"
                        type="password"
                        hint="At least 10 characters."
                        value={form.password}
                        onChange={(e) => setForm({ ...form, password: e.target.value })}
                        autoComplete="new-password"
                        minLength={10}
                        required
                      />
                      <Button type="submit" variant="primary" block disabled={busy}>
                        <Icon name="invite" size={16} />
                        {busy ? 'Joining…' : `Join ${invite.groupName}`}
                      </Button>
                      <Button variant="ghost" block onClick={() => navigate('/sign-in')}>
                        I already have an account
                      </Button>
                    </form>
                  )}
                </>
              ) : (
                !error && <p className="ats-muted">Checking your invite…</p>
              )}
              {error && <Notice tone="error">{error}</Notice>}
            </div>
          </Card>
        </div>
      </div>
    </main>
  );
}
