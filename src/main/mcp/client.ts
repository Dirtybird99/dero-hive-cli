import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { ToolDefinition } from '@shared/types';

export interface McpServerInstance {
  id: string;
  client: Client;
  transport: Transport;
  status: 'connecting' | 'connected' | 'error' | 'disconnected';
  error?: string;
  /** Mirrors McpServerConfig.trust — tools from an untrusted server need approval. */
  trust?: boolean;
  timeoutMs?: number;
  tools: ToolDefinition[];
  resources: { name: string; uri: string; description?: string; mimeType?: string }[];
  prompts: { name: string; description?: string; arguments?: unknown[] }[];
}

export class McpConnectionError extends Error {
  constructor(message: string) { super(message); this.name = 'McpConnectionError'; }
}

export const MCP_RESULT_MAX_BYTES = 256 * 1024;
export const MCP_RESULT_MAX_STRING_BYTES = 128 * 1024;
export const MCP_RESULT_MAX_ITEMS = 256;
export const MCP_RESULT_MAX_DEPTH = 8;

interface NormalizeState {
  bytes: number;
  items: number;
  truncated: boolean;
  seen: WeakSet<object>;
}

function boundedUtf8(value: string, maxBytes: number): { text: string; bytes: number; truncated: boolean } {
  if (maxBytes <= 0) return { text: '', bytes: 0, truncated: value.length > 0 };
  let candidate = value.length > maxBytes ? value.slice(0, maxBytes) : value;
  const candidateBytes = Buffer.byteLength(candidate, 'utf8');
  if (candidateBytes <= maxBytes) {
    return { text: candidate, bytes: candidateBytes, truncated: candidate.length < value.length };
  }

  let low = 0;
  let high = candidate.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(candidate.slice(0, middle), 'utf8') <= maxBytes) low = middle;
    else high = middle - 1;
  }
  candidate = candidate.slice(0, low);
  return { text: candidate, bytes: Buffer.byteLength(candidate, 'utf8'), truncated: true };
}

function boundedString(value: string, state: NormalizeState, maxBytes = MCP_RESULT_MAX_STRING_BYTES): string {
  const bounded = boundedUtf8(value, Math.min(maxBytes, Math.max(0, MCP_RESULT_MAX_BYTES - state.bytes)));
  state.bytes += bounded.bytes;
  state.truncated ||= bounded.truncated;
  return bounded.text;
}

function boundedValue(value: unknown, depth: number, state: NormalizeState): unknown {
  if (state.items >= MCP_RESULT_MAX_ITEMS) {
    state.truncated = true;
    return '[item limit reached]';
  }
  state.items += 1;

  if (typeof value === 'string') return boundedString(value, state);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return `[${typeof value}]`;
  if (depth >= MCP_RESULT_MAX_DEPTH) {
    state.truncated = true;
    return '[depth limit reached]';
  }
  if (state.seen.has(value)) {
    state.truncated = true;
    return '[circular reference]';
  }

  state.seen.add(value);
  try {
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      for (let i = 0; i < value.length; i += 1) {
        if (state.items >= MCP_RESULT_MAX_ITEMS) {
          state.truncated = true;
          break;
        }
        out.push(boundedValue(value[i], depth + 1, state));
      }
      return out;
    }

    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const rawKey in value as Record<string, unknown>) {
      if (!Object.prototype.hasOwnProperty.call(value, rawKey)) continue;
      if (state.items >= MCP_RESULT_MAX_ITEMS) {
        state.truncated = true;
        break;
      }
      const key = boundedString(rawKey, state, 1024);
      out[key] = boundedValue((value as Record<string, unknown>)[rawKey], depth + 1, state);
    }
    return out;
  } catch {
    state.truncated = true;
    return '[unreadable value]';
  } finally {
    state.seen.delete(value);
  }
}

function renderContentItem(value: unknown, state: NormalizeState): string {
  if (value && typeof value === 'object') {
    try {
      const text = (value as { text?: unknown }).text;
      if (typeof text === 'string') return String(boundedValue(text, 0, state));
    } catch {
      state.items += 1;
      state.truncated = true;
      return '[unreadable MCP content item]';
    }
  }
  if (typeof value === 'string') return String(boundedValue(value, 0, state));
  return JSON.stringify(boundedValue(value, 0, state));
}

/** Convert protocol content into the text stored in chat without copying unbounded results. */
export function normalizeMcpToolResult(value: unknown): { content: string; truncated: boolean } {
  const state: NormalizeState = { bytes: 0, items: 0, truncated: false, seen: new WeakSet() };
  const parts: string[] = [];
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      if (state.items >= MCP_RESULT_MAX_ITEMS) {
        state.truncated = true;
        break;
      }
      parts.push(renderContentItem(value[i], state));
    }
  } else {
    parts.push(renderContentItem(value, state));
  }

  let content = parts.join('\n');
  if (Buffer.byteLength(content, 'utf8') > MCP_RESULT_MAX_BYTES) state.truncated = true;
  if (!state.truncated) return { content, truncated: false };

  const suffix = '\n... [MCP result truncated by safety limits]';
  const payload = boundedUtf8(content, MCP_RESULT_MAX_BYTES - Buffer.byteLength(suffix, 'utf8'));
  content = payload.text + suffix;
  return { content, truncated: true };
}
