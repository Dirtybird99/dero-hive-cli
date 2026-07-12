import { getSetting, setSetting } from '../../../src/main/db/client.js';
import type { ThinkingEffort, TokenUsage } from '../../../src/shared/types.js';

export interface CliState {
  currentConversationId?: string;
  currentProjectId?: string;
  currentProviderId?: string;
  currentModelId?: string;
  systemPrompt?: string;
  goal?: string;
  goalPaused?: boolean;
  memory?: string[];
  memoryEnabled?: boolean;
  lastPlan?: string;
  plans?: Record<string, string>;
  focusMode?: boolean;
  compactMode?: boolean;
  minimalMode?: boolean;
  multilineMode?: boolean;
  vimMode?: boolean;
  showTimestamps?: boolean;
  theme?: string;
  addedDirs?: string[];
  currentProjectPath?: string;
  planMode?: boolean;
  reasoning?: ThinkingEffort;
  agentId?: string;
  showReasoning?: boolean;
  showToolDetails?: boolean;
  focusStartedAt?: number;
  focusMinutes?: number;
}

// In-memory session state (not persisted)
export interface SessionState {
  cumulativeUsage: TokenUsage;
  planMode: boolean;
  focusMode: boolean;
  addedDirs: string[];
}

export function createSessionState(): SessionState {
  return {
    cumulativeUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    planMode: false,
    focusMode: false,
    addedDirs: []
  };
}

export function loadState(): CliState {
  return getSetting('cliState') || {};
}

export function saveState(state: CliState): void {
  setSetting('cliState', state);
}

export function getDefaultProvider(): { providerId?: string; modelId?: string } {
  const appSettings = getSetting('appSettings') as Record<string, unknown> | undefined;
  return {
    providerId: appSettings?.defaultProviderId as string | undefined,
    modelId: appSettings?.defaultModelId as string | undefined
  };
}

export function setDefaultProvider(providerId: string, modelId: string): void {
  const appSettings = (getSetting('appSettings') as Record<string, unknown> | undefined) || {};
  appSettings.defaultProviderId = providerId;
  appSettings.defaultModelId = modelId;
  setSetting('appSettings', appSettings);
}

export function getSettingDirect<T>(key: string, fallback?: T): T | undefined {
  const row = getSetting(key) as T | undefined;
  return row !== undefined ? row : fallback;
}

export function setSettingDirect(key: string, value: unknown): void {
  setSetting(key, value);
}
