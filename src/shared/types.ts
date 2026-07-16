// Shared types between main, preload, and renderer

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface StoredAttachment {
  id: string;
  type: 'image' | 'audio' | 'pdf' | 'file';
  filename: string;
  mimeType: string;
  size: number;
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } }
  | { type: 'input_audio'; input_audio: { data: string; format: 'wav' | 'mp3' } }
  | { type: 'file'; file: { filename: string; data: string; mimeType: string } }
  | { type: 'attachment_ref'; attachment: StoredAttachment };

export interface Message {
  id: string;
  role: Role;
  content: string | ContentPart[];
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string; // for tool messages
  reasoning?: string; // extended thinking content
  createdAt: number;
  model?: string;
  provider?: string;
  usage?: TokenUsage;
  error?: string;
  bookmarked?: boolean;
}

// A bookmarked message as listed in the sidebar
export interface BookmarkEntry {
  messageId: string;
  conversationId: string;
  conversationTitle: string;
  role: Role;
  preview: string;
  createdAt: number;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
  // Display fields filled in after execution
  result?: string;
  status?: 'pending' | 'running' | 'success' | 'error' | 'denied';
  error?: string;
  durationMs?: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  source: 'builtin' | `mcp:${string}`;
}

export interface ChatRequest {
  conversationId: string;
  providerId: string;
  model: string;
  messages: Message[];
  tools?: ToolDefinition[];
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  systemPrompt?: string;
  /** Persona prompt from the composer's agent picker — layered on top of the base system prompt in main. */
  agentPrompt?: string;
  stream?: boolean;
  reasoning?: { effort?: Exclude<ThinkingEffort, 'off'> };
  /** Optional per-request cap used by orchestrators such as Swarm. */
  maxAgenticRounds?: number;
  planMode?: boolean;
  toolApprovalModeOverride?: ToolApprovalMode;
  attachments?: { type: 'image' | 'audio' | 'pdf' | 'file'; filename: string; mimeType: string; data: string }[];
  /** When regenerating from an edited message, skip persisting the last user message again. */
  skipUserPersist?: boolean;
}

export type StreamEvent =
  | { type: 'start'; conversationId: string; messageId: string }
  | { type: 'delta'; conversationId: string; messageId: string; content?: string; reasoning?: string }
  | { type: 'tool_calls'; conversationId: string; messageId: string; toolCalls: ToolCall[] }
  | { type: 'usage'; conversationId: string; messageId: string; usage: TokenUsage }
  | { type: 'done'; conversationId: string; messageId: string }
  | { type: 'error'; conversationId: string; messageId: string; error: string };

// Provider preset definition (built-in)
export interface ProviderPreset {
  id: string;
  name: string;
  baseUrl: string;
  apiKeyUrl?: string;
  docsUrl?: string;
  defaultModel: string;
  models: ProviderModel[];
  headers?: Record<string, string>;
  supportsTools?: boolean;
  supportsVision?: boolean;
  supportsAudio?: boolean;
  supportsReasoning?: boolean;
  notes?: string;
}

export interface ProviderModel {
  id: string;
  name: string;
  contextWindow?: number;
  maxOutput?: number;
  supportsTools?: boolean;
  supportsVision?: boolean;
  supportsAudio?: boolean;
  supportsReasoning?: boolean;
  /** Media this model can *generate*, auto-detected from its id when the models
   *  list is pulled. Empty/undefined means a text (chat) model. A model tagged
   *  here appears as an option in Vision → Media for that kind. */
  mediaKinds?: MediaKind[];
  /** Exact effort values reported by providers that support live discovery (for example Codex ACP). */
  thinkingOptions?: ThinkingOption[];
  inputPrice?: number; // $/1M tokens
  outputPrice?: number;
}

// Not every provider accepts the same effort values. The capability registry
// limits the composer to the values that are valid for the selected model.
export type ThinkingEffort = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ThinkingOption {
  id: Exclude<ThinkingEffort, 'off'>;
  label: string;
  description: string;
}

export interface ProviderConfig {
  id: string;
  presetId?: string;
  name: string;
  baseUrl: string;
  apiKey?: string; // never sent to renderer; presence implied by hasApiKey
  hasApiKey?: boolean; // renderer-safe indicator
  models: ProviderModel[];
  enabled: boolean;
  customHeaders?: Record<string, string>;
  modelsFetchedAt?: number;
}

