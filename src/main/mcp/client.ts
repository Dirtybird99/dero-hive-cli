import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { ToolDefinition } from '@shared/types';

export interface McpServerInstance {
  id: string;
  client: Client;
  transport: Transport;
  status: 'connecting' | 'connected' | 'error' | 'disconnected';
  error?: string;
  /** Mirrors McpServerConfig.trust — tools from an untrusted server need approval. */
  trust?: boolean;
  tools: ToolDefinition[];
  resources: { name: string; uri: string; description?: string; mimeType?: string }[];
  prompts: { name: string; description?: string; arguments?: unknown[] }[];
}

export class McpConnectionError extends Error {
  constructor(message: string) { super(message); this.name = 'McpConnectionError'; }
}