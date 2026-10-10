import { Button, Field, Section } from '@ats/ui';
import { useEffect, useState } from 'react';
import {
  loadStudioSettings,
  type StudioSettings as Settings,
  saveStudioSettings,
} from '../lib/workbench.ts';
import { AssistantPicker } from './AssistantPicker.tsx';
import '../routes/studio.css';

/**
 * How workspaces behave for the whole group: when they sleep, the model and effort they start
 * with, and what a creation needs before it goes live. Folded away unless `open` is given.
 */
export function StudioSettings({
  groupId,
  open: startOpen = false,
}: {
  groupId: string;
  open?: boolean;
}) {
  const [s, setS] = useState<Settings | null>(null);
  const [open, setOpen] = useState(startOpen);
  const [saved, setSaved] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open && !s) loadStudioSettings(groupId).then(setS, () => {});
  }, [open, s, groupId]);
  const save = async () => {
    if (!s) return;
    setSaving(true);
    setSaved(null);
    try {
      await saveStudioSettings(groupId, s);
      setSaved('Saved. New workspaces use these; open ones pick them up when they next wake.');
    } catch (e) {
      setSaved((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Section title="Studio settings">
      {!open ? (
        <div>
          <Button variant="ghost" onClick={() => setOpen(true)}>
            Show settings
          </Button>
        </div>
      ) : !s ? (
        <p className="ats-muted">Loading…</p>
      ) : (
        <div className="ats-stack studio-settings">
          <Field
            label="Put a workspace to sleep after it's quiet for (minutes): its Architect has stepped away, and the assistant isn't at work"
            type="number"
            min={5}
            max={240}
            value={s.idleMinutes}
            onChange={(e) => setS({ ...s, idleMinutes: Number(e.target.value) })}
          />
          <Field
            label="Once its Architect has stepped away, put a workspace to sleep after it's been awake for (hours), however busy the assistant"
            type="number"
            min={1}
            max={24}
            value={s.sessionHours}
            onChange={(e) => setS({ ...s, sessionHours: Number(e.target.value) })}
          />
          <p className="ats-muted studio-small" style={{ margin: 0 }}>
            The model and effort new workspaces start with (each workspace can choose its own).
          </p>
          <AssistantPicker
            assistants={[{ provider: 'claude', name: 'Claude Code' }]}
            value={{ provider: 'claude', model: s.claudeModel, effort: s.claudeEffort }}
            onChange={(c) => setS({ ...s, claudeModel: c.model, claudeEffort: c.effort })}
            lockProvider
            defaultLabel="No preference"
          />
          <AssistantPicker
            assistants={[{ provider: 'codex', name: 'Codex' }]}
            value={{ provider: 'codex', model: s.codexModel, effort: s.codexEffort }}
            onChange={(c) => setS({ ...s, codexModel: c.model, codexEffort: c.effort })}
            lockProvider
            defaultLabel="No preference"
          />
          <label className="studio-check">
            <input
              type="checkbox"
              checked={s.telemetry}
              onChange={(e) => setS({ ...s, telemetry: e.target.checked })}
            />
            Let the assistants send their makers usage statistics and error reports
          </label>
          <label className="studio-check">
            <input
              type="checkbox"
              checked={s.requireDeviceTest}
              onChange={(e) => setS({ ...s, requireDeviceTest: e.target.checked })}
            />
            A creation must be tried on a real phone or computer before it can go live
          </label>
          <label className="studio-check">
            <input
              type="checkbox"
              checked={s.deleteInputsAfterPublish}
              onChange={(e) => setS({ ...s, deleteInputsAfterPublish: e.target.checked })}
            />
            Delete a place’s floor plans and photos once it’s published
          </label>
          <label className="studio-check">
            <input
              type="checkbox"
              checked={s.openInternet}
              onChange={(e) => setS({ ...s, openInternet: e.target.checked })}
            />
            <span>
              Let assistants use the whole internet while they work
              <span className="ats-muted studio-small studio-check-hint">
                Otherwise they reach only their makers, npm, and free model, texture and code
                libraries. Wider access helps them find references and resources; it also means a
                web page could mislead them, so it’s off unless you choose it. Workspaces can never
                reach this server’s own network, and creations never use the internet. Takes effect
                the next time a workspace wakes.
              </span>
            </span>
          </label>
          <div className="studio-actions-row">
            <Button variant="primary" onClick={() => void save()} busy={saving}>
              {saving ? 'Saving…' : 'Save settings'}
            </Button>
          </div>
          {saved && <p className="ats-muted studio-small">{saved}</p>}
        </div>
      )}
    </Section>
  );
}
