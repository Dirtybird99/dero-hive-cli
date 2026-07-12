import type { MediaProviderPreset } from './types';

// Media provider presets. These are minimal descriptions so the renderer can
// show a quick-start list; the actual API shapes live in src/main/media/*
// adapters. Keep the list focused on providers with stable, documented APIs
// plus the obvious local-server targets (ComfyUI / A1111 / OpenAI-compatible).
export const MEDIA_PROVIDER_PRESETS: MediaProviderPreset[] = [
  {
    id: 'openai-images',
    name: 'OpenAI (Images)',
    kind: 'image',
    requiresApiKey: true,
    apiKeyUrl: 'https://platform.openai.com/api-keys',
    notes: 'OpenAI /v1/images/generations. Works with dall-e-3, dall-e-2, and gpt-image-1. Get an API key at platform.openai.com.',
    defaultModel: 'dall-e-3',
    models: [
      { id: 'dall-e-3', label: 'DALL·E 3', kind: 'image', hint: '1024×1024, 1024×1792, 1792×1024' },
      { id: 'dall-e-2', label: 'DALL·E 2', kind: 'image', hint: '256/512/1024' },
      { id: 'gpt-image-1', label: 'GPT Image 1', kind: 'image', hint: '1024×1024, transparent backgrounds' }
    ]
  },
  {
    id: 'stability',
    name: 'Stability AI',
    kind: 'image',
    requiresApiKey: true,
    apiKeyUrl: 'https://platform.stability.ai/account/keys',
    notes: 'Stability AI REST endpoint. Models: SD3.5, SDXL, Core. Supports negative prompts, seeds, and CFG scale.',
    defaultModel: 'stable-image-core',
    models: [
      { id: 'stable-image-core', label: 'Stable Image Core', kind: 'image', hint: 'fast SDXL-class' },
      { id: 'sd3.5-large', label: 'SD3.5 Large', kind: 'image', hint: 'high quality' },
      { id: 'sd3.5-large-turbo', label: 'SD3.5 Large Turbo', kind: 'image', hint: 'fast SD3.5' },
      { id: 'sdxl-1.0', label: 'SDXL 1.0', kind: 'image', hint: '1024×1024' }
    ]
  },
  {
    id: 'pollinations',
    name: 'Pollinations.ai',
    kind: 'image',
    requiresApiKey: false,
    notes: 'Free, no-key image generation. Flux, SDXL, Turbo, Kandinsky. Rate-limited; great for quick prototyping.',
    defaultModel: 'flux',
    models: [
      { id: 'flux', label: 'Flux', kind: 'image', hint: 'best quality' },
      { id: 'flux-turbo', label: 'Flux Turbo', kind: 'image', hint: 'fast' },
      { id: 'sdxl', label: 'SDXL', kind: 'image', hint: 'classic SDXL' },
      { id: 'kandinsky', label: 'Kandinsky', kind: 'image', hint: 'artistic' }
    ]
  },
  {
    id: 'replicate',
    name: 'Replicate',
    kind: 'both',
    requiresApiKey: true,
    apiKeyUrl: 'https://replicate.com/account/api-tokens',
    notes: 'Replicate runs any model by its versioned identifier (owner/name:version or owner/name@hash). Image, video, and music/audio.',
    defaultModel: 'black-forest-labs/flux-schnell',
    models: [
      { id: 'black-forest-labs/flux-schnell', label: 'Flux Schnell', kind: 'image', hint: 'fast, free tier' },
      { id: 'black-forest-labs/flux-dev', label: 'Flux Dev', kind: 'image', hint: 'high quality' },
      { id: 'stability-ai/stable-video-diffusion', label: 'Stable Video Diffusion', kind: 'video', hint: 'img→video' },
      { id: 'tencent/hunyuan-video', label: 'Hunyuan Video', kind: 'video', hint: 'text→video' },
      { id: 'minimax/video-01', label: 'Video-01', kind: 'video', hint: 'text→video' },
      { id: 'minimax/video-01-live', label: 'Video-01 Live', kind: 'image', hint: 'i2v' },
      { id: 'meta/musicgen', label: 'MusicGen', kind: 'audio', hint: 'text→music' },
      { id: 'minimax/music-01', label: 'MiniMax Music-01', kind: 'audio', hint: 'song generation' }
    ]
  },
  {
    id: 'openai-tts',
    name: 'OpenAI (Speech)',
    kind: 'audio',
    requiresApiKey: true,
    apiKeyUrl: 'https://platform.openai.com/api-keys',
    notes: 'OpenAI /v1/audio/speech text-to-speech. Pick a voice (alloy, echo, fable, onyx, nova, shimmer). Returns MP3.',
    defaultModel: 'gpt-4o-mini-tts',
    models: [
      { id: 'gpt-4o-mini-tts', label: 'GPT-4o mini TTS', kind: 'audio', hint: 'latest, expressive' },
      { id: 'tts-1', label: 'TTS-1', kind: 'audio', hint: 'fast' },
      { id: 'tts-1-hd', label: 'TTS-1 HD', kind: 'audio', hint: 'higher quality' }
    ]
  },
  {
    id: 'elevenlabs',
    name: 'ElevenLabs (Speech)',
    kind: 'audio',
    requiresApiKey: true,
    apiKeyUrl: 'https://elevenlabs.io/app/settings/api-keys',
    notes: 'ElevenLabs text-to-speech. The "voice" field takes a voice id from your ElevenLabs voice library. Returns MP3.',
    defaultModel: 'eleven_multilingual_v2',
    models: [
      { id: 'eleven_multilingual_v2', label: 'Multilingual v2', kind: 'audio', hint: 'high quality, 29 languages' },
      { id: 'eleven_turbo_v2_5', label: 'Turbo v2.5', kind: 'audio', hint: 'low latency' },
      { id: 'eleven_flash_v2_5', label: 'Flash v2.5', kind: 'audio', hint: 'fastest' }
    ]
  },
  {
    id: 'comfyui',
    name: 'ComfyUI (local)',
    kind: 'both',
    requiresApiKey: false,
    baseUrl: 'http://127.0.0.1:8188',
    notes: 'ComfyUI local server with --api enabled. Submit a workflow JSON via the "workflow" model id, or use one of the named built-in helpers.',
    defaultModel: 'flux-schnell',
    models: [
      { id: 'flux-schnell', label: 'Flux Schnell', kind: 'image', hint: 'requires Flux checkpoint' },
      { id: 'sdxl', label: 'SDXL', kind: 'image', hint: 'requires SDXL checkpoint' },
      { id: 'svd', label: 'Stable Video Diffusion', kind: 'video', hint: 'img→video' },
      { id: 'workflow', label: 'Custom workflow JSON', kind: 'image', hint: 'paste workflow via options.workflow' }
    ]
  },
  {
    id: 'a1111',
    name: 'Automatic1111 (local)',
    kind: 'image',
    requiresApiKey: false,
    baseUrl: 'http://127.0.0.1:7860',
    notes: 'A1111 WebUI with --api enabled. txt2img + img2img. Negative prompts and seed honoured.',
    defaultModel: 'sd_xl_base_1.0',
    models: [
      { id: 'sd_xl_base_1.0', label: 'SDXL Base', kind: 'image', hint: '1024×1024' },
      { id: 'sd_v1-5', label: 'SD 1.5', kind: 'image', hint: '512×512' },
      { id: 'anything-v5', label: 'Anything V5', kind: 'image', hint: 'anime' }
    ]
  },
  {
    id: 'openai-compatible',
    name: 'Custom OpenAI-compatible',
    kind: 'image',
    requiresApiKey: true,
    notes: 'Any service exposing POST /v1/images/generations in the OpenAI shape (Together AI, Novita, AI/ML API, …).',
    defaultModel: 'flux-schnell',
    models: [
      { id: 'flux-schnell', label: 'Flux Schnell', kind: 'image' },
      { id: 'sdxl', label: 'SDXL', kind: 'image' },
      { id: 'sd3', label: 'SD3', kind: 'image' }
    ]
  }
];

export function findMediaPreset(id: string): MediaProviderPreset | undefined {
  return MEDIA_PROVIDER_PRESETS.find((p) => p.id === id);
}