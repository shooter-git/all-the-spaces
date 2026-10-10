import { Button, Card, Choice, Field, Icon, Notice, Steps } from '@ats/ui';
import { type FormEvent, type ReactNode, useState } from 'react';
import { useNavigate } from 'react-router';
import { BrandHeader } from '../components/Brand.tsx';
import { ColourSwatches, DEFAULT_GROUP_COLOUR } from '../components/ColourSwatches.tsx';
import { api } from '../lib/api.ts';

const KINDS = [
  { id: 'family', label: 'A family', hint: 'Your home' },
  { id: 'household', label: 'Housemates', hint: 'A shared place' },
  { id: 'company', label: 'A company', hint: 'An office or studio' },
  { id: 'building', label: 'A building', hint: 'Residents or tenants' },
  { id: 'other', label: 'Something else', hint: 'Any real place' },
] as const;

// Sora (sky), moss, stone, kinari (unbleached silk), indigo mist, dusty sakura.

type Storage =
  | { mode: 'builtin' }
  | {
      mode: 'external';
      endpoint: string;
      region: string;
      bucket: string;
      accessKeyId: string;
      secretAccessKey: string;
    };

interface Offsite {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

const STEP_TITLES = [
  'Welcome',
  'Your group',
  'Your account',
  'Your address',
  'Storage',
  'Backups',
  'All set?',
];

export function Setup({ onComplete }: { onComplete: () => Promise<void> }) {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [code, setCode] = useState('');
  const [group, setGroup] = useState({
    name: '',
    kind: 'family' as (typeof KINDS)[number]['id'],
    themeColor: DEFAULT_GROUP_COLOUR,
  });
  const [architect, setArchitect] = useState({ name: '', email: '', password: '' });
  const [storage, setStorage] = useState<Storage>({ mode: 'builtin' });
  const [storageOk, setStorageOk] = useState(false);
  const [backup, setBackup] = useState({
    schedule: 'nightly' as 'nightly' | 'weekly' | 'off',
    keepDays: 14,
  });
  const [offsite, setOffsite] = useState<Offsite | null>(null);
  const [offsiteOk, setOffsiteOk] = useState(false);
  const copyOffsite = backup.schedule !== 'off' && offsite !== null;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const next = () => {
    setError(null);
    setStep((s) => s + 1);
  };
  const back = () => {
    setError(null);
    setStep((s) => Math.max(0, s - 1));
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    switch (step) {
      case 0:
        return run(async () => {
          await api('/api/setup/verify-code', { json: { code } });
          next();
        });
      case 4:
        if (storage.mode === 'external' && !storageOk) {
          return run(async () => {
            await api('/api/setup/test-storage', { json: { code, ...storage } });
            setStorageOk(true);
            next();
          });
        }
        return next();
      case 5:
        if (copyOffsite && !offsiteOk) {
          return run(async () => {
            await api('/api/setup/test-offsite', { json: { code, ...offsite } });
            setOffsiteOk(true);
            next();
          });
        }
        return next();
      case 6:
        return run(async () => {
          await api('/api/setup/complete', {
            json: {
              code,
              group,
              architect,
              storage,
              backup: { ...backup, offsite: copyOffsite ? offsite : undefined },
            },
          });
          await onComplete();
          navigate('/', { replace: true });
        });
      default:
        return next();
    }
  };

  const secure =
    window.location.protocol === 'https:' || window.location.hostname.endsWith('localhost');
  const kindLabel = KINDS.find((k) => k.id === group.kind)?.label ?? '';

  let body: ReactNode;
  let action = 'Continue';
  switch (step) {
    case 0:
      body = (
        <>
          <p style={{ margin: 0 }}>
            Let's set up your shared space. It takes about five minutes, and you can change
            everything later.
          </p>
          <Field
            label="Setup code"
            hint="The installer printed this when it finished (it looks like ABCD-EFGH-JKLM)."
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoComplete="one-time-code"
            autoCapitalize="characters"
            spellCheck={false}
            required
          />
        </>
      );
      action = 'Start';
      break;
    case 1:
      body = (
        <>
          <Field
            label="What should we call your space?"
            hint="For example “The Smith House” or “Studio 4B”. People will see this name."
            value={group.name}
            onChange={(e) => setGroup({ ...group, name: e.target.value })}
            maxLength={80}
            required
          />
          <div className="ats-field">
            <span className="ats-label">Who will use it?</span>
            <div className="ats-choice-grid">
              {KINDS.map((k) => (
                <Choice
                  key={k.id}
                  selected={group.kind === k.id}
                  onSelect={() => setGroup({ ...group, kind: k.id })}
                >
                  <span style={{ fontWeight: 500 }}>{k.label}</span>
                  <br />
                  <span className="ats-muted" style={{ fontSize: '0.85rem' }}>
                    {k.hint}
                  </span>
                </Choice>
              ))}
            </div>
          </div>
          <div className="ats-field">
            <span className="ats-label">Pick a colour</span>
            <ColourSwatches
              name="theme-color"
              value={group.themeColor}
              onChange={(c) => setGroup({ ...group, themeColor: c })}
            />
          </div>
        </>
      );
      break;
    case 2:
      body = (
        <>
          <p style={{ margin: 0 }}>
            You'll be the space's <strong>Architect</strong>: you build the space and bring people's
            ideas to life.
          </p>
          <Field
            label="Your name"
            value={architect.name}
            onChange={(e) => setArchitect({ ...architect, name: e.target.value })}
            autoComplete="name"
            required
          />
          <Field
            label="Email"
            type="email"
            value={architect.email}
            onChange={(e) => setArchitect({ ...architect, email: e.target.value })}
            autoComplete="email"
            required
          />
          <Field
            label="Password"
            type="password"
            hint="At least 10 characters. You can add a passkey (Face ID, fingerprint) afterwards."
            value={architect.password}
            onChange={(e) => setArchitect({ ...architect, password: e.target.value })}
            autoComplete="new-password"
            minLength={10}
            required
          />
        </>
      );
      break;
    case 3:
      body = (
        <>
          <p style={{ margin: 0 }}>People will visit your space at:</p>
          <p style={{ margin: 0, fontWeight: 700, wordBreak: 'break-all' }}>
            {window.location.origin}
          </p>
          <Notice>
            {secure
              ? '✓ The connection is secure. Nothing to do here.'
              : 'This address is not secure yet. Re-run the installer with your domain name to turn on HTTPS.'}
          </Notice>
        </>
      );
      break;
    case 4:
      body = (
        <>
          <p style={{ margin: 0 }}>Where should photos, your space and creations be stored?</p>
          <div className="ats-choice-grid">
            <Choice
              selected={storage.mode === 'builtin'}
              onSelect={() => setStorage({ mode: 'builtin' })}
            >
              <span style={{ fontWeight: 500 }}>On this server</span>
              <br />
              <span className="ats-muted">Recommended. Nothing to set up.</span>
            </Choice>
            <Choice
              selected={storage.mode === 'external'}
              onSelect={() => {
                setStorageOk(false);
                setStorage({
                  mode: 'external',
                  endpoint: '',
                  region: 'auto',
                  bucket: '',
                  accessKeyId: '',
                  secretAccessKey: '',
                });
              }}
            >
              <span style={{ fontWeight: 500 }}>My own bucket</span>
              <br />
              <span className="ats-muted">Any S3-compatible storage.</span>
            </Choice>
          </div>
          {storage.mode === 'external' &&
            (['endpoint', 'region', 'bucket', 'accessKeyId', 'secretAccessKey'] as const).map(
              (k) => (
                <Field
                  key={k}
                  label={
                    {
                      endpoint: 'Endpoint URL',
                      region: 'Region',
                      bucket: 'Bucket name',
                      accessKeyId: 'Access key ID',
                      secretAccessKey: 'Secret access key',
                    }[k]
                  }
                  type={k === 'secretAccessKey' ? 'password' : k === 'endpoint' ? 'url' : 'text'}
                  value={storage[k]}
                  onChange={(e) => {
                    setStorageOk(false);
                    setStorage({ ...storage, [k]: e.target.value });
                  }}
                  autoComplete="off"
                  required
                />
              ),
            )}
        </>
      );
      if (storage.mode === 'external' && !storageOk) action = 'Test and continue';
      break;
    case 5:
      body = (
        <>
          <p style={{ margin: 0 }}>How often should your space be backed up?</p>
          <div className="ats-choice-grid">
            {(['nightly', 'weekly', 'off'] as const).map((s) => (
              <Choice
                key={s}
                selected={backup.schedule === s}
                onSelect={() => setBackup({ ...backup, schedule: s })}
              >
                {{ nightly: 'Every night', weekly: 'Every week', off: 'Not now' }[s]}
              </Choice>
            ))}
          </div>
          {backup.schedule !== 'off' && (
            <Field
              label="Keep backups for (days)"
              type="number"
              inputMode="numeric"
              min={1}
              max={365}
              value={backup.keepDays}
              onChange={(e) => setBackup({ ...backup, keepDays: Number(e.target.value) || 14 })}
            />
          )}
          {backup.schedule !== 'off' && (
            <div className="ats-choice-grid">
              <Choice selected={offsite === null} onSelect={() => setOffsite(null)}>
                <span style={{ fontWeight: 500 }}>Keep them on this server</span>
              </Choice>
              <Choice
                selected={offsite !== null}
                onSelect={() => {
                  setOffsiteOk(false);
                  setOffsite({
                    endpoint: '',
                    region: 'auto',
                    bucket: '',
                    accessKeyId: '',
                    secretAccessKey: '',
                  });
                }}
              >
                <span style={{ fontWeight: 500 }}>Also copy them elsewhere</span>
                <br />
                <span className="ats-muted">Safe even if this server is lost.</span>
              </Choice>
            </div>
          )}
          {copyOffsite && (
            <>
              <p className="ats-muted" style={{ margin: 0 }}>
                Any S3-compatible storage, such as Backblaze B2 or Cloudflare R2. Use a private
                bucket: backups hold everything in your space.
              </p>
              {(['endpoint', 'region', 'bucket', 'accessKeyId', 'secretAccessKey'] as const).map(
                (k) => (
                  <Field
                    key={k}
                    label={
                      {
                        endpoint: 'Endpoint URL',
                        region: 'Region',
                        bucket: 'Bucket name',
                        accessKeyId: 'Access key ID',
                        secretAccessKey: 'Secret access key',
                      }[k]
                    }
                    type={k === 'secretAccessKey' ? 'password' : k === 'endpoint' ? 'url' : 'text'}
                    value={offsite[k]}
                    onChange={(e) => {
                      setOffsiteOk(false);
                      setOffsite({ ...offsite, [k]: e.target.value });
                    }}
                    autoComplete="off"
                    required
                  />
                ),
              )}
            </>
          )}
        </>
      );
      if (copyOffsite && !offsiteOk) action = 'Test and continue';
      break;
    default:
      body = (
        <dl
          style={{ margin: 0, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 16px' }}
        >
          <dt className="ats-muted">Space</dt>
          <dd style={{ margin: 0 }}>
            {group.name} · {kindLabel}
          </dd>
          <dt className="ats-muted">Architect</dt>
          <dd style={{ margin: 0 }}>
            {architect.name} ({architect.email})
          </dd>
          <dt className="ats-muted">Storage</dt>
          <dd style={{ margin: 0 }}>
            {storage.mode === 'builtin' ? 'On this server' : `Bucket “${storage.bucket}”`}
          </dd>
          <dt className="ats-muted">Backups</dt>
          <dd style={{ margin: 0 }}>
            {backup.schedule === 'off'
              ? 'Off'
              : `${backup.schedule === 'nightly' ? 'Nightly' : 'Weekly'}, kept ${backup.keepDays} days${
                  copyOffsite ? `, copied to “${offsite.bucket}”` : ''
                }`}
          </dd>
        </dl>
      );
      action = 'Finish setup';
  }

  return (
    <main className="ats-screen">
      <div className="ats-center">
        <div className="ats-container ats-stack">
          <BrandHeader />
          <Card page>
            <form className="ats-stack" onSubmit={onSubmit}>
              <Steps total={STEP_TITLES.length} current={step} />
              <h1>{STEP_TITLES[step]}</h1>
              {body}
              {error && <Notice tone="error">{error}</Notice>}
              <div className="ats-row" style={{ justifyContent: 'space-between' }}>
                {step > 0 ? (
                  <Button variant="ghost" onClick={back} disabled={busy}>
                    <Icon name="back" size={16} />
                    Back
                  </Button>
                ) : (
                  <span />
                )}
                <Button type="submit" variant="primary" disabled={busy}>
                  {busy ? 'One moment…' : action}
                  <Icon name="arrowRight" size={16} />
                </Button>
              </div>
            </form>
          </Card>
        </div>
      </div>
    </main>
  );
}
