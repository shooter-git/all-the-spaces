import type { Provider } from './vendor-clis.ts';

/**
 * The models and effort levels Architects can choose for each assistant, in its maker's own
 * names. Checked on 2026-10-01 against the versions this release installs: Claude Code 2.1.285
 * (`claude --help`, and the models it knows; Sonnet 5.5 arrived in 2.1.284) and Codex 0.159.3
 * (OpenAI's Codex model and configuration docs, and its `ReasoningEffort` values). (There's no GPT-6.1 Luna or any GPT-6 Terra yet.)
 * Haiku 5.5 (`claude-haiku-5-5`) added 2026-10-08, the day Anthropic released it; `--model`
 * passes the full name straight to the API, so it works on Claude Code 2.1.285. Lineups change
 * often: "Other" lets an Architect type any name the assistant accepts, and this list is updated
 * with each release.
 */
export interface Choice {
  value: string;
  label: string;
  /** A few words to help choose. */
  note?: string;
}

export const MODELS: Record<Provider, Choice[]> = {
  claude: [
    { value: 'claude-fable-5-1', label: 'Fable 5.1', note: 'most capable' },
    { value: 'claude-opus-5-5', label: 'Opus 5.5', note: 'deep work' },
    { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5', note: 'quicker, uses less of your plan' },
    { value: 'claude-sonnet-5', label: 'Sonnet 5' },
    { value: 'claude-haiku-5-5', label: 'Haiku 5.5', note: 'fastest' },
    { value: 'claude-haiku-4-5', label: 'Haiku 4.5' },
  ],
  codex: [
    { value: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', note: 'recommended' },
    { value: 'gpt-6-astra', label: 'GPT-6 Astra', note: 'most capable' },
    { value: 'gpt-6-sol', label: 'GPT-6 Sol' },
    { value: 'gpt-6-luna', label: 'GPT-6 Luna', note: 'efficient, up to Max effort' },
  ],
};

/** How hard the assistant thinks. Claude Code's `--effort`; Codex's `model_reasoning_effort`. */
export const EFFORTS: Record<Provider, Choice[]> = {
  claude: [
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
    { value: 'xhigh', label: 'Extra high' },
    { value: 'max', label: 'Max' },
  ],
  codex: [
    { value: 'low', label: 'Low', note: '“Light” in the ChatGPT apps' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
    { value: 'xhigh', label: 'Extra high' },
    { value: 'max', label: 'Max', note: 'more time on one task' },
    { value: 'ultra', label: 'Ultra', note: 'splits work across helpers; not on Luna' },
  ],
};

/** What a model name may look like (also any name typed under "Other"). */
export const MODEL_NAME = /^[\w.:-]{1,64}$/;

export const isEffort = (provider: Provider, effort: string | null | undefined) =>
  Boolean(effort && EFFORTS[provider].some((e) => e.value === effort));

/** "Opus 5.5" for a known model, or the name itself. */
export const modelLabel = (provider: Provider, model: string) =>
  MODELS[provider].find((m) => m.value === model)?.label ?? model;
export const effortLabel = (provider: Provider, effort: string) =>
  EFFORTS[provider].find((e) => e.value === effort)?.label ?? effort;

/**
 * The flags that start (or resume) an assistant with a model and effort. Values are checked
 * first, so they're safe on a command line.
 */
export function assistantFlags(
  provider: Provider,
  choice: { model?: string | null; effort?: string | null; telemetry?: boolean },
): string[] {
  const model = choice.model && MODEL_NAME.test(choice.model) ? choice.model : null;
  const effort = isEffort(provider, choice.effort) ? choice.effort : null;
  if (provider === 'claude')
    return [...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : [])];
  return [
    '-c check_for_update_on_startup=false',
    ...(model ? [`-c model="${model}"`] : []),
    ...(effort ? [`-c model_reasoning_effort="${effort}"`] : []),
    ...(choice.telemetry ? [] : ['-c analytics.enabled=false']),
  ];
}
