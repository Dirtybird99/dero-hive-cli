import type { ProviderModel, ThinkingOption } from './types';

const OPENAI_EFFORTS: ThinkingOption[] = [
  { id: 'low', label: 'Low', description: 'Brief reasoning' },
  { id: 'medium', label: 'Medium', description: 'Balanced reasoning' },
  { id: 'high', label: 'High', description: 'Deep reasoning' }
];

const OPENAI_GPT5_EFFORTS: ThinkingOption[] = [
  { id: 'minimal', label: 'Minimal', description: 'Fastest reasoning' },
  ...OPENAI_EFFORTS
];

const OPENAI_XHIGH_EFFORTS: ThinkingOption[] = [
  ...OPENAI_EFFORTS,
  { id: 'xhigh', label: 'Extra high', description: 'Maximum available reasoning' }
];

const ANTHROPIC_EFFORTS: ThinkingOption[] = [
  { id: 'low', label: 'Low', description: 'Up to 1,024 thinking tokens' },
  { id: 'medium', label: 'Medium', description: 'Up to 4,096 thinking tokens' },
  { id: 'high', label: 'High', description: 'Up to 8,192 thinking tokens' }
];

// Safe UI fallback when a gateway does not publish per-model reasoning
// capabilities. Exact provider/model entries above always take precedence.
const DEFAULT_EFFORTS: ThinkingOption[] = [
  { id: 'low', label: 'Low', description: 'Brief reasoning' },
  { id: 'medium', label: 'Medium', description: 'Balanced reasoning' },
  { id: 'high', label: 'High', description: 'Deep reasoning' }
];

// A missing entry means no provider-specific thinking field is sent, keeping
// otherwise valid requests from failing on unsupported models.
export function thinkingOptionsFor(
  presetId: string | undefined,
  modelId: string | undefined,
  modelMetadata?: Pick<ProviderModel, 'supportsReasoning' | 'thinkingOptions'>
): ThinkingOption[] {
  const model = (modelId || '').toLowerCase();

  // ACP reports the exact values accepted by the selected Codex model.
  if (presetId === 'codex') return modelMetadata?.thinkingOptions?.length
    ? modelMetadata.thinkingOptions
    : DEFAULT_EFFORTS;

  // Kimi Code's published OpenAI-compatible API documents the endpoint and
  // model IDs, but not a selectable thinking-effort request field.
  // Extended thinking is supported by Claude 3.7 and the Claude 4+ families.
  // Older Claude 3 / 3.5 models accept neither the `thinking` request object
  // nor a thinking budget, so never show a control for them.
  if (presetId === 'anthropic') {
    return /^(claude-(?:3-7|(?:opus|sonnet|haiku|fable)-[4-9]))(?:[-.:]|$)/.test(model)
      ? ANTHROPIC_EFFORTS
      : [];
  }
  if (presetId === 'openai') {
    // Pro models are Responses-API-only; this adapter uses Chat Completions.
    if (/^gpt-5(?:\.(?:2|3|4|5)|-(?:2|3|4|5))-pro(?:[-.:]|$)/.test(model)) return [];
    // GPT-5 exposes `minimal`; GPT-5.1 accepts low/medium/high; later
    // standard and Codex variants add xhigh.
    if (/^gpt-5(?:\.(?:2|3|4|5)|-(?:2|3|4|5))/.test(model)) return OPENAI_XHIGH_EFFORTS;
    if (/^gpt-5(?:$|-\d{4}-\d{2}-\d{2}$)/.test(model)) return OPENAI_GPT5_EFFORTS;
    if (/^gpt-5(?:\.1|-(?:1)(?:[-.:]|$))/.test(model)) return OPENAI_EFFORTS;
    return /^(o[1-4](?:-|$)|gpt-5(?:-|$))/.test(model) ? OPENAI_EFFORTS : [];
  }

  // Other OpenAI-compatible providers may expose reasoning content, but each
  // uses a different request field. Do not show a selector until that field is
  // implemented for the specific provider/model.
  return DEFAULT_EFFORTS;
}

/** True when the UI is using generic fallback levels rather than model data. */
export function usesDefaultThinkingOptions(
  presetId: string | undefined,
  modelId: string | undefined,
  modelMetadata?: Pick<ProviderModel, 'thinkingOptions'>
): boolean {
  if (modelMetadata?.thinkingOptions?.length) return false;
  const model = (modelId || '').toLowerCase();
  if (presetId === 'codex') return true;
  if (presetId === 'anthropic') {
    return !/^(claude-(?:3-7|(?:opus|sonnet|haiku|fable)-[4-9]))(?:[-.:]|$)/.test(model);
  }
  if (presetId === 'openai') {
    return !/^(o[1-4](?:-|$)|gpt-5(?:-|$))/.test(model);
  }
  return true;
}

export function supportsOpenAIReasoningEffort(presetId: string | undefined, modelId: string): boolean {
  return presetId === 'openai' && !usesDefaultThinkingOptions(presetId, modelId);
}

export function supportsAnthropicExtendedThinking(presetId: string | undefined, modelId: string): boolean {
  return presetId === 'anthropic'
    && /^(claude-(?:3-7|(?:opus|sonnet|haiku|fable)-[4-9]))(?:[-.:]|$)/.test(modelId.toLowerCase());
}

export function anthropicThinkingBudget(effort: Exclude<import('./types').ThinkingEffort, 'off'>): number {
  return effort === 'low' ? 1_024 : effort === 'medium' ? 4_096 : 8_192;
}
