import type { ProviderModel, MediaKind } from '@shared/types';

export interface ModelMetadata {
  contextWindow: number;
  maxOutput?: number;
  supportsVision?: boolean;
  supportsTools?: boolean;
  supportsAudio?: boolean;
  supportsReasoning?: boolean;
}

// Context windows / max output verified against OpenRouter's live catalog
// (2026-07). These are fallbacks for gateways that report no metadata (OpenCode);
// providers that DO report it live (OpenRouter, Ollama) override these values.
export const KNOWN_MODELS: Record<string, ModelMetadata> = {
  // OpenAI
  'gpt-5.5': { contextWindow: 1_050_000, maxOutput: 128_000, supportsVision: true, supportsTools: true },
  'gpt-5.5-pro': { contextWindow: 1_050_000, maxOutput: 128_000, supportsVision: true, supportsTools: true },
  'gpt-5.4': { contextWindow: 1_050_000, maxOutput: 128_000, supportsVision: true, supportsTools: true },
  'gpt-5.4-pro': { contextWindow: 1_050_000, maxOutput: 128_000, supportsVision: true, supportsTools: true },
  'gpt-5.4-mini': { contextWindow: 400_000, maxOutput: 128_000, supportsVision: true, supportsTools: true },
  'gpt-5.4-nano': { contextWindow: 400_000, maxOutput: 128_000, supportsVision: true, supportsTools: true },
  'gpt-5.3-codex': { contextWindow: 400_000, maxOutput: 128_000, supportsVision: true, supportsTools: true },
  'gpt-5.3-codex-spark': { contextWindow: 400_000, maxOutput: 128_000, supportsVision: true, supportsTools: true },
  'gpt-5.2': { contextWindow: 400_000, maxOutput: 128_000, supportsVision: true, supportsTools: true },
  'gpt-5.2-codex': { contextWindow: 400_000, maxOutput: 128_000, supportsVision: true, supportsTools: true },
  'gpt-5.1': { contextWindow: 400_000, maxOutput: 128_000, supportsVision: true, supportsTools: true },
  'gpt-5.1-codex': { contextWindow: 400_000, maxOutput: 128_000, supportsVision: true, supportsTools: true },
  'gpt-5.1-codex-max': { contextWindow: 400_000, maxOutput: 128_000, supportsVision: true, supportsTools: true },
  'gpt-5.1-codex-mini': { contextWindow: 400_000, maxOutput: 100_000, supportsVision: true, supportsTools: true },
  'gpt-5': { contextWindow: 400_000, maxOutput: 128_000, supportsVision: true, supportsTools: true },
  'gpt-5-codex': { contextWindow: 400_000, maxOutput: 128_000, supportsVision: true, supportsTools: true },
  'gpt-5-nano': { contextWindow: 400_000, maxOutput: 128_000, supportsVision: true, supportsTools: true },

  // xAI Grok
  'grok-4.5': { contextWindow: 500_000, supportsVision: true, supportsTools: true, supportsReasoning: true },
  'grok-build-0.1': { contextWindow: 256_000, supportsTools: true },
  'gpt-4o': { contextWindow: 128_000, maxOutput: 16_384, supportsVision: true, supportsTools: true },
  'gpt-4o-mini': { contextWindow: 128_000, maxOutput: 16_384, supportsVision: true, supportsTools: true },
  'gpt-4-turbo': { contextWindow: 128_000, maxOutput: 4_096, supportsVision: true, supportsTools: true },
  'gpt-4': { contextWindow: 8_192, maxOutput: 4_096, supportsVision: false, supportsTools: true },
  'gpt-3.5-turbo': { contextWindow: 16_385, maxOutput: 4_096, supportsVision: false, supportsTools: true },

  // Anthropic
  'claude-fable-5': { contextWindow: 1_000_000, maxOutput: 128_000, supportsVision: true, supportsTools: true, supportsReasoning: true },
  'claude-opus-4.8': { contextWindow: 1_000_000, maxOutput: 128_000, supportsVision: true, supportsTools: true, supportsReasoning: true },
  'claude-opus-4.7': { contextWindow: 1_000_000, maxOutput: 128_000, supportsVision: true, supportsTools: true, supportsReasoning: true },
  'claude-opus-4.6': { contextWindow: 1_000_000, maxOutput: 128_000, supportsVision: true, supportsTools: true, supportsReasoning: true },
  'claude-opus-4.5': { contextWindow: 200_000, maxOutput: 64_000, supportsVision: true, supportsTools: true, supportsReasoning: true },
  'claude-opus-4.1': { contextWindow: 200_000, maxOutput: 32_000, supportsVision: true, supportsTools: true, supportsReasoning: true },
  'claude-sonnet-5': { contextWindow: 1_000_000, maxOutput: 128_000, supportsVision: true, supportsTools: true, supportsReasoning: true },
  'claude-sonnet-4.6': { contextWindow: 1_000_000, maxOutput: 128_000, supportsVision: true, supportsTools: true, supportsReasoning: true },
  // sonnet 4 / 4.5: a 1M-context beta exists but needs an opt-in header — assume the standard 200k
  'claude-sonnet-4.5': { contextWindow: 200_000, maxOutput: 64_000, supportsVision: true, supportsTools: true, supportsReasoning: true },
  'claude-sonnet-4': { contextWindow: 200_000, maxOutput: 64_000, supportsVision: true, supportsTools: true, supportsReasoning: true },
  'claude-haiku-4.5': { contextWindow: 200_000, maxOutput: 64_000, supportsVision: true, supportsTools: true, supportsReasoning: true },
  'claude-3-5-sonnet-latest': { contextWindow: 200_000, maxOutput: 8_192, supportsVision: true, supportsTools: true, supportsReasoning: true },
  'claude-3-5-haiku-latest': { contextWindow: 200_000, maxOutput: 8_192, supportsVision: true, supportsTools: true, supportsReasoning: true },
  'claude-3-opus-latest': { contextWindow: 200_000, maxOutput: 8_192, supportsVision: true, supportsTools: true, supportsReasoning: true },
  'claude-3-sonnet-latest': { contextWindow: 200_000, maxOutput: 8_192, supportsVision: true, supportsTools: true, supportsReasoning: true },
  'claude-3-haiku-latest': { contextWindow: 200_000, maxOutput: 8_192, supportsVision: true, supportsTools: true, supportsReasoning: true },

  // Google Gemini
  'gemini-2.5-pro': { contextWindow: 1_048_576, maxOutput: 8_192, supportsVision: true, supportsTools: true },
  'gemini-2.5-flash': { contextWindow: 1_048_576, maxOutput: 8_192, supportsVision: true, supportsTools: true },
  'gemini-2.0-flash': { contextWindow: 1_048_576, maxOutput: 8_192, supportsVision: true, supportsTools: true },
  'gemini-1.5-flash': { contextWindow: 1_048_576, maxOutput: 8_192, supportsVision: true, supportsTools: true },
  'gemini-1.5-pro': { contextWindow: 2_097_152, maxOutput: 8_192, supportsVision: true, supportsTools: true },
  'gemini-1.5-flash-8b': { contextWindow: 1_048_576, maxOutput: 8_192, supportsVision: true, supportsTools: true },
  'gemini-pro': { contextWindow: 32_768, maxOutput: 8_192, supportsVision: false, supportsTools: true },
  'gemini-pro-vision': { contextWindow: 32_768, maxOutput: 4_096, supportsVision: true, supportsTools: true },

  // Groq
  'llama-3.3-70b-versatile': { contextWindow: 131_072, maxOutput: 32_768, supportsVision: false, supportsTools: true },
  'llama-3.1-8b-instant': { contextWindow: 131_072, maxOutput: 131_072, supportsVision: false, supportsTools: true },
  'mixtral-8x7b-32768': { contextWindow: 32_768, maxOutput: 4_096, supportsVision: false, supportsTools: true },

  // OpenCode Zen / Go
  'big-pickle': { contextWindow: 128_000, maxOutput: 8_192, supportsVision: true, supportsTools: true },

  // MiniMax M-series
  'MiniMax-M3': { contextWindow: 1_048_576, maxOutput: 131_072, supportsVision: true, supportsTools: true, supportsReasoning: true },
  'MiniMax-M3-mini': { contextWindow: 204_800, maxOutput: 131_072, supportsVision: true, supportsTools: true, supportsReasoning: true },
  'MiniMax-M2.7': { contextWindow: 204_800, maxOutput: 196_608, supportsVision: true, supportsTools: true, supportsReasoning: true },
  'MiniMax-M2.5': { contextWindow: 204_800, maxOutput: 196_608, supportsVision: true, supportsTools: true, supportsReasoning: true },
  'MiniMax-M2': { contextWindow: 204_800, maxOutput: 131_072, supportsVision: true, supportsTools: true, supportsReasoning: true },
  'MiniMax-M2-mini': { contextWindow: 204_800, maxOutput: 131_072, supportsVision: true, supportsTools: true, supportsReasoning: true },

  // Kimi / Moonshot
  'kimi-k2.7-code': { contextWindow: 262_144, maxOutput: 262_144, supportsVision: true, supportsTools: true },
  'kimi-k2.7-code-highspeed': { contextWindow: 262_144, maxOutput: 262_144, supportsVision: true, supportsTools: true },
  'kimi-k2.6': { contextWindow: 262_144, maxOutput: 262_144, supportsVision: true, supportsTools: true },
  'kimi-k2.5': { contextWindow: 262_144, maxOutput: 100_352, supportsVision: true, supportsTools: true },
  // Official stable IDs exposed by https://api.kimi.com/coding — do not
  // rename; Kimi's docs guarantee these strings.
  'kimi-for-coding': { contextWindow: 262_144, maxOutput: 262_144, supportsVision: false, supportsTools: true },
  'kimi-for-coding-highspeed': { contextWindow: 262_144, maxOutput: 262_144, supportsVision: false, supportsTools: true },
  'kimi-k2-0711-preview': { contextWindow: 131_072, maxOutput: 100_352, supportsVision: false, supportsTools: true },
  'moonshot-v1-8k': { contextWindow: 8_192, maxOutput: 8_192, supportsVision: false, supportsTools: true },
  'moonshot-v1-32k': { contextWindow: 32_768, maxOutput: 8_192, supportsVision: false, supportsTools: true },
  'moonshot-v1-128k': { contextWindow: 131_072, maxOutput: 8_192, supportsVision: false, supportsTools: true },

  // GLM (Zhipu / Z.ai)
  'glm-5.2': { contextWindow: 1_048_576, maxOutput: 101_376, supportsVision: false, supportsTools: true, supportsReasoning: true },
  'glm-5.1': { contextWindow: 202_752, maxOutput: 128_000, supportsVision: false, supportsTools: true, supportsReasoning: true },
  'glm-5': { contextWindow: 202_752, maxOutput: 131_072, supportsVision: false, supportsTools: true, supportsReasoning: true },
  'glm-4.7': { contextWindow: 202_752, maxOutput: 131_072, supportsVision: false, supportsTools: true, supportsReasoning: true },
  'glm-4.6': { contextWindow: 202_752, maxOutput: 131_072, supportsVision: false, supportsTools: true, supportsReasoning: true },

  // DeepSeek
  'deepseek-v4-pro': { contextWindow: 1_048_576, maxOutput: 131_072, supportsVision: false, supportsTools: true, supportsReasoning: true },
  'deepseek-v4-flash': { contextWindow: 1_048_576, maxOutput: 65_536, supportsVision: false, supportsTools: true, supportsReasoning: true },

  // Qwen (Alibaba)
  'qwen3.7-max': { contextWindow: 1_000_000, maxOutput: 65_536, supportsVision: false, supportsTools: true, supportsReasoning: true },
  'qwen3.7-plus': { contextWindow: 1_000_000, maxOutput: 65_536, supportsVision: false, supportsTools: true, supportsReasoning: true },
  'qwen3.6-plus': { contextWindow: 1_000_000, maxOutput: 65_536, supportsVision: false, supportsTools: true, supportsReasoning: true },
  'qwen3.5-plus': { contextWindow: 1_000_000, maxOutput: 65_536, supportsVision: false, supportsTools: true, supportsReasoning: true },

  // Xiaomi MiMo / Tencent Hunyuan / NVIDIA / Cohere
  'mimo-v2.5-pro': { contextWindow: 1_048_576, maxOutput: 131_072, supportsVision: true, supportsTools: true },
  'mimo-v2.5': { contextWindow: 1_048_576, maxOutput: 65_536, supportsVision: true, supportsTools: true },
  'hy3-preview': { contextWindow: 262_144, maxOutput: 65_536, supportsVision: false, supportsTools: true },
  'hy3': { contextWindow: 262_144, maxOutput: 65_536, supportsVision: false, supportsTools: true },
  'nemotron-3-ultra': { contextWindow: 1_000_000, maxOutput: 65_536, supportsVision: false, supportsTools: true },
  'north-mini-code': { contextWindow: 256_000, maxOutput: 64_000, supportsVision: false, supportsTools: true },

  // Google Gemini 3.x (as served via gateways)
  'gemini-3.5-flash': { contextWindow: 1_048_576, maxOutput: 65_536, supportsVision: true, supportsTools: true },
  'gemini-3.1-pro': { contextWindow: 1_048_576, maxOutput: 65_536, supportsVision: true, supportsTools: true },
  'gemini-3-flash': { contextWindow: 1_048_576, maxOutput: 65_535, supportsVision: true, supportsTools: true },

  // Ollama (local)
  'llama3.2': { contextWindow: 128_000, maxOutput: 4_096, supportsVision: false, supportsTools: false },
  'llama3.1': { contextWindow: 128_000, maxOutput: 4_096, supportsVision: false, supportsTools: false },
  'llama3': { contextWindow: 128_000, maxOutput: 4_096, supportsVision: false, supportsTools: false },
  'mistral': { contextWindow: 32_768, maxOutput: 4_096, supportsVision: false, supportsTools: false },
  'codellama': { contextWindow: 128_000, maxOutput: 4_096, supportsVision: false, supportsTools: false },
  'mixtral': { contextWindow: 32_768, maxOutput: 4_096, supportsVision: false, supportsTools: false },
  'qwen2.5-coder': { contextWindow: 32_768, maxOutput: 4_096, supportsVision: false, supportsTools: false },
  'qwen2.5': { contextWindow: 32_768, maxOutput: 4_096, supportsVision: false, supportsTools: false },

  // OpenRouter known models (OpenRouter reports live metadata that overrides these)
  'anthropic/claude-sonnet-4.5': { contextWindow: 1_000_000, maxOutput: 64_000, supportsVision: true, supportsTools: true, supportsReasoning: true },
  'openai/gpt-4o': { contextWindow: 128_000, maxOutput: 16_384, supportsVision: true, supportsTools: true },
  'openai/gpt-5.5': { contextWindow: 1_050_000, maxOutput: 128_000, supportsVision: true, supportsTools: true },
  'openai/gpt-5.4': { contextWindow: 1_050_000, maxOutput: 128_000, supportsVision: true, supportsTools: true },
  'openai/gpt-5.4-mini': { contextWindow: 400_000, maxOutput: 128_000, supportsVision: true, supportsTools: true },
  'google/gemini-2.0-flash': { contextWindow: 1_048_576, maxOutput: 8_192, supportsVision: true, supportsTools: true },
  'google/gemini-2.5-pro': { contextWindow: 1_048_576, maxOutput: 8_192, supportsVision: true, supportsTools: true },
  'google/gemini-2.5-flash': { contextWindow: 1_048_576, maxOutput: 8_192, supportsVision: true, supportsTools: true },
};

