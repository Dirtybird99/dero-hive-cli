import type { ProviderAdapter, ProviderStreamRequest, ProviderStreamEvent } from './base';
import { parseSSE } from './streaming';
import type { ProviderConfig, ContentPart } from '@shared/types';
import { logger, redactSensitive } from '../utils/logger';
import { anthropicThinkingBudget, supportsAnthropicExtendedThinking } from '@shared/thinkingCapabilities';

// Anthropic Messages API adapter. Translates OpenAI-style internal types to Anthropic format.
// Supports: system prompt, multi-modal (images), tools, prompt caching, extended thinking.
export class AnthropicAdapter implements ProviderAdapter {
  readonly id: string;
  constructor(private readonly cfg: ProviderConfig, private readonly apiKey: string) {
    this.id = cfg.id;
  }

  private safeError(value: string): string {
    const redacted = redactSensitive(value);
    return this.apiKey ? redacted.replaceAll(this.apiKey, '[REDACTED]') : redacted;
  }

  async testConnection(): Promise<{ ok: boolean; error?: string; models?: string[] }> {
    try {
      const r = await fetch(`${this.cfg.baseUrl.replace(/\/$/, '')}/models`, {
        headers: this.headers()
      });
      if (!r.ok) return { ok: false, error: `HTTP ${r.status} ${r.statusText}` };
      const data = (await r.json()) as { data?: { id: string }[] };
      return { ok: true, models: (data.data || []).map((m) => m.id) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      ...(this.cfg.customHeaders || {})
    };
  }

  private toAnthropicMessages(messages: { role: string; content: string | ContentPart[]; toolCalls?: unknown; toolCallId?: string }[]): unknown[] {
    const out: unknown[] = [];
    for (const m of messages) {
      if (m.role === 'system') {
        // Anthropic carries the system prompt in the top-level `system` field
        // and rejects a system role inside `messages`. Dropping these outright
        // would discard the <context_compaction> summary, which compaction
        // writes as a system message after deleting the history it replaces —
        // so the conversation would lose that context entirely. Carry it
        // through as a marked user turn instead.
        const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        if (text) out.push({ role: 'user', content: [{ type: 'text', text: `[system note]\n${text}` }] });
      } else if (m.role === 'user') {
        out.push({ role: 'user', content: this.toAnthropicContent(m.content) });
      } else if (m.role === 'assistant') {
        const blocks: unknown[] = [];
        if (typeof m.content === 'string' && m.content) blocks.push({ type: 'text', text: m.content });
        else if (Array.isArray(m.content)) {
          for (const p of m.content) if (p.type === 'text') blocks.push({ type: 'text', text: p.text });
        }
        if (m.toolCalls && Array.isArray(m.toolCalls)) {
          for (const tc of m.toolCalls as Array<{ id: string; function: { name: string; arguments: string } }>) {
            blocks.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.function.name,
              input: safeJsonParse(tc.function.arguments)
            });
          }
        }
        if (blocks.length) out.push({ role: 'assistant', content: blocks });
      } else if (m.role === 'tool' && m.toolCallId) {
        // Tool results get folded into user message as tool_result blocks
        const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        out.push({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content }]
        });
      }
    }
    return out;
  }

  private toAnthropicContent(c: string | ContentPart[]): unknown {
    if (typeof c === 'string') return c;
    const blocks: unknown[] = [];
    for (const p of c) {
      if (p.type === 'text') blocks.push({ type: 'text', text: p.text });
      else if (p.type === 'image_url') {
        const url = p.image_url.url;
        if (url.startsWith('data:')) {
          const [meta, data] = url.split(',');
          const mime = meta.match(/data:([^;]+)/)?.[1] || 'image/png';
          blocks.push({ type: 'image', source: { type: 'base64', media_type: mime, data } });
        } else {
          blocks.push({ type: 'image', source: { type: 'url', url } });
        }
      } else if (p.type === 'file' && p.file.mimeType === 'application/pdf') {
        blocks.push({
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: p.file.data }
        });
      } else if (p.type === 'file' && /^(text\/|application\/(json|javascript|xml))/u.test(p.file.mimeType)) {
        blocks.push({ type: 'text', text: `[Attached file: ${p.file.filename}]\n${Buffer.from(p.file.data, 'base64').toString('utf8')}` });
      }
    }
    return blocks;
  }

  async *stream(req: ProviderStreamRequest): AsyncGenerator<ProviderStreamEvent> {
    const hasAudio = req.messages.some((message) => Array.isArray(message.content)
      && message.content.some((part) => part.type === 'input_audio'));
    if (hasAudio) {
      yield { type: 'error', error: 'This Anthropic adapter does not support audio attachments. Switch to an audio-capable model/provider or attach a transcript.' };
      return;
    }
    const url = `${this.cfg.baseUrl.replace(/\/$/, '')}/messages`;
    const messages = this.toAnthropicMessages(req.messages as never[]);

    const thinkingBudget = req.reasoning?.effort && supportsAnthropicExtendedThinking(this.cfg.presetId, req.model)
      ? anthropicThinkingBudget(req.reasoning.effort)
      : undefined;
    const body: Record<string, unknown> = {
      model: req.model,
      // Anthropic requires the output limit to exceed the thinking budget.
      max_tokens: Math.max(req.maxTokens || 8192, thinkingBudget ? thinkingBudget + 1024 : 0),
      messages
    };
    if (req.systemPrompt) body.system = req.systemPrompt;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.topP !== undefined) body.top_p = req.topP;

    if (req.tools && req.tools.length) {
      body.tools = req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters
      }));
    }

    if (thinkingBudget) {
      (body as Record<string, unknown>).thinking = { type: 'enabled', budget_tokens: thinkingBudget };
    }

    logger.debug('anthropic', `POST ${url} model=${req.model}`);

    const response = await fetch(url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: req.signal
    });

    if (!response.ok) {
      const errText = await response.text();
      yield { type: 'error', error: `${response.status} ${response.statusText}: ${this.safeError(errText.slice(0, 500))}` };
      return;
    }

    const toolAcc = new Map<string, { id: string; name: string; arguments: string }>();
    let usage: { input_tokens?: number; output_tokens?: number } | undefined;

    for await (const evt of parseSSE(response, req.signal)) {
      const data = evt.data as Record<string, unknown> | undefined;
      if (!data) continue;
      const type = data.type as string;

      if (type === 'content_block_start') {
        const block = data.content_block as { type: string; id?: string; name?: string };
        if (block.type === 'tool_use' && block.id && block.name) {
          toolAcc.set(String(data.index), { id: block.id, name: block.name, arguments: '' });
        }
      } else if (type === 'content_block_delta') {
        const delta = data.delta as { type: string; text?: string; thinking?: string; partial_json?: string };
        const idx = String(data.index);
        if (delta.type === 'text_delta' && delta.text) yield { type: 'delta', content: delta.text };
        else if (delta.type === 'thinking_delta' && delta.thinking) yield { type: 'reasoning', reasoning: delta.thinking };
        else if (delta.type === 'input_json_delta' && delta.partial_json) {
          const acc = toolAcc.get(idx);
          if (acc) acc.arguments += delta.partial_json;
        }
      } else if (type === 'content_block_stop') {
        const acc = toolAcc.get(String(data.index));
        if (acc) {
          yield { type: 'tool_calls', toolCalls: [acc] };
          toolAcc.delete(String(data.index));
        }
      } else if (type === 'message_delta') {
        // message_delta usage carries output_tokens only — merge so we keep
        // the input_tokens reported in message_start.
        const u = (data as { usage?: typeof usage }).usage;
        if (u) usage = { ...usage, ...u };
      } else if (type === 'message_start') {
        const m = data.message as { usage?: typeof usage };
        if (m?.usage) usage = { ...usage, ...m.usage };
      } else if (type === 'error') {
        const e = data.error as { message?: string };
        yield { type: 'error', error: e.message || JSON.stringify(data) };
        return;
      }
    }

    if (usage) {
      yield {
        type: 'usage',
        usage: {
          promptTokens: usage.input_tokens || 0,
          completionTokens: usage.output_tokens || 0,
          totalTokens: (usage.input_tokens || 0) + (usage.output_tokens || 0)
        }
      };
    }
    yield { type: 'done' };
  }
}

function safeJsonParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return {}; }
}
