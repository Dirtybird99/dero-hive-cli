import type { ProviderPreset } from './types';

// Minimal preset metadata. The actual model list is fetched live from each
// provider's /models endpoint on save — these are just fallbacks for first-run
// UX so the dropdown isn't empty before refresh completes.
export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'opencode-zen',
    name: 'OpenCode Zen',
    baseUrl: 'https://opencode.ai/zen/v1',
    apiKeyUrl: 'https://opencode.ai/auth',
    docsUrl: 'https://opencode.ai/docs',
    defaultModel: 'claude-sonnet-4-5',
    supportsTools: true,
    supportsVision: true,
    notes: 'OpenCode Zen — full multi-model gateway (Claude, GPT, Gemini, …). Requires a Zen API key with credits; a Go-subscription key will NOT work here — use the OpenCode Go preset instead. Model list fetched live.',
    models: []
  },
  {
    id: 'opencode-go',
    name: 'OpenCode Go',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    apiKeyUrl: 'https://opencode.ai/auth',
    docsUrl: 'https://opencode.ai/docs',
    defaultModel: 'minimax-m3',
    supportsTools: true,
    notes: 'OpenCode Go subscription gateway (MiniMax, Kimi, GLM, DeepSeek, Qwen). Requires your Go API key. Model list fetched live.',
    models: []
  },
  {
    id: 'minimax',
    name: 'MiniMax M3',
    baseUrl: 'https://api.MiniMax.io/v1',
    apiKeyUrl: 'https://platform.MiniMax.io',
    defaultModel: 'MiniMax-M3',
    supportsTools: true,
    supportsReasoning: true,
    notes: 'MiniMax M-series. Model list fetched live when you save.',
    models: []
  },
  {
    id: 'kimi',
    name: 'Kimi Code (kimi-for-coding)',
    baseUrl: 'https://api.kimi.com/coding/v1',
    apiKeyUrl: 'https://www.kimi.com',
    docsUrl: 'https://www.kimi.com',
    defaultModel: 'kimi-for-coding',
    supportsTools: true,
    notes: 'Kimi Code subscription endpoint — exposes only the coding models (kimi-for-coding and, for Allegretto+ plans, kimi-for-coding-highspeed). HighSpeed ≈ 5–6× output speed but costs ~3× quota. The base URL already includes /coding/v1; do not edit. For the full Kimi/Moonshot catalog use the Moonshot AI preset.',
    models: []
  },
  {
    id: 'moonshot',
    name: 'Moonshot AI (full Kimi catalog)',
    baseUrl: 'https://api.moonshot.ai/v1',
    apiKeyUrl: 'https://platform.moonshot.ai/console/api-keys',
    defaultModel: 'kimi-k2-0711-preview',
    supportsTools: true,
    notes: 'Full Moonshot platform catalog (all Kimi models). Requires a platform.moonshot.ai API key — a Kimi-for-Coding subscription key will not work here. Model list fetched live.',
    models: []
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    apiKeyUrl: 'https://platform.openai.com/api-keys',
    defaultModel: 'gpt-4o-mini',
    supportsTools: true,
    supportsVision: true,
    supportsAudio: true,
    notes: 'OpenAI. Model list fetched live when you save.',
    models: []
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    apiKeyUrl: 'https://console.anthropic.com/settings/keys',
    defaultModel: 'claude-sonnet-4-5',
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
    notes: 'Native Anthropic Messages API. Model list fetched live when you save.',
    models: []
  },
  {
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKeyUrl: 'https://console.groq.com/keys',
    defaultModel: 'llama-3.3-70b-versatile',
    supportsTools: true,
    notes: 'Groq inference. Model list fetched live when you save.',
    models: []
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyUrl: 'https://openrouter.ai/keys',
    defaultModel: 'anthropic/claude-sonnet-4.5',
    supportsTools: true,
    notes: 'Routes to any model. Model list fetched live when you save.',
    models: []
  },
  {
    id: 'ollama',
    name: 'Ollama (local)',
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: 'llama3.2',
    supportsTools: true,
    notes: 'Local Ollama via its OpenAI-compatible /v1 endpoint. No API key needed. Installed models are fetched from the local server.',
    models: []
  },
  {
    id: 'codex',
    name: 'Codex (ChatGPT)',
    baseUrl: '',
    defaultModel: '',
    supportsTools: true,
    notes: 'OpenAI Codex via the Agent Client Protocol adapter. Uses ChatGPT subscription auth (browser login) or an API key. Requires @agentclientprotocol/codex-acp to be installed or set via command path.',
    models: []
  },
  {
    id: 'custom',
    name: 'Custom OpenAI-compatible',
    baseUrl: '',
    defaultModel: '',
    supportsTools: true,
    notes: 'Any OpenAI Chat Completions endpoint. Models auto-fetched on save.',
    models: []
  }
];

export function findPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id);
}