import type { ProviderConfig } from '@shared/types';
import type { ProviderAdapter } from './base';
import { OpenAICompatibleAdapter } from './openai-compatible';
import { AnthropicAdapter } from './anthropic';
import { CodexAcpAdapter } from './codex-acp';
import { getSecret } from '../utils/secrets';
import { getDb } from '../db/client';
import { logger } from '../utils/logger';

const providers = new Map<string, ProviderAdapter>();

// Heuristic to pick the right adapter based on baseUrl / presetId
export function adapterFor(cfg: ProviderConfig): ProviderAdapter | null {
  if (!cfg.enabled) return null;
  // Codex uses the Agent Client Protocol adapter; it handles ChatGPT auth itself.
  if (cfg.presetId === 'codex') {
    return new CodexAcpAdapter(cfg);
  }
  const apiKey = getSecret(`provider:${cfg.id}`);
  // Anthropic has its own API shape; only use AnthropicAdapter for actual Anthropic hosts
  if (cfg.presetId === 'anthropic' || /anthropic\.com/.test(cfg.baseUrl)) {
    return new AnthropicAdapter(cfg, apiKey || '');
  }
  // OpenCode Zen / Go / OpenAI / Groq / OpenRouter / Ollama / Kimi all use OpenAI-compatible
  return new OpenAICompatibleAdapter(cfg, apiKey || '');
}

export function getAdapter(id: string): ProviderAdapter | null {
  if (providers.has(id)) return providers.get(id)!;
  const row = getDb().prepare('SELECT * FROM providers WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  const cfg = rowToConfig(row);
  const adapter = adapterFor(cfg);
  if (adapter) providers.set(id, adapter);
  return adapter;
}

export function clearAdapterCache(): void {
  for (const adapter of providers.values()) {
    try { void adapter.dispose?.(); } catch { /* best-effort cleanup */ }
  }
  providers.clear();
}

export async function shutdownAdapterCache(): Promise<void> {
  await Promise.allSettled([...providers.values()].map((adapter) => adapter.dispose?.()));
  providers.clear();
}

export async function closeConversationSessions(conversationId: string): Promise<void> {
  await Promise.allSettled([...providers.values()].map((adapter) => adapter.closeConversation?.(conversationId)));
}

export function listProviders(): ProviderConfig[] {
  const rows = getDb().prepare('SELECT * FROM providers ORDER BY name').all() as Record<string, unknown>[];
  return rows.map(rowToConfig);
}

export function getProviderConfig(id: string): ProviderConfig | null {
  const row = getDb().prepare('SELECT * FROM providers WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToConfig(row) : null;
}

function rowToConfig(row: Record<string, unknown>): ProviderConfig {
  // Don't include the actual API key in the config sent to the renderer;
  // use a boolean flag instead. The plaintext key stays in main only.
  return {
    id: row.id as string,
    presetId: row.preset_id as string | undefined,
    name: row.name as string,
    baseUrl: row.base_url as string,
    apiKey: '', // intentionally blank — renderer never sees the real key
    hasApiKey: !!getSecret(`provider:${row.id}`),
    enabled: row.enabled === 1,
    models: safeJson(row.models as string, []),
    customHeaders: safeJson(row.custom_headers as string, {}),
    modelsFetchedAt: row.models_fetched_at as number | undefined
  };
}

function safeJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

export async function testConnection(id: string): Promise<{ ok: boolean; error?: string; models?: string[] }> {
  const adapter = getAdapter(id);
  if (!adapter) return { ok: false, error: 'Provider not enabled' };
  try {
    const r = await adapter.testConnection();
    logger.info('provider', `test ${id} -> ${r.ok ? 'ok' : 'fail'}`, r.error);
    return r;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