// Live model IDs vary in separator and case across gateways: OpenCode serves
// "claude-sonnet-4-5" / "minimax-m3" where the table above uses
// "claude-sonnet-4.5" / "MiniMax-M3". Normalize both sides so metadata
// (context window, vision/tool support) still applies.
function normalizeId(id: string): string {
  // Free-tier variants (deepseek-v4-flash-free, qwen3-coder:free) share the
  // base model's limits — strip the suffix before matching.
  return id.toLowerCase().replace(/(:free|-free)$/, '').replace(/[._]/g, '-');
}

const NORMALIZED_MODELS: Record<string, ModelMetadata> = Object.fromEntries(
  Object.entries(KNOWN_MODELS).map(([id, meta]) => [normalizeId(id), meta])
);

export function getModelMetadata(modelId: string): ModelMetadata | null {
  return KNOWN_MODELS[modelId]
    ?? NORMALIZED_MODELS[normalizeId(modelId)]
    // Ollama IDs carry a ":tag" suffix (llama3.2:latest) — match on the family
    ?? NORMALIZED_MODELS[normalizeId(modelId.split(':')[0])]
    ?? null;
}

export function applyKnownMetadata(models: ProviderModel[]): ProviderModel[] {
  return models.map((m) => {
    const mediaKinds = m.mediaKinds && m.mediaKinds.length ? m.mediaKinds : mediaKindsForModel(m.id);
    const withMedia = mediaKinds.length ? { ...m, mediaKinds } : m;
    const known = getModelMetadata(withMedia.id);
    if (!known) return withMedia;
    return {
      ...withMedia,
      contextWindow: withMedia.contextWindow ?? known.contextWindow,
      maxOutput: withMedia.maxOutput ?? known.maxOutput,
      supportsVision: withMedia.supportsVision ?? known.supportsVision,
      supportsTools: withMedia.supportsTools ?? known.supportsTools,
      supportsAudio: withMedia.supportsAudio ?? known.supportsAudio,
      supportsReasoning: withMedia.supportsReasoning ?? known.supportsReasoning
    };
  });
}