export interface ProviderFallback {
  providerId: string;
  model: string;
}

// MCP server config (matches Claude Desktop format)
export interface McpServerConfig {
  id: string;
  name: string;
  enabled: boolean;
  transport?: 'stdio' | 'http'; // defaults to 'stdio' when absent
  command?: string; // required for stdio transport
  url?: string; // required for http transport
  args?: string[];
  env?: Record<string, string>; // write-only; values are never returned to the renderer
  envKeys?: string[]; // read-only; names of env vars currently stored
  cwd?: string;
  timeoutMs?: number;
  trust?: boolean; // skip tool confirmations
  bearerToken?: string; // write-only, http transport only
  clearBearerToken?: boolean;
  hasBearerToken?: boolean; // read-only
}

export interface McpServerStatus {
  id: string;
  name: string;
  connected: boolean;
  error?: string;
  tools: ToolDefinition[];
  resources: { name: string; uri: string; description?: string; mimeType?: string }[];
  prompts: { name: string; description?: string; arguments?: unknown[] }[];
}

// Composer agent — a named persona (system prompt preset) selectable in the
// composer toolbar. Built-ins live in shared/agents.ts; custom ones persist in
// AppSettings.customAgents.
export interface AgentDefinition {
  id: string;
  name: string;
  prompt: string;
  description?: string;
  builtin?: boolean;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  slashCommand: string; // e.g. "/commit"
  prompt: string;
  enabled: boolean;
  builtin?: boolean;
  category?: string;
  /** Present for skills synced from a bundled or drop-in SKILL.md folder. */
  sourceDir?: string;
}

export interface SkillImportPreview {
  sourceDir: string;
  name: string;
  description: string;
  slashCommand: string;
  prompt: string;
  warnings: string[];
}

export type SkillImportPickResult =
  | { ok: true; preview: SkillImportPreview }
  | { ok: false; cancelled?: boolean; error?: string };

export type SkillImportResult =
  | { ok: true; skill: Skill }
  | { ok: false; error: string };

// Reusable prompt template (Prompt Library). Inserted via the "#" composer
// trigger; {{clipboard}} and {{date}} interpolate at insert time.
export interface PromptTemplate {
  id: string;
  title: string;
  content: string;
  category?: string;
  createdAt: number;
  updatedAt: number;
}

