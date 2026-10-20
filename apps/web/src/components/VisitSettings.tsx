import { Confirm, Notice, Section } from '@ats/ui';
import { useEffect, useState } from 'react';
import { loadVisitSettings, saveVisitSettings } from '../lib/group.ts';
import '../routes/studio.css';

/**
 * For Architects: whether the group records where people spend time. Turning it off deletes what
 * was recorded, so it asks first.
 */
export function VisitSettings({ groupId }: { groupId: string }) {
  const [on, setOn] = useState<boolean | null>(null);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    loadVisitSettings(groupId).then(
      (r) => setOn(r.visits),
      () => {},
    );
  }, [groupId]);

  const save = async (visits: boolean) => {
    setBusy(true);
    setSaved(false);
    setError(null);
    try {
      await saveVisitSettings(groupId, visits);
      setOn(visits);
      setAsking(false);
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Where people spend time">
      {error && <Notice tone="error">{error}</Notice>}
      <label className="studio-check">
        <input
          type="checkbox"
          checked={on ?? false}
          disabled={on === null || busy}
          onChange={(e) => (e.target.checked ? void save(true) : setAsking(true))}
        />
        <span>
          Record where people spend time{' '}
          {saved && (
            <span className="ats-muted" role="status" style={{ fontSize: '0.85rem' }}>
              · saved
            </span>
          )}
          <span className="ats-muted studio-small studio-check-hint">
            How long each person spends in each room and creation, which only Architects see (on a
            place’s Studio page and on People); turning it off deletes everything recorded so far.
          </span>
        </span>
      </label>
      {asking && (
        <Confirm
          confirm="Turn off and delete"
          cancel="Keep recording"
          busy={busy}
          onConfirm={() => void save(false)}
          onCancel={() => setAsking(false)}
        >
          Nothing more is recorded, and the time already recorded in every place and creation of the
          group is deleted now. Turning it back on starts again from nothing.
        </Confirm>
      )}
    </Section>
  );
}
