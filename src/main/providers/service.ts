import { randomUUID } from 'node:crypto';
import type { ProviderConfig, ProviderModel } from '@shared/types';
import { applyKnownMetadata } from '@shared/modelMetadata';
import { findPreset } from '@shared/presets';
import { getDb } from '../db/client';
import { deleteSecret, getSecret, setSecret } from '../utils/secrets';
import { logger } from '../utils/logger';
import { fetchLiveModels } from './models';
import {
  evictProviderAdapter,
  getAdapter,
  getProviderApiKey,
  getProviderConfig,
  listProviders
} from './registry';

const MODEL_STALE_AFTER_MS = 60 * 60 * 1000;
const refreshes = new Map<string, Promise<ProviderRefreshResult>>();

export interface SaveProviderInput {
  id?: string;
  presetId?: string;
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  clearApiKey?: boolean;
  enabled?: boolean;
  models?: ProviderModel[];
  defaultModel?: string;
  customHeaders?: Record<string, string>;
}

export interface ProviderRefreshResult {
  ok: boolean;
  error?: string;
  models?: string[];
  fetchedAt?: number;
}

export interface ProviderSaveResult {
  provider: ProviderConfig;
  discovery: ProviderRefreshResult;
}

export interface ProviderMutationResult {
  ok: boolean;
  error?: string;
  provider?: ProviderConfig;
}

export async function saveProvider(input: SaveProviderInput): Promise<ProviderSaveResult> {
  const id = input.id?.trim() || `provider-${randomUUID().slice(0, 8)}`;
  const activeRefresh = refreshes.get(id);
  if (activeRefresh) await activeRefresh;
  const existing = getProviderConfig(id);
  const presetId = input.presetId ?? existing?.presetId;
  const preset = presetId ? findPreset(presetId) : undefined;
  const name = input.name?.trim() || existing?.name || preset?.name || id;
  const baseUrl = input.baseUrl ?? existing?.baseUrl ?? preset?.baseUrl ?? '';
  if (baseUrl) {
    let url: URL;
    try { url = new URL(baseUrl); } catch { throw new Error('Provider base URL must be a valid URL.'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Provider base URL must use http or https.');
    if (url.username || url.password) throw new Error('Provider credentials must not be embedded in the base URL.');
  }
  const enabled = input.enabled ?? existing?.enabled ?? true;
  const customHeaders = input.customHeaders ?? existing?.customHeaders ?? preset?.headers ?? {};
  const fallbackModel = input.defaultModel || preset?.defaultModel || 'default';
  const models = applyKnownMetadata(
    input.models?.length
      ? input.models
      : existing?.models.length
        ? existing.models
        : preset?.models.length
          ? preset.models
          : [{ id: fallbackModel, name: fallbackModel }]
  );

  if (input.clearApiKey || presetId === 'codex') deleteSecret(`provider:${id}`);
  else if (input.apiKey) setSecret(`provider:${id}`, input.apiKey);
  const apiKeyRef = getSecret(`provider:${id}`) ? `provider:${id}` : null;

  getDb().prepare(`
    INSERT INTO providers (id, preset_id, name, base_url, api_key_ref, enabled, models, custom_headers, models_fetched_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      preset_id = excluded.preset_id,
      name = excluded.name,
      base_url = excluded.base_url,
      api_key_ref = excluded.api_key_ref,
      enabled = excluded.enabled,
      models = excluded.models,
      custom_headers = excluded.custom_headers,
      updated_at = excluded.updated_at
  `).run(
    id,
    presetId || null,
    name,
    baseUrl,
    apiKeyRef,
    enabled ? 1 : 0,
    JSON.stringify(models),
    JSON.stringify(customHeaders),
    null,
    Date.now()
  );

  evictProviderAdapter(id);
  logger.info('providers', `saved ${name}`);
  const discovery = await refreshProviderModels(id);
  return { provider: getProviderConfig(id)!, discovery };
}

export function refreshProviderModels(id: string): Promise<ProviderRefreshResult> {
  const current = refreshes.get(id);
  if (current) return current;
  const refresh = refreshProviderModelsNow(id).finally(() => refreshes.delete(id));
  refreshes.set(id, refresh);
  return refresh;
}

async function refreshProviderModelsNow(id: string): Promise<ProviderRefreshResult> {
  const cfg = getProviderConfig(id);
  if (!cfg) return { ok: false, error: 'Provider not found' };

  try {
    if (cfg.presetId === 'codex') {
      const adapter = getAdapter(id);
      if (!adapter) return { ok: false, error: 'Codex provider not enabled' };
      const result = await adapter.testConnection();
      if (!result.ok || !result.models?.length) {
        return { ok: false, error: result.error || 'No models found' };
      }
      return updateProviderModels(id, result.models, cfg, result.modelDetails);
    }

    if (!cfg.baseUrl) return { ok: false, error: 'Base URL is required' };
    const result = await fetchLiveModels(cfg.baseUrl, getProviderApiKey(id) || '', cfg.presetId, cfg.customHeaders);
    if (!result.ok || !result.models?.length) {
      return { ok: false, error: result.error || 'Provider returned no models' };
    }
    return updateProviderModels(id, result.models, cfg, result.details);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function updateProviderModels(
  id: string,
  modelIds: string[],
  cfg: ProviderConfig,
  details?: Record<string, Partial<ProviderModel>>
): ProviderRefreshResult {
  const models = applyKnownMetadata(modelIds.map((modelId) => {
    const existing = cfg.models.find((model) => model.id === modelId);
    const detail = details?.[modelId];
    return {
      id: modelId,
      name: detail?.name || existing?.name || modelId,
      contextWindow: detail?.contextWindow,
      maxOutput: detail?.maxOutput,
      supportsVision: detail?.supportsVision,
      supportsTools: detail?.supportsTools,
      supportsAudio: detail?.supportsAudio,
      supportsReasoning: detail?.supportsReasoning,
      mediaKinds: detail?.mediaKinds,
      thinkingOptions: detail?.thinkingOptions
    };
  }));
  const now = Date.now();
  const updated = getDb().prepare(
    'UPDATE providers SET models = ?, models_fetched_at = ?, updated_at = ? WHERE id = ?'
  ).run(JSON.stringify(models), now, now, id);
  return updated.changes
    ? { ok: true, models: models.map((model) => model.id), fetchedAt: now }
    : { ok: false, error: 'Provider not found' };
}

export function setProviderEnabled(id: string, enabled: boolean): ProviderMutationResult {
  const updated = getDb().prepare('UPDATE providers SET enabled = ?, updated_at = ? WHERE id = ?')
    .run(enabled ? 1 : 0, Date.now(), id);
  evictProviderAdapter(id);
  if (!updated.changes) return { ok: false, error: 'Provider not found' };
  return { ok: true, provider: getProviderConfig(id)! };
}

export function removeProvider(id: string): ProviderMutationResult {
  const removed = getDb().prepare('DELETE FROM providers WHERE id = ?').run(id);
  deleteSecret(`provider:${id}`);
  evictProviderAdapter(id);
  return removed.changes ? { ok: true } : { ok: false, error: 'Provider not found' };
}

export async function refreshStaleProviders(): Promise<ProviderRefreshResult[]> {
  const now = Date.now();
  const stale = listProviders().filter((provider) =>
    provider.enabled &&
    provider.presetId !== 'codex' &&
    !!provider.baseUrl &&
    (!provider.modelsFetchedAt || now - provider.modelsFetchedAt > MODEL_STALE_AFTER_MS)
  );
  return Promise.all(stale.map((provider) => refreshProviderModels(provider.id)));
}