export interface Project {
  id: string;
  name: string;
  icon: string;
  color?: string;
  path: string;
  config?: ProjectConfig;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectConfig {
  kind?: 'general' | 'dero';
  knowledge?: {
    provider: 'obsidian';
    serverId: string;
    folder: string;
    allowAutomationWrites?: boolean;
  };
  mcpServerIds?: string[];
}

export type KnowledgeCapability = 'list' | 'read' | 'search' | 'write' | 'append' | 'patch' | 'open';

export interface KnowledgeStatus {
  projectId: string;
  configured: boolean;
  connected: boolean;
  serverId?: string;
  folder?: string;
  capabilities: KnowledgeCapability[];
  missing: KnowledgeCapability[];
  error?: string;
}

export interface KnowledgeListEntry { name: string; directory: boolean }
export interface KnowledgeListResult { path: string; entries: KnowledgeListEntry[] }
export interface KnowledgeReadResult { path: string; content: string }
export interface KnowledgeSearchHit { path: string; score?: number; matches: unknown[] }
export interface KnowledgeBootstrapResult { created: string[]; existing: string[] }
export interface KnowledgeWriteResult { path: string }
export interface KnowledgeCaptureResult { path: string; queued: boolean; outboxId?: string; error?: string }
export interface KnowledgeRetryResult { retried: number; delivered: number; failed: number }

export interface KnowledgeCaptureRequest { projectId: string; content: string; source?: string; title?: string }
export interface KnowledgeAppendRequest { projectId: string; path: string; content: string }
export interface KnowledgePatchRequest {
  projectId: string;
  path: string;
  targetType: 'heading' | 'block' | 'frontmatter';
  target: string;
  operation: 'replace' | 'prepend' | 'append';
  content: string;
  contentType?: 'text/markdown' | 'application/json';
  createTargetIfMissing?: boolean;
  rejectIfContentPreexists?: boolean;
}
export interface KnowledgeOpenRequest { projectId: string; path: string; newLeaf?: boolean }

export type KnowledgeAutomationKind = 'morning-digest' | 'weekly-synthesis';
export interface KnowledgeAutomation {
  projectId: string;
  kind: KnowledgeAutomationKind;
  enabled: boolean;
  localHour: number;
  localMinute: number;
  weeklyWeekday?: number; // 0=Sunday ... 6=Saturday
  providerId: string;
  model: string;
  lastRunKey?: string;
  lastRunAt?: number;
  error?: string;
}
export type KnowledgeAutomationSaveRequest = Omit<KnowledgeAutomation, 'lastRunKey' | 'lastRunAt' | 'error'>;
export interface KnowledgeAutomationStatus extends KnowledgeAutomation {
  running: boolean;
  due: boolean;
  currentRunKey: string;
}
export interface KnowledgeAutomationRunResult {
  projectId: string;
  kind: KnowledgeAutomationKind;
  runKey: string;
  status: 'completed' | 'skipped';
  path?: string;
}

export interface BrowserBridgeActiveProject {
  id: string;
  name: string;
}

export interface BrowserBridgeStatus {
  enabled: boolean;
  port: number;
  pairingCode?: string;
  paired: boolean;
}

export interface McpRegistryEntry {
  id: string;
  name: string;
  description: string;
  repo: string;
  license: string;
  runtime: 'node' | 'python' | 'http';
  install:
    | { transport?: 'stdio'; command: string; args: string[] }
    | { transport: 'http'; url: string };
  requiresConfig?: string;
  category: string;
  local: boolean;
  windows: boolean;
  stars?: number;
  verified?: string;
  tags?: string[];
}

export interface McpRegistry {
  version: number;
  updatedAt: string;
  description?: string;
  notes?: string[];
  servers: McpRegistryEntry[];
}

export function normalizeKnowledgePath(value: unknown, allowEmpty = false): string {
  if (typeof value !== 'string' || value.includes('\0')) throw new Error('Knowledge path must be a string');
  const raw = value.trim().replace(/\\/g, '/');
  if (!raw) {
    if (allowEmpty) return '';
    throw new Error('Knowledge path is required');
  }
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) throw new Error('Knowledge path must be vault-relative');
  const parts = raw.split('/').filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..')) throw new Error('Knowledge path cannot traverse outside the project folder');
  return parts.join('/');
}

export function normalizeProjectConfig(value: unknown): ProjectConfig {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Project config must be an object');
  const input = value as Record<string, unknown>;
  const config: ProjectConfig = {};
  if (input.kind !== undefined) {
    if (input.kind !== 'general' && input.kind !== 'dero') throw new Error('Invalid project kind');
    config.kind = input.kind;
  }
  if (input.mcpServerIds !== undefined) {
    if (!Array.isArray(input.mcpServerIds) || input.mcpServerIds.some((id) => typeof id !== 'string' || !id.trim())) {
      throw new Error('Project MCP server ids must be non-empty strings');
    }
    config.mcpServerIds = [...new Set(input.mcpServerIds.map((id) => (id as string).trim()))];
  }
  if (input.knowledge !== undefined) {
    if (typeof input.knowledge !== 'object' || input.knowledge === null || Array.isArray(input.knowledge)) {
      throw new Error('Project knowledge config must be an object');
    }
    const knowledge = input.knowledge as Record<string, unknown>;
    if (knowledge.provider !== 'obsidian') throw new Error('Only Obsidian project knowledge is supported');
    if (typeof knowledge.serverId !== 'string' || !knowledge.serverId.trim()) throw new Error('Knowledge MCP server id is required');
    if (knowledge.allowAutomationWrites !== undefined && typeof knowledge.allowAutomationWrites !== 'boolean') {
      throw new Error('allowAutomationWrites must be a boolean');
    }
    config.knowledge = {
      provider: 'obsidian',
      serverId: knowledge.serverId.trim(),
      folder: normalizeKnowledgePath(knowledge.folder),
      ...(knowledge.allowAutomationWrites === undefined ? {} : { allowAutomationWrites: knowledge.allowAutomationWrites })
    };
  }
  return config;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  providerId: string;
  model: string;
  systemPrompt?: string;
  pinned?: boolean;
  archived?: boolean;
  projectId?: string;
  parentId?: string;
  totalTokens?: number;
  messageCount: number;
  preview?: string;
  compactionCount?: number;
  lastCompactionAt?: number;
  tokensSavedByCompaction?: number;
}

