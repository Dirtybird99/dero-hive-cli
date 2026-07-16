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
    notes: 'OpenAI Codex via the Agent Client Protocol adapter. Reuses the official Codex login or starts ChatGPT browser sign-in; Hive never stores the Codex credential.',
    models: []
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKeyUrl: 'https://platform.deepseek.com/api_keys',
    docsUrl: 'https://api-docs.deepseek.com/',
    defaultModel: 'deepseek-v4-flash',
    supportsTools: true,
    supportsReasoning: true,
    notes: 'DeepSeek OpenAI-compatible API. Bearer key; model list fetched live. If /v1 ever 404s, drop it (https://api.deepseek.com).',
    models: []
  },
  {
    id: 'mistral',
    name: 'Mistral AI',
    baseUrl: 'https://api.mistral.ai/v1',
    apiKeyUrl: 'https://console.mistral.ai/api-keys',
    docsUrl: 'https://docs.mistral.ai/api',
    defaultModel: 'mistral-large-latest',
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
    notes: 'Mistral platform (Mistral/Magistral/Pixtral). Bearer key; model list fetched live.',
    models: []
  },
  {
    id: 'xai',
    name: 'xAI (Grok)',
    baseUrl: 'https://api.x.ai/v1',
    apiKeyUrl: 'https://console.x.ai',
    docsUrl: 'https://docs.x.ai',
    defaultModel: 'grok-4.5',
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
    notes: 'xAI Grok, OpenAI-compatible. Bearer key; model list fetched live.',
    models: []
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKeyUrl: 'https://aistudio.google.com/apikey',
    docsUrl: 'https://ai.google.dev/gemini-api/docs/openai',
    defaultModel: 'gemini-3.5-flash',
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
    notes: 'Google Gemini via its OpenAI-compatible endpoint (Google AI Studio key). Base URL intentionally has no trailing slash. Model list fetched live.',
    models: []
  },
  {
    id: 'together',
    name: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    apiKeyUrl: 'https://api.together.ai/settings/api-keys',
    docsUrl: 'https://docs.together.ai/docs/openai-api-compatibility',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
    notes: 'Together AI open-model host. Bearer key; model ids are namespaced (provider/model). Model list fetched live.',
    models: []
  },
  {
    id: 'fireworks',
    name: 'Fireworks AI',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    apiKeyUrl: 'https://fireworks.ai/account/api-keys',
    docsUrl: 'https://docs.fireworks.ai/tools-sdks/openai-compatibility',
    defaultModel: 'accounts/fireworks/models/deepseek-v4-flash',
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
    notes: 'Fireworks AI. Bearer key. Model ids use the canonical accounts/fireworks/models/<slug> form. Its /models list is unreliable, so a seed list ships below; Refresh may still work.',
    models: [
      { id: 'accounts/fireworks/models/deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
      { id: 'accounts/fireworks/models/deepseek-v3p1-terminus', name: 'DeepSeek V3.1 Terminus' },
      { id: 'accounts/fireworks/models/llama-v3p3-70b-instruct', name: 'Llama 3.3 70B Instruct' },
      { id: 'accounts/fireworks/models/qwen2p5-72b-instruct', name: 'Qwen2.5 72B Instruct' },
      { id: 'accounts/fireworks/models/llama-v3p1-8b-instruct', name: 'Llama 3.1 8B Instruct' }
    ]
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    apiKeyUrl: 'https://cloud.cerebras.ai',
    docsUrl: 'https://inference-docs.cerebras.ai',
    defaultModel: 'gpt-oss-120b',
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
    notes: 'Cerebras ultra-fast inference. Bearer key; model list fetched live. Some models are dedicated-endpoint only depending on plan tier.',
    models: []
  },
  {
    id: 'perplexity',
    name: 'Perplexity (Sonar)',
    baseUrl: 'https://api.perplexity.ai',
    apiKeyUrl: 'https://www.perplexity.ai/settings/api',
    docsUrl: 'https://docs.perplexity.ai',
    defaultModel: 'sonar',
    supportsTools: false,
    supportsVision: true,
    supportsReasoning: true,
    notes: 'Perplexity Sonar (web-grounded; every reply cites sources). Bearer key; no /models endpoint, so models are seeded below. Sonar chat does NOT support tool-calling — avoid using this preset for agentic/tool workflows.',
    models: [
      { id: 'sonar', name: 'Sonar' },
      { id: 'sonar-pro', name: 'Sonar Pro' },
      { id: 'sonar-reasoning', name: 'Sonar Reasoning' },
      { id: 'sonar-reasoning-pro', name: 'Sonar Reasoning Pro' },
      { id: 'sonar-deep-research', name: 'Sonar Deep Research' }
    ]
  },
  {
    id: 'huggingface',
    name: 'Hugging Face Router',
    baseUrl: 'https://router.huggingface.co/v1',
    apiKeyUrl: 'https://huggingface.co/settings/tokens',
    docsUrl: 'https://huggingface.co/docs/inference-providers',
    defaultModel: 'openai/gpt-oss-120b',
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
    notes: 'Hugging Face Inference Providers router (aggregates Groq/Together/Cerebras/Fireworks/Novita/…). Bearer token with "Inference Providers" permission. Model ids are HF repo ids; model list fetched live.',
    models: []
  },
  {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    apiKeyUrl: 'https://build.nvidia.com/settings/api-keys',
    docsUrl: 'https://docs.api.nvidia.com/nim/reference/llm-apis',
    defaultModel: 'meta/llama-3.3-70b-instruct',
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
    notes: 'NVIDIA hosted NIM cloud (build.nvidia.com; nvapi- key). Model ids are publisher-namespaced. Model list fetched live. Self-hosted NIM containers use http://localhost:8000/v1 instead.',
    models: []
  },
  {
    id: 'zai',
    name: 'Z.AI / Zhipu GLM',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    apiKeyUrl: 'https://z.ai/manage-apikey/apikey-list',
    docsUrl: 'https://docs.z.ai/api-reference/introduction',
    defaultModel: 'glm-4.6',
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
    notes: 'Z.AI international GLM endpoint. Bearer key; no OpenAI-style /models catalog, so models are seeded below. (China platform BigModel uses https://open.bigmodel.cn/api/paas/v4.)',
    models: [
      { id: 'glm-4.7', name: 'GLM-4.7' },
      { id: 'glm-4.6', name: 'GLM-4.6' },
      { id: 'glm-4.5', name: 'GLM-4.5' },
      { id: 'glm-4.5-air', name: 'GLM-4.5 Air' },
      { id: 'glm-4.5v', name: 'GLM-4.5V (vision)' },
      { id: 'glm-4.5-flash', name: 'GLM-4.5 Flash' }
    ]
  },
  {
    id: 'qwen',
    name: 'Alibaba Qwen / DashScope',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    apiKeyUrl: 'https://modelstudio.console.alibabacloud.com/?tab=playground#/api-key',
    docsUrl: 'https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope',
    defaultModel: 'qwen-plus',
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
    notes: 'Alibaba Model Studio (Qwen) OpenAI compatible-mode, International (Singapore) endpoint. Bearer key; no /models in compatible-mode, so models are seeded below. China-mainland keys use dashscope.aliyuncs.com (not interchangeable).',
    models: [
      { id: 'qwen-max', name: 'Qwen Max' },
      { id: 'qwen-plus', name: 'Qwen Plus' },
      { id: 'qwen-turbo', name: 'Qwen Turbo' },
      { id: 'qwen-flash', name: 'Qwen Flash' },
      { id: 'qwen-vl-max', name: 'Qwen VL Max (vision)' },
      { id: 'qwq-plus', name: 'QwQ Plus (reasoning)' }
    ]
  },
  {
    id: 'novita',
    name: 'Novita AI',
    baseUrl: 'https://api.novita.ai/openai/v1',
    apiKeyUrl: 'https://novita.ai/settings/key-management',
    docsUrl: 'https://novita.ai/docs/guides/llm-api',
    defaultModel: 'deepseek/deepseek-v3-turbo',
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
    notes: 'Novita AI open-model aggregator. Bearer key; namespaced model ids; model list fetched live.',
    models: []
  },
  {
    id: 'volcengine',
    name: 'Volcengine Ark (Doubao)',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    apiKeyUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
    docsUrl: 'https://www.volcengine.com/docs/82379/1330626',
    defaultModel: 'doubao-seed-1-6-250615',
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
    notes: 'Volcengine Ark (ByteDance Doubao), China cn-beijing endpoint. Bearer key; /models needs AK/SK signing so models are seeded below. Model field may also be a self-created ep-xxxx endpoint id.',
    models: [
      { id: 'doubao-seed-1-6-250615', name: 'Doubao Seed 1.6' },
      { id: 'doubao-seed-1-6-thinking-250615', name: 'Doubao Seed 1.6 Thinking' },
      { id: 'doubao-seed-1-6-flash-250615', name: 'Doubao Seed 1.6 Flash' },
      { id: 'doubao-seed-1-6-vision-250815', name: 'Doubao Seed 1.6 Vision' },
      { id: 'doubao-seed-1-8-251228', name: 'Doubao Seed 1.8' }
    ]
  },
  {
    id: 'stepfun',
    name: 'StepFun',
    baseUrl: 'https://api.stepfun.com/v1',
    apiKeyUrl: 'https://platform.stepfun.com/interface-key',
    docsUrl: 'https://platform.stepfun.com/docs/overview/quickstart',
    defaultModel: 'step-3.5-flash',
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
    notes: 'StepFun (阶跃星辰), OpenAI-compatible. Bearer key; model list fetched live. International mirror: https://api.stepfun.ai/v1.',
    models: []
  },
  {
    id: 'venice',
    name: 'Venice AI',
    baseUrl: 'https://api.venice.ai/api/v1',
    apiKeyUrl: 'https://venice.ai/settings/api',
    docsUrl: 'https://docs.venice.ai/api-reference/api-spec',
    defaultModel: 'llama-3.3-70b',
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
    notes: 'Venice AI (privacy-focused, uncensored options). Bearer key; bare model ids; model list fetched live. Model field also accepts aliases like "default" / "most_intelligent".',
    models: []
  },
  {
    id: 'nous',
    name: 'Nous Portal',
    baseUrl: 'https://inference-api.nousresearch.com/v1',
    apiKeyUrl: 'https://portal.nousresearch.com/',
    docsUrl: 'https://portal.nousresearch.com/api-docs',
    defaultModel: 'Hermes-4-70B',
    supportsTools: true,
    supportsReasoning: true,
    notes: 'Nous Research Portal (Hermes models). Bearer key; use capitalized native ids (Hermes-4-70B / Hermes-4-405B). Model list fetched live.',
    models: []
  },
  {
    id: 'vercel',
    name: 'Vercel AI Gateway',
    baseUrl: 'https://ai-gateway.vercel.sh/v1',
    apiKeyUrl: 'https://vercel.com/dashboard/ai-gateway/api-keys',
    docsUrl: 'https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions',
    defaultModel: 'anthropic/claude-opus-4.8',
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
    notes: 'Vercel AI Gateway fronts hundreds of models behind one key. Bearer (AI Gateway key or Vercel OIDC token). Model ids are provider/model; model list fetched live.',
    models: []
  },
  {
    id: 'ollama-cloud',
    name: 'Ollama Cloud',
    baseUrl: 'https://ollama.com/v1',
    apiKeyUrl: 'https://ollama.com/settings/keys',
    docsUrl: 'https://docs.ollama.com/cloud',
    defaultModel: 'gpt-oss:120b',
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
    notes: 'Ollama Cloud hosted models. Bearer key (unlike local Ollama). Cloud models may carry a -cloud tag (e.g. qwen3-coder:480b-cloud); model list fetched live from /v1/models.',
    models: []
  },
  {
    id: 'gmi',
    name: 'GMI Cloud',
    baseUrl: 'https://api.gmi-serving.com/v1',
    apiKeyUrl: 'https://console.gmicloud.ai',
    docsUrl: 'https://docs.gmicloud.ai/inference-engine/api-reference/llm-api-reference',
    defaultModel: 'deepseek-ai/DeepSeek-V4-Pro',
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
    notes: 'GMI Cloud inference. Bearer key; lab-namespaced model ids; model list fetched live.',
    models: []
  },
  {
    id: 'chutes',
    name: 'Chutes AI',
    baseUrl: 'https://llm.chutes.ai/v1',
    apiKeyUrl: 'https://chutes.ai/app/api',
    docsUrl: 'https://chutes.ai/docs',
    defaultModel: 'deepseek-ai/DeepSeek-V3-0324',
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
    notes: 'Chutes decentralized inference. Bearer key (cpk_ prefix); public /models is the source of truth for the rotating catalog.',
    models: []
  },
  {
    id: 'lmstudio',
    name: 'LM Studio (local)',
    baseUrl: 'http://localhost:1234/v1',
    docsUrl: 'https://lmstudio.ai/docs/developer/openai-compat',
    defaultModel: 'qwen2.5-7b-instruct',
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
    notes: 'Local LM Studio server (start it in the Developer tab). No API key needed. Installed models are fetched from /v1/models — the default is whatever you have loaded.',
    models: []
  },
  {
    id: 'vllm',
    name: 'vLLM (self-hosted)',
    baseUrl: 'http://localhost:8000/v1',
    docsUrl: 'https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html',
    defaultModel: 'Qwen/Qwen3-8B',
    supportsTools: true,
    notes: 'Self-hosted vLLM OpenAI-compatible server. No API key by default. Model list fetched live; default should match the model you launched vLLM with.',
    models: []
  },
  {
    id: 'sglang',
    name: 'SGLang (self-hosted)',
    baseUrl: 'http://localhost:30000/v1',
    docsUrl: 'https://docs.sglang.ai/backend/openai_api_completions.html',
    defaultModel: 'meta-llama/Llama-3.1-8B-Instruct',
    supportsTools: true,
    notes: 'Self-hosted SGLang OpenAI-compatible server. No API key by default. Model list fetched live; default should match your launched model.',
    models: []
  },
  {
    id: 'llamacpp',
    name: 'llama.cpp server',
    baseUrl: 'http://localhost:8080/v1',
    docsUrl: 'https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md',
    defaultModel: 'local-model',
    supportsTools: true,
    notes: 'Local llama.cpp llama-server (OpenAI-compatible). No API key by default. Serves whatever GGUF you loaded; model id is often "local-model".',
    models: []
  },
  {
    id: 'litellm',
    name: 'LiteLLM Proxy',
    baseUrl: 'http://localhost:4000/v1',
    docsUrl: 'https://docs.litellm.ai/docs/proxy/user_keys',
    defaultModel: 'gpt-4o',
    supportsTools: true,
    notes: 'Self-hosted LiteLLM proxy (one OpenAI-compatible gateway over many providers). Uses your proxy virtual key as the Bearer key. Models are whatever you configured in the proxy; fetched live.',
    models: []
  },
  {
    id: 'localai',
    name: 'LocalAI',
    baseUrl: 'http://localhost:8080/v1',
    docsUrl: 'https://localai.io/features/openai-functions/',
    defaultModel: 'llama-3.2-1b-instruct:q4_k_m',
    supportsTools: true,
    notes: 'Self-hosted LocalAI OpenAI-compatible server. No API key by default. Model list fetched live from /v1/models.',
    models: []
  },
  {
    id: 'jan',
    name: 'Jan (local)',
    baseUrl: 'http://localhost:1337/v1',
    docsUrl: 'https://jan.ai/docs/api-server',
    defaultModel: 'jan-v3-4b',
    supportsTools: true,
    notes: 'Local Jan server (enable the API server in Jan settings). No API key needed for local use. Model list fetched live.',
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
