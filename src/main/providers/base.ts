import type { Message, ProviderModel, ThinkingEffort, ToolDefinition, TokenUsage } from '@shared/types';

export interface ProviderStreamRequest {
  conversationId: string;
  cwd?: string;
  model: string;
  messages: Message[];
  tools?: ToolDefinition[];
  systemPrompt?: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  reasoning?: { effort?: Exclude<ThinkingEffort, 'off'> };
  planMode?: boolean;
  signal?: AbortSignal;
  requestPermission?: (request: { requestId: string; toolName: string; args: Record<string, unknown>; description?: string }) => Promise<boolean>;
  // For multi-modal: raw base64 attachments the user uploaded
  attachments?: { type: 'image' | 'audio' | 'pdf' | 'file'; filename: string; mimeType: string; data: string }[];
}

export interface ProviderStreamEvent {
  type: 'delta' | 'reasoning' | 'tool_calls' | 'tool_start' | 'tool_result' | 'usage' | 'done' | 'error';
  content?: string;
  reasoning?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  toolActivity?: {
    id: string;
    name: string;
    args: Record<string, unknown>;
    status: 'running' | 'success' | 'error';
    result?: string;
    durationMs?: number;
    meta?: Record<string, unknown>;
  };
  usage?: TokenUsage;
  error?: string;
}

export interface ProviderAdapter {
  readonly id: string;
  stream(req: ProviderStreamRequest): AsyncGenerator<ProviderStreamEvent>;
  testConnection(): Promise<{ ok: boolean; error?: string; models?: string[]; modelDetails?: Record<string, Partial<ProviderModel>>; hint?: string }>;
  closeConversation?(conversationId: string): Promise<void>;
  dispose?(): void | Promise<void>;
}
