import { Button, Icon, Notice } from '@ats/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { CreationHost } from '../components/CreationHost.tsx';
import { CreationMenu } from '../components/CreationMenu.tsx';
import { Passage, type PassagePhase } from '../components/Passage.tsx';
import type { Me } from '../lib/api.ts';
import { asPerson, type OpenedCreation, openCreation } from '../lib/creations.ts';
import { describeDevice, saveDeviceTest, smoothness } from '../lib/studio.ts';
import './creations.css';
import './space.css';

interface Sample {
  fps: number;
  frameMs: number;
  p50Ms?: number;
  p95Ms?: number;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
};

/**
 * "Try on this device": an Architect opens any version (a candidate, or an earlier one) full
 * screen, plays it, and sees how smoothly it ran here. Nothing it saves is kept.
 */
export function TryCreation({ me }: { me: Me }) {
  const { spaceId, creationId, versionId } = useParams();
  const navigate = useNavigate();
  const [opened, setOpened] = useState<OpenedCreation | null>(null);
  const person = useMemo(() => asPerson(me), [me]);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<PassagePhase>('held');
  const [progress, setProgress] = useState<number | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [done, setDone] = useState(false);
  const [saved, setSaved] = useState<'no' | 'saving' | 'yes'>('no');
  const samples = useRef<Sample[]>([]);
  const started = useRef(0);
  const [live, setLive] = useState<Sample | null>(null);

  useEffect(() => {
    if (!creationId || !versionId) return;
    openCreation(creationId, 'solo', { versionId }).then(setOpened, (e: Error) =>
      setError(e.message),
    );
  }, [creationId, versionId]);

  const result = useMemo(() => {
    if (!done || samples.current.length === 0) return null;
    const s = samples.current;
    return {
      seconds: Math.round((performance.now() - started.current) / 1000),
      fps: s.reduce((a, x) => a + x.fps, 0) / s.length,
      p50Ms: median(s.map((x) => x.p50Ms ?? 1000 / x.fps)),
      p95Ms: median(s.map((x) => x.p95Ms ?? x.frameMs)),
      worstMs: Math.max(...s.map((x) => x.frameMs)),
    };
  }, [done]);

  const back = () => navigate(`/space/${spaceId}/creations`);
  const save = async () => {
    if (!result || !creationId || !versionId) return;
    setSaved('saving');
    try {
      await saveDeviceTest(creationId, versionId, {
        device: describeDevice(),
        width: window.innerWidth,
        height: window.innerHeight,
        ...result,
      });
      setSaved('yes');
    } catch (e) {
      setError((e as Error).message);
      setSaved('no');
    }
  };

  if (done) {
    const s = result && smoothness(result.p95Ms);
    return (
      <main className="ats-screen">
        <div className="ats-container ats-stack">
          <h1>How it ran on this {describeDevice().split(' · ')[0]?.toLowerCase()}</h1>
          {!result ? (
            <p className="ats-muted">
              It wasn't open long enough to measure. Try it for at least ten seconds.
            </p>
          ) : (
            <>
              <p className="report-verdict" data-ok={s?.tone !== 'bad'}>
                {s?.word}: {Math.round(result.fps)} frames a second
              </p>
              <p className="ats-muted">
                Most frames took {result.p50Ms.toFixed(0)} ms, 95% within {result.p95Ms.toFixed(0)}{' '}
                ms (the slowest {result.worstMs.toFixed(0)} ms), over {result.seconds} seconds on{' '}
                {describeDevice()}.
              </p>
            </>
          )}
          {error && <Notice tone="error">{error}</Notice>}
          <div className="studio-actions" style={{ justifyContent: 'flex-start' }}>
            {result && saved !== 'yes' && (
              <Button variant="primary" onClick={() => void save()} disabled={saved === 'saving'}>
                {saved === 'saving' ? 'Saving…' : 'Keep this result'}
              </Button>
            )}
            <Button variant={saved === 'yes' ? 'primary' : 'ghost'} onClick={back}>
              {saved === 'yes' ? 'Saved: back to creations' : 'Back to creations'}
            </Button>
          </div>
        </div>
      </main>
    );
  }

  const problem = error ?? (person ? null : "You're signed out. Sign in again to try this.");
  return (
    <div>
      {problem && (
        <main className="ats-screen">
          <div className="ats-container ats-stack">
            <Notice tone="error">{problem}</Notice>
            <Button onClick={back}>Back to creations</Button>
          </div>
        </main>
      )}
      {opened && person && (
        <>
          <CreationHost
            opened={opened}
            mode="solo"
            me={person}
            tier="mid"
            leaving={leaving}
            onProgress={(v) => setProgress(v)}
            onReady={() => {
              started.current = performance.now();
              setPhase('out');
              setTimeout(() => setPhase('off'), 850);
            }}
            onLeft={() => setDone(true)}
            onToast={() => {}}
            onPerf={(p) => {
              samples.current.push(p);
              setLive(p);
            }}
          />
          <CreationMenu label="Menu">
            <div className="creation-menu-note" aria-live="polite">
              Trying version {opened.creation.version}
              {live ? ` · ${Math.round(live.fps)} fps` : ''}
            </div>
            <button
              type="button"
              className="creation-menu-item"
              onClick={() => setLeaving(true)}
              disabled={leaving}
            >
              <Icon name="back" />
              Done
            </button>
          </CreationMenu>
        </>
      )}
      {!problem && (
        <Passage
          phase={opened ? phase : 'held'}
          title={opened?.creation.title ?? ''}
          progress={progress}
        />
      )}
    </div>
  );
}