export interface PermissionRule {
  id: string;
  toolName: string; // 'bash' | 'write_file' | 'mcp:server.tool' | '*'
  pattern?: string; // glob or regex
  action: 'allow' | 'deny' | 'ask';
  scope?: 'project' | 'global';
  projectPath?: string;
}

export type ToolApprovalMode = 'always' | 'session' | 'project' | 'never';

export function normalizeToolApprovalMode(value: unknown): ToolApprovalMode {
  return value === 'session' || value === 'project' || value === 'never' ? value : 'always';
}

export interface AppSettings {
  theme: 'dark' | 'light' | 'system';
  fontSize: 'small' | 'medium' | 'large';
  interfaceFont?: 'inter' | 'system' | 'serif' | 'mono';
  codeFont?: 'jetbrains-mono' | 'fira-code' | 'consolas' | 'mono';
  interfaceFontSize?: number;
  terminalFontSize?: number;
  spacingDensity?: number;
  inputBarOffset?: number;
  sendOnEnter: boolean;
  showTokenUsage: boolean;
  showReasoning: boolean;
  autoTitle: boolean;
  defaultProviderId?: string;
  defaultModelId?: string;
  /** Fallback providers/models tried in order if the primary selection errors before producing any output. */
  providerFallbackChain?: ProviderFallback[];
  favouriteModels?: string[]; // entries are "providerId:modelId"
  maxConcurrentToolCalls: number;
  /** Maximum model → tools → model cycles for one submitted task (1–50). */
  maxAgenticRounds: number;
  toolApprovalMode: ToolApprovalMode;
  workingDirectory?: string;
  codeFolder?: string; // last folder opened in the Code tab explorer (persists across sessions)
  codeTheme?: 'vscode' | 'onedark' | 'dracula' | 'monokai'; // editor syntax theme
  accentColor?: string; // hex override for the accent colour (empty = theme default)
  customCss?: string; // user CSS injected after app styles
  themePreset?: string; // preset theme name (e.g., 'solarized', 'nord', 'catppuccin', 'gruvbox')
  telemetry: boolean;
  experimentalFeatures: boolean;
  // Composer (per-session, but persists in settings)
  composerFocusMode?: boolean;
  composerPlanMode?: boolean;
  composerAgent?: string; // agent id: "default", "explore", "review", or a custom agent's id
  customAgents?: AgentDefinition[]; // user-defined composer agents (personas)
  composerReasoning?: ThinkingEffort;
  microphoneDeviceId?: string;
  voiceNotificationSounds?: boolean;
  voiceNotificationVolume?: number;
  desktopNotifications?: boolean; // native OS notification when a response finishes in the background (default true)
  voiceSttEndpoint?: string;
  // Composer spellcheck
  spellcheckEnabled?: boolean; // default true
  spellcheckLanguage?: string; // default 'en'
  // Focus mode extras
  focusModeTimerMinutes?: number; // default 25 (0 = off)
  focusModeWordGoal?: number; // default 0 (off)
  // Text-to-speech
  ttsEnabled?: boolean; // default false
  ttsVoiceUri?: string; // preferred voice URI
  // Local Whisper.cpp speech-to-text
  whisperEnabled?: boolean; // auto-start local server with the app (default true)
  whisperModel?: string; // model filename, e.g. "ggml-base.en.bin"
  // Usage budget alerts
  dailyTokenBudget?: number; // 0 = off
  monthlyTokenBudget?: number; // 0 = off
}

export type Attachment = StoredAttachment;

export interface Artifact {
  id: string;
  conversationId: string;
  messageId: string;
  type: 'code' | 'html' | 'svg' | 'react' | 'mermaid' | 'markdown';
  language?: string;
  title?: string;
  content: string;
  createdAt: number;
}

