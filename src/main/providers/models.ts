import { logger } from '../utils/logger';
import {
  MAX_PROVIDER_JSON_BYTES,
  PROVIDER_CONTROL_TIMEOUT_MS,
  providerRequestSignal,
  readProviderJson
} from './http';

// Per-model metadata some providers expose alongside the id (OpenRouter is the
// richest; Ollama reports capabilities). Live values beat our hardcoded table.
export interface LiveModelDetail {
  name?: string;
  contextWindow?: number;
  maxOutput?: number;
  supportsVision?: boolean;
  supportsTools?: boolean;
  supportsReasoning?: boolean;
}

export interface LiveModelsResult {
  ok: boolean;
  error?: string;
  models?: string[];
  details?: Record<string, LiveModelDetail>;
}

// Model ids that are clearly not chat models (embeddings, speech, images,
// moderation…). They pollute the model picker, so drop them.
const NON_CHAT_MODEL_RE = /(embed|whisper|tts|dall-?e|moderation|davinci|babbage|transcribe|realtime|gpt-image|-image-|sora|veo-|guard|rerank|-ocr)/i;

function filterChatModels(ids: string[]): string[] {
  const filtered = ids.filter((id) => !NON_CHAT_MODEL_RE.test(id));
  // If the filter wiped everything (unusual naming scheme), keep the originals.
  return filtered.length > 0 ? filtered : ids;
}

// Fetch the live model list from a provider's /models endpoint.
// Falls back to chat-completion probing if /models isn't supported.
export async function fetchLiveModels(
  baseUrl: string,
  apiKey: string,
  presetId?: string,
  customHeaders?: Record<string, string>
): Promise<LiveModelsResult> {
  const base = baseUrl.replace(/\/$/, '');
  const signal = providerRequestSignal(undefined, PROVIDER_CONTROL_TIMEOUT_MS);
  const headers: Record<string, string> = {
    ...customHeaders
  };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  // Anthropic uses a different auth scheme
  if (presetId === 'anthropic' || /anthropic\.com/.test(base)) {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
    delete headers['Authorization'];
  }

  // 0. Ollama: prefer /api/tags — unlike its bare-bones /v1/models endpoint it
  //    reports capabilities (tools/vision/thinking). Served at the server root,
  //    not under the /v1 OpenAI-compat path, so build it from the origin.
  if (presetId === 'ollama' || /:11434/.test(base)) {
    try {
      const tagsUrl = new URL('/api/tags', base).toString();
      logger.debug('models', `fetching ${tagsUrl}`);
      const r = await fetch(tagsUrl, { headers, signal });
      if (r.ok) {
        const data = await readProviderJson<unknown>(r, MAX_PROVIDER_JSON_BYTES, signal);
        const result = toResult(extractModels(data), tagsUrl);
        if (result) return result;
      } else void r.body?.cancel().catch(() => undefined);
    } catch { /* fall through to /models */ }
  }

  // 1. Try GET /models
  try {
    const url = `${base}/models`;
    logger.debug('models', `fetching ${url}`);
    const r = await fetch(url, { headers, signal });
    if (r.ok) {
      const data = await readProviderJson<unknown>(r, MAX_PROVIDER_JSON_BYTES, signal);
      const result = toResult(extractModels(data), url);
      if (result) return result;
    } else {
      void r.body?.cancel().catch(() => undefined);
      logger.debug('models', `${url} returned ${r.status}`);
    }
  } catch (err) {
    logger.debug('models', `/models probe failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2. Fallback: Anthropic's models endpoint uses ?limit parameter
  if (presetId === 'anthropic' || /anthropic\.com/.test(base)) {
    try {
      const r = await fetch(`${base}/models?limit=100`, { headers, signal });
      if (r.ok) {
        const data = await readProviderJson<unknown>(r, MAX_PROVIDER_JSON_BYTES, signal);
        const result = toResult(extractModels(data), 'anthropic ?limit');
        if (result) return result;
      } else void r.body?.cancel().catch(() => undefined);
    } catch { /* ignore */ }
  }

  return { ok: false, error: 'Could not retrieve model list from provider' };
}

function toResult(extracted: { ids: string[]; details: Record<string, LiveModelDetail> }, source: string): LiveModelsResult | null {
  const ids = filterChatModels(extracted.ids);
  logger.debug('models', `extracted ${extracted.ids.length} ids (${ids.length} chat models) from ${source}`);
  if (ids.length === 0) return null;
  return { ok: true, models: ids, details: extracted.details };
}

function extractModels(data: unknown): { ids: string[]; details: Record<string, LiveModelDetail> } {
  const ids: string[] = [];
  const details: Record<string, LiveModelDetail> = {};
  if (!data || typeof data !== 'object') return { ids, details };
  const d = data as Record<string, unknown>;

  // OpenAI/Anthropic shape: { data: [...] }; some gateways: { models: [...] };
  // rare: top-level array.
  const list = Array.isArray(d.data) ? d.data
    : Array.isArray(d.models) ? d.models
    : Array.isArray(data) ? data as unknown[]
    : [];

  for (const entry of list) {
    if (typeof entry === 'string') {
      ids.push(entry);
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const o = entry as Record<string, unknown>;
    const id = (o.id || o.name || o.model) as string | undefined;
    if (!id) continue;
    ids.push(id);
    const detail = extractDetail(o, id);
    if (detail) details[id] = detail;
  }
  return { ids, details };
}

// Pull whatever metadata the provider volunteers. Field names verified against
// OpenRouter (context_length, top_provider.max_completion_tokens, architecture,
// supported_parameters), Anthropic (display_name) and Ollama (capabilities).
function extractDetail(o: Record<string, unknown>, id: string): LiveModelDetail | null {
  const detail: LiveModelDetail = {};

  const displayName = (o.display_name || (typeof o.name === 'string' && o.name !== id ? o.name : undefined)) as string | undefined;
  if (displayName) detail.name = displayName;

  const topProvider = o.top_provider as { context_length?: number; max_completion_tokens?: number } | undefined;
  const ctx = (o.context_length ?? o.context_window ?? o.max_context_length ?? topProvider?.context_length) as number | undefined;
  if (typeof ctx === 'number' && ctx > 0) detail.contextWindow = ctx;

  const maxOut = (topProvider?.max_completion_tokens ?? o.max_output_tokens ?? o.max_completion_tokens) as number | undefined;
  if (typeof maxOut === 'number' && maxOut > 0) detail.maxOutput = maxOut;

  const arch = o.architecture as { input_modalities?: string[] } | undefined;
  if (Array.isArray(arch?.input_modalities)) {
    detail.supportsVision = arch.input_modalities.includes('image');
  }

  const params = o.supported_parameters as string[] | undefined;
  if (Array.isArray(params)) {
    detail.supportsTools = params.includes('tools');
    detail.supportsReasoning = params.includes('reasoning') || params.includes('include_reasoning');
  }

  // Ollama /api/tags: capabilities: ["completion","tools","thinking","vision"]
  const caps = o.capabilities as string[] | undefined;
  if (Array.isArray(caps)) {
    if (caps.includes('tools')) detail.supportsTools = true;
    if (caps.includes('thinking')) detail.supportsReasoning = true;
    if (caps.includes('vision')) detail.supportsVision = true;
  }

  return Object.keys(detail).length > 0 ? detail : null;
}