// Media generation models are identified from their id. Text/chat models return
// [] and stay out of Vision → Media. Matched case-insensitively against the id
// (with a normalized copy so gpt_image / gpt-image both hit). Deliberately
// conservative: whisper/transcribe are speech *input*, not generation.
const IMAGE_MODEL_RE = /(dall-?e|gpt-image|image-1|imagen|\bflux\b|sdxl|sd-?3|sd-?xl|stable-diffusion|stable-image|ideogram|kandinsky|recraft|seedream|playground-v|aura-flow|kolors|hidream|nano-banana|grok-image|firefly)/;
const VIDEO_MODEL_RE = /(sora|veo|\bkling\b|runway|gen-?3|gen-?4|\bwan\b|hunyuan-video|\bltx\b|mochi|\bpika\b|seedance|cogvideo|hailuo|marey|minimax\/video|video-0)/;
const AUDIO_MODEL_RE = /(tts|text-to-speech|\bspeech\b|musicgen|music-0|stable-audio|audiogen|lyria|\bsuno\b|\bbark\b|\bxtts\b|orpheus|eleven_|elevenlabs|dia-tts|\bkokoro\b)/;

export function mediaKindsForModel(modelId: string): MediaKind[] {
  const id = modelId.toLowerCase();
  const norm = normalizeId(modelId);
  const hay = `${id} ${norm}`;
  // whisper/transcription are input, not generation — never tag as audio.
  if (/whisper|transcrib/.test(id)) return [];
  const kinds: MediaKind[] = [];
  if (VIDEO_MODEL_RE.test(hay)) kinds.push('video');
  if (IMAGE_MODEL_RE.test(hay)) kinds.push('image');
  if (AUDIO_MODEL_RE.test(hay)) kinds.push('audio');
  return kinds;
}
