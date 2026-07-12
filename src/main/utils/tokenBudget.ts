import type { Message, ProviderModel } from '@shared/types';

// Server-side counterpart of tokenManager.ts.
// Used by the main process chat loop to estimate context pressure and
// truncate tool outputs before sending to the model.

const CHARS_PER_TOKEN = 4; // English ~4 chars/token; OpenAI tiktoken ballpark.

export function estimateTokens(text: string | undefined | null): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateMessageTokens(m: Message): number {
  // Assistant usage.promptTokens is the FULL context size, not a per-message slice.
  // Count only completion tokens here; callers use latestPromptTokens() for true context size.
  if (m.role === 'assistant' && m.usage) {
    return m.usage.completionTokens;
  }
  let chars = 0;
  if (typeof m.content === 'string') chars = m.content.length;
  else if (Array.isArray(m.content)) {
    for (const part of m.content) {
      if ('text' in part && typeof part.text === 'string') chars += part.text.length;
      else if ('image_url' in part) chars += 170;
      else if ('input_audio' in part) chars += 200;
      else if ('file' in part && typeof part.file.data === 'string') chars += part.file.data.length / 4;
      else if (part.type === 'attachment_ref') chars += part.attachment.type === 'image' ? 170 : part.attachment.type === 'audio' ? 200 : part.attachment.size / 4;
    }
  }
  if (m.reasoning) chars += m.reasoning.length;
  if (m.name) chars += m.name.length;
  if (m.error) chars += m.error.length;
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * Returns the actual context size we just sent to the model on the latest turn.
 * Prefers the most recent assistant turn's `promptTokens` (ground truth from the API).
 */
export function latestContextTokens(systemPrompt: string | undefined, messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant' && m.usage?.promptTokens) {
      return m.usage.promptTokens;
    }
  }
  // No usage data — estimate from system + sum of message sizes.
  const sysTokens = systemPrompt ? estimateTokens(systemPrompt) : 0;
  const msgTokens = messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
  return sysTokens + msgTokens;
}

// Backward-compat alias used by auto-compaction. Returns the same value as
// latestContextTokens() so we still trigger compaction when usage is real.
export function estimateContextTokens(systemPrompt: string | undefined, messages: Message[]): number {
  return latestContextTokens(systemPrompt, messages);
}

export interface ContextInfo {
  used: number;
  limit: number;
  percent: number;
  level: 'ok' | 'warn' | 'high' | 'critical' | 'over';
}

export function calculateContextInfo(used: number, model?: ProviderModel | null, maxOutput = 4096): ContextInfo {
  const limit = model?.contextWindow || 128_000;
  // Reserve space for the model's response
  const effectiveLimit = Math.max(limit - maxOutput, 1024);
  const percent = Math.min(999, Math.round((used / effectiveLimit) * 100));
  let level: ContextInfo['level'] = 'ok';
  if (percent >= 100) level = 'over';
  else if (percent >= 95) level = 'critical';
  else if (percent >= 85) level = 'high';
  else if (percent >= 70) level = 'warn';
  return { used, limit: effectiveLimit, percent, level };
}

// Truncate tool output messages proportionally when context is high.
export function truncateMessagesForContext(
  messages: Message[],
  model: ProviderModel | null | undefined,
  systemPrompt?: string
): Message[] {
  const info = calculateContextInfo(estimateContextTokens(systemPrompt, messages), model);
  if (info.level === 'ok' || info.level === 'warn') return messages;

  // Aggressive limits at higher pressure
  const maxChars =
    info.level === 'high' ? 6000
    : info.level === 'critical' ? 3000
    : 1500;

  return messages.map((m) => {
    if (m.role !== 'tool' && m.role !== 'assistant') return m;
    if (typeof m.content !== 'string') return m;
    if (m.content.length <= maxChars) return m;
    return {
      ...m,
      content: m.content.slice(0, maxChars) + `\n... [truncated to ${maxChars} chars due to context pressure at ${info.percent}%]`
    };
  });
}