// Aggregated token usage for the dashboard (per model, per period)
export interface UsageModelRow {
  model: string;
  provider: string;
  messages: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface UsageStats {
  today: UsageModelRow[];
  week: UsageModelRow[];
  month: UsageModelRow[];
}

export interface SearchResult {
  conversationId: string;
  messageId: string;
  role: Role;
  snippet: string;
  score: number;
}

// IPC channel constants
export const IPC = {
  // Chat
  CHAT_SEND: 'chat:send',
  CHAT_ABORT: 'chat:abort',
  CHAT_QUEUE_MESSAGE: 'chat:queue-message',
  CHAT_STREAM: 'chat:stream', // event from main -> renderer

  // Conversations
  CONV_LIST: 'conv:list',
  CONV_GET: 'conv:get',
  CONV_CREATE: 'conv:create',
  CONV_UPDATE: 'conv:update',
  CONV_DELETE: 'conv:delete',
  CONV_SEARCH: 'conv:search',
  CONV_FORK: 'conv:fork',
  CONV_REVERT: 'conv:revert',
  CONV_COMPACT: 'conv:compact',
  CONV_COMPACTED: 'conv:compacted',
  CONV_TITLE_GENERATED: 'conv:title-generated',

  // Usage / cost dashboard
  USAGE_STATS: 'usage:stats',

  // Message bookmarks
  MSG_BOOKMARK: 'msg:bookmark',
  MSG_UPDATE: 'msg:update',
  MSG_DELETE: 'msg:delete',
  BOOKMARK_LIST: 'bookmark:list',

  // Providers
  PROVIDER_LIST: 'provider:list',
  PROVIDER_SAVE: 'provider:save',
  PROVIDER_DELETE: 'provider:delete',
  PROVIDER_TEST: 'provider:test',
  PROVIDER_MODELS: 'provider:models',
  PROVIDER_REFRESH_MODELS: 'provider:refreshModels',
  PROVIDER_PROBE_MODELS: 'provider:probeModels',
  PROVIDER_MODELS_UPDATED: 'provider:models-updated', // event

  // MCP
  MCP_LIST: 'mcp:list',
  MCP_SAVE: 'mcp:save',
  MCP_DELETE: 'mcp:delete',
  MCP_CONNECT: 'mcp:connect',
  MCP_DISCONNECT: 'mcp:disconnect',
  MCP_STATUS: 'mcp:status',
  MCP_CHANGED: 'mcp:changed', // event
  MCP_REGISTRY: 'mcp:registry',

  // Skills
  SKILL_LIST: 'skill:list',
  SKILL_SAVE: 'skill:save',
  SKILL_DELETE: 'skill:delete',
  SKILL_RESCAN: 'skill:rescan',
  SKILL_OPEN_DIR: 'skill:openDir',
  SKILL_IMPORT_PICK: 'skill:importPick',
  SKILL_IMPORT: 'skill:import',

  // Prompt library
  PROMPT_LIST: 'prompt:list',
  PROMPT_SAVE: 'prompt:save',
  PROMPT_DELETE: 'prompt:delete',

  // Projects
  PROJECT_LIST: 'project:list',
  PROJECT_SAVE: 'project:save',
  PROJECT_DELETE: 'project:delete',

  // Project knowledge (Obsidian is canonical)
  KNOWLEDGE_STATUS: 'knowledge:status',
  KNOWLEDGE_LIST: 'knowledge:list',
  KNOWLEDGE_READ: 'knowledge:read',
  KNOWLEDGE_SEARCH: 'knowledge:search',
  KNOWLEDGE_BOOTSTRAP: 'knowledge:bootstrap',
  KNOWLEDGE_CAPTURE: 'knowledge:capture',
  KNOWLEDGE_APPEND: 'knowledge:append',
  KNOWLEDGE_PATCH: 'knowledge:patch',
  KNOWLEDGE_OPEN: 'knowledge:open',
  KNOWLEDGE_RETRY_OUTBOX: 'knowledge:retry-outbox',

  // Fixed vault automations
  KNOWLEDGE_AUTOMATION_LIST: 'knowledge-automation:list',
  KNOWLEDGE_AUTOMATION_SAVE: 'knowledge-automation:save',
  KNOWLEDGE_AUTOMATION_DELETE: 'knowledge-automation:delete',
  KNOWLEDGE_AUTOMATION_RUN_NOW: 'knowledge-automation:run-now',
  KNOWLEDGE_AUTOMATION_STATUS: 'knowledge-automation:status',

  // Tools
  TOOL_LIST: 'tool:list',
  TOOL_PERMISSION_DECIDE: 'tool:permission:decide',
  TOOL_PERMISSION_REQUEST: 'tool:permission:request', // event

  // FS / Shell
  FS_READ: 'fs:read',
  FS_WRITE: 'fs:write',
  FS_LIST: 'fs:list',
  FS_EXISTS: 'fs:exists',
  FS_MKDIR: 'fs:mkdir',
  FS_PICK_DIRECTORY: 'fs:pickDirectory',
  FS_PICK_FILE: 'fs:pickFile',
  FS_GLOB: 'fs:glob',
  SHELL_RUN: 'shell:run',
  TERMINAL_EXEC: 'terminal:exec',
  TERMINAL_DISPOSE: 'terminal:dispose',
  GH_FETCH_URL: 'gh:fetchUrl',

  // Settings
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',

  // Attachments
  ATTACH_FROM_FILE: 'attach:fromFile',
  ATTACH_FROM_BYTES: 'attach:fromBytes',

  // Artifacts (Vision workspace)
  ARTIFACT_SAVE: 'artifact:save',
  ARTIFACT_LIST: 'artifact:list',
  ARTIFACT_DELETE: 'artifact:delete',
  ARTIFACT_UPDATE: 'artifact:update',
  VISION_EXPORT: 'vision:export',
  VISION_OPEN_EXTERNAL: 'vision:openExternal',

  // App
  APP_OPEN_EXTERNAL: 'app:openExternal',
  APP_PLATFORM: 'app:platform',
  APP_VERSION: 'app:version',
  BROWSER_BRIDGE_SET_ENABLED: 'browserBridge:setEnabled',
  BROWSER_BRIDGE_STATUS: 'browserBridge:status',
  BROWSER_BRIDGE_BIND: 'browserBridge:bind',
  BROWSER_BRIDGE_SELECTION: 'browserBridge:selection',
  BROWSER_BRIDGE_REVOKE_PAIRING: 'browserBridge:revokePairing',
  UPDATE_CHECK: 'update:check',
  UPDATE_INSTALL: 'update:install',

  // Whisper (local speech-to-text)
  WHISPER_STATUS: 'whisper:status',
  WHISPER_TRANSCRIBE: 'whisper:transcribe',
  WHISPER_START: 'whisper:start',
  WHISPER_STOP: 'whisper:stop',
  WHISPER_STATUS_CHANGED: 'whisper:status-changed', // event

  // Simulator (DERO blockchain simulator)
  SIMULATOR_STATUS: 'simulator:status',
  SIMULATOR_START: 'simulator:start',
  SIMULATOR_STOP: 'simulator:stop',
  SIMULATOR_RESTART: 'simulator:restart',
  SIMULATOR_HEALTH: 'simulator:health',
  SIMULATOR_INFO: 'simulator:info',
  DERO_LINT: 'dero:lint',
  SIMULATOR_OUTPUT: 'simulator:output',          // event: { stream, data }
  SIMULATOR_STATUS_CHANGED: 'simulator:status-changed', // event
  SIMULATOR_CREATE_FIXTURE_WALLET: 'simulator:create-fixture-wallet',
  SIMULATOR_GET_BALANCE: 'simulator:get-balance',
  SIMULATOR_GET_CONTRACT_STATE: 'simulator:get-contract-state',
  SIMULATOR_GET_HEIGHT: 'simulator:get-height',

  // Media (image + video generation)
  MEDIA_LIST: 'media:list',
  MEDIA_SAVE_PROVIDER: 'media:save-provider',
  MEDIA_DELETE_PROVIDER: 'media:delete-provider',
  MEDIA_TEST_PROVIDER: 'media:test-provider',
  MEDIA_GENERATE: 'media:generate',
  MEDIA_CANCEL: 'media:cancel',
  MEDIA_DELETE_ARTIFACT: 'media:delete-artifact',
  MEDIA_OPEN_ARTIFACT: 'media:open-artifact',
  MEDIA_REVEAL_ARTIFACT: 'media:reveal-artifact',
  MEDIA_STATUS_CHANGED: 'media:status-changed' // event: MediaJobStatusEvent
} as const;

export interface WhisperStatus {
  installed: boolean; // binary + model present on disk
  running: boolean;
  loading: boolean;
  port: number | null;
  model: string | null;
  models: string[];
  error: string | null;
}

export interface SimulatorStatus {
  installed: boolean; // simulator binary found on disk
  running: boolean;
  starting: boolean;
  pid: number | null;
  binaryPath: string | null;
  args: string[];
  cwd: string | null;
  startedAt: number | null;
  exitCode: number | null;
  error: string | null;
}

export interface SimulatorStartOptions {
  binaryPath?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  detached?: boolean;
}

export interface SimulatorHealth {
  reachable: boolean;
  endpoint: string;
  latencyMs?: number;
  error?: string;
}

export interface SimulatorChainInfo {
  height: number;
  topoHeight: number;
  network: string;
  version: string;
  txPoolSize: number;
  status: string;
}

export type IpcChannel = typeof IPC[keyof typeof IPC];

// ───────────────────────────────────────────────────────────────────────────
// Media generation (image + video)
// ───────────────────────────────────────────────────────────────────────────

export type MediaKind = 'image' | 'video' | 'audio';
export type MediaJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface MediaModelOption {
  id: string;
  label: string;
  kind: MediaKind;
  /** Free-form hints surfaced in the UI ("1024x1024", "5s clip"). */
  hint?: string;
}

export interface MediaProviderPreset {
  id: string;
  name: string;
  kind: 'image' | 'video' | 'audio' | 'both';
  /** Whether the provider requires an API key. */
  requiresApiKey: boolean;
  /** Base URL; "" for cloud presets that hard-code their endpoint. */
  baseUrl?: string;
  /** Where the renderer should direct the user to obtain a key. */
  apiKeyUrl?: string;
  notes: string;
  defaultModel: string;
  models: MediaModelOption[];
}

export interface MediaProviderConfig {
  id: string;
  presetId: string;
  name: string;
  /** May be empty for cloud providers that hard-code their endpoint. */
  baseUrl: string;
  hasApiKey: boolean;
  enabled: boolean;
  defaultImageModel?: string;
  defaultVideoModel?: string;
  defaultAudioModel?: string;
  customHeaders?: Record<string, string>;
  /** Optional model overrides; falls back to preset defaults. */
  imageModels?: MediaModelOption[];
  videoModels?: MediaModelOption[];
  audioModels?: MediaModelOption[];
  /** Free-form kwargs applied to every request (e.g. seed, negative_prompt). */
  defaultOptions?: Record<string, string>;
  updatedAt: number;
}

export interface MediaGenerationRequest {
  prompt: string;
  negativePrompt?: string;
  model?: string;
  /** Explicit media kind. When omitted the manager infers it from the
   *  provider preset and request fields (e.g. durationSeconds ⇒ video). */
  kind?: MediaKind;
  width?: number;
  height?: number;
  steps?: number;
  cfgScale?: number;
  seed?: number;
  durationSeconds?: number;
  fps?: number;
  /** Text-to-speech voice id (audio kind). */
  voice?: string;
  /** Preferred output container/format hint (e.g. "mp3", "wav"). */
  format?: string;
  /** Reference image(s) for image-to-image / video-from-image flows. */
  referenceImageIds?: string[];
  /** Target dedicated media provider. Falls back to the first enabled provider. */
  providerId?: string;
  /** Target model (chat) provider — generation runs through its base URL + key
   *  using the OpenAI-compatible image / speech endpoints. Takes precedence
   *  over providerId when set. */
  modelProviderId?: string;
  /** Arbitrary provider-specific extras (merged over defaultOptions). */
  options?: Record<string, string>;
  /** Project scope — generated files are placed under the project folder
   *  when set, otherwise under the global artifacts directory. */
  projectId?: string;
}

export interface MediaArtifactRecord {
  id: string;
  conversationId?: string;
  messageId?: string;
  projectId?: string;
  kind: MediaKind;
  providerId: string;
  model: string;
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  seed?: number;
  /** Relative path inside the project / artifacts directory. */
  relativePath: string;
  mimeType: string;
  bytes: number;
  status: MediaJobStatus;
  error?: string;
  options?: Record<string, string>;
  createdAt: number;
}

export interface MediaJobRecord extends MediaArtifactRecord {
  startedAt?: number;
  finishedAt?: number;
}

export interface MediaJobStatusEvent {
  job: MediaJobRecord;
}

export interface MediaListResponse {
  artifacts: MediaArtifactRecord[];
  providers: MediaProviderConfig[];
  presets: MediaProviderPreset[];
}

// XSWD wallet bridge (DERO wallets expose an XSWD WebSocket server; Hive is the client)
export type XswdConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'awaiting-approval'
  | 'connected'
  | 'error';

export interface XswdStatus {
  state: XswdConnectionState;
  url: string;
  appName: string;
  connectedAt: number | null;
  error: string | null;
}
