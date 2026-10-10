import { EFFORTS, MODELS, modelLabel } from '@ats/shared/assistants';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { type Assistant, loadStudioSettings, type Provider } from '../lib/workbench.ts';

/** Which assistant builds it, which of its maker's models, and how hard it thinks. */
export interface Picked {
  provider: Provider | '';
  /** Null: the group's default. */
  model: string | null;
  effort: string | null;
}

/** The group's defaults, to show what "the group's default" means. */
export interface AssistantDefaults {
  claudeModel: string | null;
  codexModel: string | null;
  claudeEffort: string | null;
  codexEffort: string | null;
}

const OTHER = '__other';

function Labelled({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string | undefined;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="ats-field">
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {hint && <span className="ats-hint">{hint}</span>}
    </div>
  );
}

/**
 * Choosing the assistant (when more than one is connected), its model and its effort, in each
 * maker's own names. "Other…" takes any model name the assistant accepts.
 */
export function AssistantPicker({
  assistants,
  value,
  onChange,
  defaults,
  lockProvider = false,
  defaultLabel = 'The group’s default',
}: {
  /** Connected assistants (installed and signed in). */
  assistants: Pick<Assistant, 'provider' | 'name'>[];
  value: Picked;
  onChange: (next: Picked) => void;
  defaults?: AssistantDefaults | null;
  /** The assistant is fixed (an existing workspace): only model and effort change. */
  lockProvider?: boolean;
  /** What the empty choice is called (in the group's settings: the assistant's own default). */
  defaultLabel?: string;
}) {
  const provider = value.provider || assistants[0]?.provider || '';
  const known = provider ? MODELS[provider].some((m) => m.value === value.model) : false;
  const [typing, setTyping] = useState(Boolean(value.model) && !known);
  if (!provider) return null;
  const name = assistants.find((a) => a.provider === provider)?.name ?? provider;
  const defaultModel = provider === 'claude' ? defaults?.claudeModel : defaults?.codexModel;
  const defaultEffort = provider === 'claude' ? defaults?.claudeEffort : defaults?.codexEffort;
  const effortName = (v: string | null | undefined) =>
    EFFORTS[provider].find((e) => e.value === v)?.label;
  const describe = (thing: string | undefined) =>
    thing ? `${defaultLabel} (${thing})` : `${defaultLabel} (${name} decides)`;

  return (
    <div className="assistant-picker">
      {!lockProvider && assistants.length > 1 && (
        <Labelled label="Who builds it?">
          {(id) => (
            <select
              id={id}
              className="ats-input"
              value={provider}
              onChange={(e) => {
                setTyping(false);
                onChange({ provider: e.target.value as Provider, model: null, effort: null });
              }}
            >
              {assistants.map((a) => (
                <option key={a.provider} value={a.provider}>
                  {a.name}
                </option>
              ))}
            </select>
          )}
        </Labelled>
      )}
      <Labelled
        label={`${name} model`}
        hint={typing ? `Any model name ${name} accepts.` : undefined}
      >
        {(id) => (
          <div className="assistant-model">
            <select
              id={id}
              className="ats-input"
              value={typing ? OTHER : (value.model ?? '')}
              onChange={(e) => {
                if (e.target.value === OTHER) {
                  setTyping(true);
                  return;
                }
                setTyping(false);
                onChange({ ...value, provider, model: e.target.value || null });
              }}
            >
              <option value="">
                {describe(defaultModel ? modelLabel(provider, defaultModel) : undefined)}
              </option>
              {MODELS[provider].map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                  {m.note ? ` — ${m.note}` : ''}
                </option>
              ))}
              <option value={OTHER}>Other…</option>
            </select>
            {typing && (
              <input
                className="ats-input"
                aria-label={`${name} model name`}
                placeholder={MODELS[provider][0]?.value}
                value={value.model ?? ''}
                maxLength={64}
                pattern="[\w.:-]+"
                onChange={(e) =>
                  onChange({ ...value, provider, model: e.target.value.trim() || null })
                }
              />
            )}
          </div>
        )}
      </Labelled>
      <Labelled label={`${name} effort`} hint="How long it thinks before acting.">
        {(id) => (
          <select
            id={id}
            className="ats-input"
            value={value.effort ?? ''}
            onChange={(e) => onChange({ ...value, provider, effort: e.target.value || null })}
          >
            <option value="">{describe(effortName(defaultEffort))}</option>
            {EFFORTS[provider].map((e) => (
              <option key={e.value} value={e.value}>
                {e.label}
                {e.note ? ` — ${e.note}` : ''}
              </option>
            ))}
          </select>
        )}
      </Labelled>
    </div>
  );
}

/** "Opus 5.5 · Max effort" (or the assistant's own defaults). */
export function describeChoice(
  provider: Provider,
  c: { model: string | null; effort: string | null },
) {
  const model = c.model ? modelLabel(provider, c.model) : 'default model';
  const effort = c.effort
    ? `${EFFORTS[provider].find((e) => e.value === c.effort)?.label ?? c.effort} effort`
    : 'default effort';
  return `${model} · ${effort}`;
}

/** A group's default models and efforts (for Architects; null until loaded, or if not one). */
export function useAssistantDefaults(groupId: string | null | undefined) {
  const [defaults, setDefaults] = useState<AssistantDefaults | null>(null);
  useEffect(() => {
    if (!groupId) return;
    loadStudioSettings(groupId).then(setDefaults, () => setDefaults(null));
  }, [groupId]);
  return defaults;
}
