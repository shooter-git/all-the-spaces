import { Icon, IconButton, List, ListRow, Notice, Section } from '@ats/ui';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.ts';
import '../routes/studio.css';

interface Report {
  id: string;
  body: string;
  reason: string | null;
  sender: string;
  reporter: string;
  createdAt: string;
}

const KEEP: { value: number | null; label: string }[] = [
  { value: 7, label: 'A week' },
  { value: 30, label: 'A month' },
  { value: 90, label: 'Three months' },
  { value: 365, label: 'A year' },
  { value: null, label: 'Forever' },
];

/** For Architects: how long chat is kept, voice chat, and messages people have reported. */
export function ChatSettings({ groupId }: { groupId: string }) {
  const [retention, setRetention] = useState<number | null | undefined>(undefined);
  const [reports, setReports] = useState<Report[] | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Voice chat: allowed in this group, and whether the server has it at all. */
  const [voice, setVoice] = useState<{ on: boolean; available: boolean } | null>(null);

  const loadReports = useCallback(
    () =>
      api<{ reports: Report[] }>(`/api/groups/${groupId}/chat-reports`).then(
        (r) => setReports(r.reports),
        () => setReports([]),
      ),
    [groupId],
  );
  useEffect(() => {
    api<{ retentionDays: number | null; voice: boolean; voiceAvailable: boolean }>(
      `/api/groups/${groupId}/chat-settings`,
    ).then(
      (r) => {
        setRetention(r.retentionDays);
        setVoice({ on: r.voice, available: r.voiceAvailable });
      },
      () => {},
    );
    void loadReports();
  }, [groupId, loadReports]);

  /** Saves a change shown already; puts it back as it was if the server didn't take it. */
  const save = async (
    body: { retentionDays: number | null; voice?: boolean },
    undo: () => void,
  ) => {
    setSaved(false);
    setError(null);
    try {
      await api(`/api/groups/${groupId}/chat-settings`, { method: 'PUT', json: body });
      setSaved(true);
    } catch (e) {
      undo();
      setError((e as Error).message);
    }
  };
  const choose = (value: number | null) => {
    const before = retention;
    setRetention(value);
    void save({ retentionDays: value }, () => setRetention(before));
  };
  const allowVoice = (on: boolean) => {
    if (retention === undefined || !voice) return;
    const before = voice;
    setVoice({ ...voice, on });
    void save({ retentionDays: retention, voice: on }, () => setVoice(before));
  };

  const dismiss = async (id: string) => {
    setError(null);
    try {
      await api(`/api/chat/reports/${id}/resolve`, { method: 'POST' });
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    void loadReports();
  };

  return (
    <Section title="Chat">
      {error && <Notice tone="error">{error}</Notice>}
      <div className="ats-stack" style={{ gap: 8 }}>
        <span>
          Keep chat for{' '}
          {saved && (
            <span className="ats-muted" role="status" style={{ fontSize: '0.85rem' }}>
              · saved
            </span>
          )}
        </span>
        <div className="ats-choice-grid">
          {KEEP.map((k) => (
            <button
              key={String(k.value)}
              type="button"
              className="ats-choice"
              aria-pressed={retention === k.value}
              onClick={() => choose(k.value)}
              disabled={retention === undefined}
            >
              {k.label}
            </button>
          ))}
        </div>
        <p className="ats-muted" style={{ fontSize: '0.85rem' }}>
          Older messages are deleted every night.
        </p>
      </div>

      {voice?.available && (
        <label className="studio-check">
          <input
            type="checkbox"
            checked={voice.on}
            onChange={(e) => allowVoice(e.target.checked)}
            disabled={retention === undefined}
          />
          Voice chat: people can talk to whoever is in the same room, and in creations they share.
          Nothing is recorded. Turning it off ends any conversation straight away.
        </label>
      )}

      <div className="ats-stack" style={{ gap: 8 }}>
        <span>Reported messages</span>
        {reports?.length === 0 && <p className="ats-muted">Nothing has been reported.</p>}
        {reports && reports.length > 0 && (
          <List label="Reported messages">
            {reports.map((r) => (
              <ListRow
                key={r.id}
                lead={<Icon name="flag" />}
                title={`${r.sender}: ${r.body}`}
                meta={`Reported by ${r.reporter}${r.reason ? ` · “${r.reason}”` : ''} · ${new Date(r.createdAt).toLocaleDateString()}`}
                actions={
                  <IconButton
                    icon="check"
                    label="Dealt with: dismiss it"
                    onClick={() => dismiss(r.id)}
                  />
                }
              />
            ))}
          </List>
        )}
      </div>
    </Section>
  );
}
