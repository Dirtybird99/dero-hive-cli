import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import type { Message, ProviderConfig, ProviderFallback, ProviderModel, ChatRequest, StreamEvent } from '../../../src/shared/types.js';
import { TERMINAL_SYSTEM_PROMPT } from '../utils/systemPrompt.js';
import { getDb, getSetting } from '../../../src/main/db/client.js';
import { getAdapter, listProviders } from '../../../src/main/providers/registry.js';
import type { ProviderStreamEvent } from '../../../src/main/providers/base.js';
import { ToolRegistry } from '../../../src/main/tools/registry.js';
import { getDefaultWorkspace } from '../../../src/main/utils/paths.js';
import { truncateMessagesForContext } from '../../../src/main/utils/tokenBudget.js';
import { hydrateAttachmentRefs, validateAttachmentRefs } from '../../../src/main/utils/attachments.js';
import { logger } from '../../../src/main/utils/logger.js';
import * as conversationService from './conversation.js';

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_ATTACHMENTS_TOTAL_BYTES = 25 * 1024 * 1024;
const PLAN_SAFE_TOOL_NAMES = new Set([
  'read_file',
  'list_directory',
  'glob_files',
  'grep_files',
  'lint_dvm_basic',
  'get_simulator_chain_info'
]);

export interface ChatServiceOptions {
  onEvent: (event: StreamEvent) => void;
  tools: ToolRegistry;
  /** Session-scoped workspace. In the TUI this is the VS Code launch folder. */
  cwd?: string;
  onToolStart?: (info: {
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
  }) => void;
  onToolResult?: (info: {
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
    result: { content: string; isError?: boolean; meta?: Record<string, unknown> };
    durationMs: number;
  }) => void;
  onCompaction?: (info: conversationService.CompactResult) => void;
  signal?: AbortSignal;
}

export interface ResolvedTarget extends ProviderFallback {
  modelDef: ProviderModel;
  adapter: NonNullable<ReturnType<typeof getAdapter>>;
}

export interface ProviderChainResolution {
  targets: Array<ProviderFallback & { modelDef: ProviderModel }>;
  unavailable: string[];
}

export function resolveProviderChain(
  primary: ProviderFallback,
  fallbackValue: unknown,
  providers: readonly ProviderConfig[]
): ProviderChainResolution {
  const refs: ProviderFallback[] = [primary];
  if (Array.isArray(fallbackValue)) {
    for (const value of fallbackValue) {
      if (!value || typeof value !== 'object') continue;
      const providerId = (value as { providerId?: unknown }).providerId;
      const model = (value as { model?: unknown }).model;
      if (typeof providerId === 'string' && typeof model === 'string') refs.push({ providerId, model });
    }
  }

  const available = new Map(providers.filter((p) => p.enabled).map((p) => [p.id, p]));
  const seen = new Set<string>();
  const targets: ProviderChainResolution['targets'] = [];
  const unavailable: string[] = [];
  for (const ref of refs) {
    const providerId = ref.providerId.trim();
    const model = ref.model.trim();
    const key = `${providerId}\0${model}`;
    if (!providerId || !model || seen.has(key)) continue;
    seen.add(key);
    const provider = available.get(providerId);
    if (!provider) {
      unavailable.push(`Provider "${providerId}" is not configured or enabled.`);
      continue;
    }
    const modelDef = provider.models.find((item) => item.id === model);
    if (!modelDef) {
      unavailable.push(`Model "${model}" is not configured for provider "${provider.name}".`);
      continue;
    }
    targets.push({ providerId, model, modelDef });
  }
  return { targets, unavailable };
}

function commitsProviderOutput(event: ProviderStreamEvent): boolean {
  return (
    (event.type === 'delta' && Boolean(event.content)) ||
    (event.type === 'reasoning' && Boolean(event.reasoning)) ||
    (event.type === 'tool_calls' && Boolean(event.toolCalls?.length)) ||
    event.type === 'tool_start' ||
    event.type === 'tool_result' ||
    event.type === 'usage'
  );
}

async function* streamWithRetry<T>(
  makeStream: () => AsyncIterable<T>,
  signal: AbortSignal,
  retryAllowed: () => boolean = () => true,
  maxRetries = 2
): AsyncGenerator<T> {
  let attempt = 0;
  while (true) {
    if (signal.aborted) return;
    let produced = false;
    try {
      for await (const evt of makeStream()) {
        produced = true;
        yield evt;
      }
      return;
    } catch (err) {
      if (signal.aborted) throw err;
      if (produced || !retryAllowed() || attempt >= maxRetries) throw err;
      attempt++;
      await new Promise((r) => setTimeout(r, 800 * attempt));
    }
  }
}

async function* streamWithFallback<T extends ProviderFallback>(
  targets: readonly T[],
  makeStream: (target: T) => AsyncIterable<ProviderStreamEvent>,
  signal: AbortSignal,
  fallbackAllowed: () => boolean = () => true,
  retryAllowed: () => boolean = () => true
): AsyncGenerator<{ target: T; event: ProviderStreamEvent }> {
  const failures: string[] = [];
  for (let index = 0; index < targets.length; index++) {
    const target = targets[index];
    let committed = false;
    try {
      for await (const event of streamWithRetry(() => makeStream(target), signal, retryAllowed)) {
        if (commitsProviderOutput(event)) committed = true;
        if (event.type === 'error') throw new Error(event.error || 'Provider stream failed');
        yield { target, event };
      }
      return;
    } catch (error) {
      if (signal.aborted) throw error;
      failures.push(`${target.providerId}/${target.model}: ${error instanceof Error ? error.message : String(error)}`);
      const hasNext = index + 1 < targets.length;
      if (committed || !fallbackAllowed() || !hasNext) {
        if (!committed && fallbackAllowed() && failures.length > 1) {
          throw new Error(`Provider fallback chain exhausted: ${failures.join(' | ')}`, { cause: error });
        }
        throw error;
      }
    }
  }
}

function buildProjectSnapshot(cwd: string): string {
  const parts: string[] = [];
  parts.push(`Project directory: ${cwd}`);

  if (existsSync(`${cwd}/.git`)) {
    try {
      const status = execSync('git status --short', { cwd, encoding: 'utf-8', timeout: 3000 });
      if (status.trim()) {
        parts.push('Git status (changed files):\n' + status.trim().split('\n').slice(0, 30).join('\n'));
      } else {
        parts.push('Git status: clean');
      }
    } catch {
      parts.push('Git status: unavailable');
    }
  }

  try {
    const entries = readdirSync(cwd, { withFileTypes: true });
    const tree: string[] = [];
    for (const e of entries.slice(0, 40)) {
      const prefix = e.isDirectory() ? '📁' : '📄';
      tree.push(`${prefix} ${e.name}`);
    }
    if (tree.length) parts.push('File structure:\n' + tree.join('\n'));
  } catch {
    /* ignore */
  }

  const instructionFiles = ['AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md'];
  let instructionBytes = 0;
  for (const relativePath of instructionFiles) {
    const file = `${cwd}/${relativePath}`;
    try {
      if (!existsSync(file) || !statSync(file).isFile()) continue;
      const remaining = 32_000 - instructionBytes;
      if (remaining <= 0) break;
      const content = readFileSync(file, 'utf8').slice(0, remaining);
      instructionBytes += content.length;
      parts.push(`Project instructions (${relativePath}):\n${content}`);
    } catch {
      /* ignore unreadable project guidance */
    }
  }

  return parts.join('\n\n');
}

export async function runChat(
  req: ChatRequest,
  options: ChatServiceOptions
): Promise<{ messageId: string }> {
  const { onEvent, tools } = options;
  const messageId = randomUUID();
  const userMsg = req.messages[req.messages.length - 1];

  const appSettings = getSetting<Partial<Record<string, unknown>>>('appSettings');
  const resolution = resolveProviderChain(
    { providerId: req.providerId, model: req.model },
    appSettings?.providerFallbackChain,
    listProviders()
  );
  const providerTargets = resolution.targets.flatMap((target) => {
    const adapter = getAdapter(target.providerId);
    if (adapter) return [{ ...target, adapter }];
    resolution.unavailable.push(`Provider "${target.providerId}" could not be loaded.`);
    return [];
  });

  if (resolution.unavailable.length) logger.warn('chat', resolution.unavailable.join(' '));
  if (providerTargets.length === 0) {
    const error = resolution.unavailable.join(' ') || `Provider ${req.providerId} not configured`;
    onEvent({ type: 'error', conversationId: req.conversationId, messageId, error });
    onEvent({ type: 'done', conversationId: req.conversationId, messageId });
    return { messageId };
  }

  onEvent({ type: 'start', conversationId: req.conversationId, messageId });

  if (userMsg && userMsg.role === 'user') {
    try {
      await validateAttachmentRefs(userMsg.content, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_TOTAL_BYTES);
    } catch (err) {
      onEvent({
        type: 'error',
        conversationId: req.conversationId,
        messageId,
        error: err instanceof Error ? err.message : 'Invalid attachment'
      });
      onEvent({ type: 'done', conversationId: req.conversationId, messageId });
      return { messageId };
    }
    if (!req.skipUserPersist) {
      conversationService.persistMessage(req.conversationId, userMsg);
      conversationService.updateConversationPreview(req.conversationId, typeof userMsg.content === 'string' ? userMsg.content : '');
    }
  }

  const conv = getDb()
    .prepare('SELECT project_id, system_prompt FROM conversations WHERE id = ?')
    .get(req.conversationId) as { project_id?: string; system_prompt?: string } | undefined;
  let projectPath: string | undefined;
  if (conv?.project_id) {
    const proj = getDb().prepare('SELECT path FROM projects WHERE id = ?').get(conv.project_id) as { path?: string } | undefined;
    projectPath = proj?.path;
  }
  const cwd = options.cwd || projectPath || getSetting<string>('workingDirectory') || getDefaultWorkspace();
  if (projectPath) logger.info('chat', `using project cwd: ${projectPath}`);

  const requestSystemPrompt = req.systemPrompt?.trim();
  const baseSystemPrompt = requestSystemPrompt || getSetting<string>('defaultSystemPrompt', '') || TERMINAL_SYSTEM_PROMPT;
  const agentPrompt = req.agentPrompt?.trim();
  const withAgent = agentPrompt ? `${baseSystemPrompt}\n\n${agentPrompt}` : baseSystemPrompt;
  const convSystemPrompt = requestSystemPrompt ? undefined : conv?.system_prompt?.trim();
  const withConv = convSystemPrompt ? `${withAgent}\n\n${convSystemPrompt}` : withAgent;
  const systemPrompt = `${withConv}\n\nThe active terminal workspace is: ${cwd}\nTreat this directory as the working context for file operations, shell commands, and code-related tasks.\n\n${buildProjectSnapshot(cwd)}`;

  let activeTargets = providerTargets;
  const hasImage = req.messages.some((m) =>
    Array.isArray(m.content) &&
    m.content.some((p) => 'image_url' in p || (p.type === 'attachment_ref' && p.attachment.type === 'image'))
  );
  if (hasImage) {
    activeTargets = activeTargets.filter((target) => target.modelDef.supportsVision);
    if (activeTargets.length === 0) {
      onEvent({
        type: 'error',
        conversationId: req.conversationId,
        messageId,
        error: `Model "${req.model}" does not support image input.`
      });
      onEvent({ type: 'done', conversationId: req.conversationId, messageId });
      return { messageId };
    }
  }

  let currentMessages = req.messages;
  const primaryContextWindow = activeTargets[0]?.modelDef.contextWindow || 128_000;
  const context = conversationService.estimateContext(req.conversationId);
  if (context.messages > 8 && context.estimatedTokens / Math.max(1, primaryContextWindow - 4096) >= 0.85) {
    const compacted = conversationService.compactConversation(req.conversationId);
    if (compacted.removedCount > 0) {
      currentMessages = conversationService.getMessages(req.conversationId);
      options.onCompaction?.(compacted);
    }
  }

  // Plan mode can inspect the workspace, but it never advertises mutating,
  // shell, media-generation, or third-party MCP tools.
  const availableTools = req.planMode
    ? tools.listTools().filter((tool) => tool.source === 'builtin' && PLAN_SAFE_TOOL_NAMES.has(tool.name))
    : tools.listTools();
  const configuredRounds = req.maxAgenticRounds ?? (appSettings?.maxAgenticRounds as number | undefined) ?? 20;
  const maxAgenticRounds = Number.isFinite(configuredRounds)
    ? Math.min(50, Math.max(1, Math.floor(configuredRounds)))
    : 20;

  let selectedTarget = activeTargets[0];
  let fallbackAllowed = true;
  let lastToolSignature = '';
  let toolSignatureStreak = 0;
  let forceFinalize = false;

  for (let round = 0; round <= maxAgenticRounds; round++) {
    const turnId = round === 0 ? messageId : randomUUID();
    if (round > 0) onEvent({ type: 'start', conversationId: req.conversationId, messageId: turnId });

    // One final tool-free pass turns gathered results into a useful answer
    // instead of ending with a hard loop-limit error.
    const finalizing = forceFinalize || round === maxAgenticRounds;
    const roundTools = finalizing ? [] : availableTools;
    const roundSystemPrompt = finalizing
      ? `${systemPrompt}\n\n[Tool-use limit reached. Do not call tools. Give the best complete final answer using the evidence already gathered.]`
      : systemPrompt;

    const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
    let assistantContent = '';
    let assistantReasoning = '';
    const roundUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    const preparedTargets = await Promise.all(
      activeTargets.map(async (target) => ({
        ...target,
        providerMessages: await hydrateAttachmentRefs(
          truncateMessagesForContext(currentMessages, target.modelDef, systemPrompt)
        )
      }))
    );

    let sideEffectOccurred = false;
    try {
      for await (const { target, event: evt } of streamWithFallback(
        preparedTargets,
        (target) =>
          target.adapter.stream({
            conversationId: req.conversationId,
            cwd,
            model: target.model,
            messages: target.providerMessages,
            tools: roundTools,
            systemPrompt: roundSystemPrompt,
            temperature: req.temperature,
            topP: req.topP,
            maxTokens: req.maxTokens,
            reasoning: req.reasoning,
            planMode: req.planMode,
            signal: options.signal,
            requestPermission: req.planMode
              ? async () => false
              : async (permission) => {
                  sideEffectOccurred = true;
                  fallbackAllowed = false;
                  return tools.requestPermission(permission, { cwd, conversationId: req.conversationId });
                }
          }),
        options.signal || new AbortController().signal,
        () => fallbackAllowed,
        () => !sideEffectOccurred
      )) {
        selectedTarget = target;
        if (commitsProviderOutput(evt)) fallbackAllowed = false;
        if (evt.type === 'delta' && evt.content) {
          assistantContent += evt.content;
          onEvent({ type: 'delta', conversationId: req.conversationId, messageId: turnId, content: evt.content });
        } else if (evt.type === 'reasoning' && evt.reasoning) {
          assistantReasoning += evt.reasoning;
          onEvent({
            type: 'delta',
            conversationId: req.conversationId,
            messageId: turnId,
            reasoning: evt.reasoning
          });
        } else if (evt.type === 'tool_calls' && evt.toolCalls) {
          toolCalls.push(...evt.toolCalls);
          onEvent({ type: 'tool_calls', conversationId: req.conversationId, messageId: turnId, toolCalls: [] });
        } else if (evt.type === 'tool_start' && evt.toolActivity) {
          options.onToolStart?.({
            toolCallId: evt.toolActivity.id,
            toolName: evt.toolActivity.name,
            args: evt.toolActivity.args
          });
        } else if (evt.type === 'tool_result' && evt.toolActivity) {
          options.onToolResult?.({
            toolCallId: evt.toolActivity.id,
            toolName: evt.toolActivity.name,
            args: evt.toolActivity.args,
            result: {
              content: evt.toolActivity.result || (evt.toolActivity.status === 'error' ? 'Tool failed.' : 'Tool completed.'),
              isError: evt.toolActivity.status === 'error',
              meta: evt.toolActivity.meta
            },
            durationMs: evt.toolActivity.durationMs || 0
          });
        } else if (evt.type === 'usage' && evt.usage) {
          roundUsage.promptTokens += evt.usage.promptTokens;
          roundUsage.completionTokens += evt.usage.completionTokens;
          roundUsage.totalTokens += evt.usage.totalTokens;
          onEvent({ type: 'usage', conversationId: req.conversationId, messageId: turnId, usage: evt.usage });
        }
      }
    } catch (error) {
      if (options.signal?.aborted) {
        onEvent({ type: 'done', conversationId: req.conversationId, messageId: turnId });
        return { messageId };
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      onEvent({ type: 'error', conversationId: req.conversationId, messageId: turnId, error: errorMessage });
      onEvent({ type: 'done', conversationId: req.conversationId, messageId: turnId });
      return { messageId };
    }

    activeTargets = [selectedTarget];

    const allowedToolNames = new Set(roundTools.map((tool) => tool.name));
    const validToolCalls = toolCalls.filter((toolCall) => {
      if (!allowedToolNames.has(toolCall.name)) return false;
      try {
        const args: unknown = JSON.parse(toolCall.arguments);
        return typeof args === 'object' && args !== null && !Array.isArray(args);
      } catch {
        return false;
      }
    });
    if (validToolCalls.length !== toolCalls.length && !assistantContent.trim()) {
      assistantContent = 'The provider returned an incomplete tool request, so I did not execute it. Please try again.';
      onEvent({ type: 'delta', conversationId: req.conversationId, messageId: turnId, content: assistantContent });
    }

    if (!finalizing && validToolCalls.length > 0) {
      const signature = validToolCalls.map((toolCall) => `${toolCall.name}:${toolCall.arguments}`).sort().join('|');
      if (signature === lastToolSignature) toolSignatureStreak += 1;
      else { lastToolSignature = signature; toolSignatureStreak = 0; }
      if (toolSignatureStreak >= 2) forceFinalize = true;
    }

    const assistantMsg: Message = {
      id: turnId,
      role: 'assistant',
      content: assistantContent,
      reasoning: assistantReasoning || undefined,
      toolCalls: !finalizing && validToolCalls.length
        ? validToolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: tc.arguments }
          }))
        : undefined,
      createdAt: Date.now(),
      model: selectedTarget.model,
      provider: selectedTarget.providerId,
      usage: roundUsage.totalTokens > 0 ? { ...roundUsage } : undefined
    };
    conversationService.persistMessage(req.conversationId, assistantMsg);
    conversationService.updateConversationTokens(req.conversationId, roundUsage.totalTokens);

    if (options.signal?.aborted) {
      onEvent({ type: 'done', conversationId: req.conversationId, messageId: turnId });
      return { messageId };
    }

    if (finalizing || validToolCalls.length === 0) {
      onEvent({ type: 'done', conversationId: req.conversationId, messageId: turnId });
      if (appSettings?.autoTitle !== false) {
        void maybeGenerateTitle(req.conversationId, selectedTarget.providerId, selectedTarget.model);
      }
      return { messageId };
    }

    const toolResults: Message[] = [];
    for (const tc of validToolCalls) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(tc.arguments); } catch { /* leave empty */ }
      options.onToolStart?.({ toolCallId: tc.id, toolName: tc.name, args });
      const ctx = { cwd, conversationId: req.conversationId };
      const start = Date.now();
      const result = await tools.execute(tc.name, args, ctx);
      const durationMs = Date.now() - start;
      options.onToolResult?.({
        toolCallId: tc.id,
        toolName: tc.name,
        args,
        result: { content: result.content, isError: result.isError, meta: result.meta },
        durationMs
      });
      toolResults.push({
        id: randomUUID(),
        role: 'tool',
        toolCallId: tc.id,
        name: tc.name,
        content: result.content,
        createdAt: Date.now()
      });
    }

    for (const tr of toolResults) conversationService.persistMessage(req.conversationId, tr);
    currentMessages = [...currentMessages, assistantMsg, ...toolResults];
  }

  const limitMessage = `Agent stopped after ${maxAgenticRounds} tool round${maxAgenticRounds === 1 ? '' : 's'}.`;
  onEvent({ type: 'error', conversationId: req.conversationId, messageId, error: limitMessage });
  onEvent({ type: 'done', conversationId: req.conversationId, messageId });
  return { messageId };
}

async function maybeGenerateTitle(conversationId: string, providerId: string, model: string): Promise<void> {
  try {
    const conv = getDb().prepare('SELECT title FROM conversations WHERE id = ?').get(conversationId) as { title: string } | undefined;
    if (!conv) return;
    const isDefault = !conv.title || conv.title === 'New chat' || conv.title === 'New conversation';
    if (!isDefault) return;

    const rows = getDb()
      .prepare('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY sort_order ASC')
      .all(conversationId) as Array<{ role: string; content: string }>;
    const userRow = rows.find((r) => r.role === 'user');
    const assistantRow = rows.find((r) => r.role === 'assistant');
    if (!userRow || !assistantRow) return;

    const adapter = getAdapter(providerId);
    if (!adapter) return;
    let title = '';
    for await (const evt of adapter.stream({
      conversationId,
      model,
      messages: [
        { id: randomUUID(), role: 'user', content: userRow.content, createdAt: Date.now() },
        { id: randomUUID(), role: 'assistant', content: assistantRow.content, createdAt: Date.now() }
      ],
      systemPrompt: 'Create a concise title (3-6 words) for this conversation. Reply with only the title, no quotes or extra text.',
      maxTokens: 20,
      temperature: 0.3
    })) {
      if (evt.type === 'delta' && evt.content) title += evt.content;
      if (evt.type === 'error') break;
    }
    title = title.trim().replace(/^["']|["']$/g, '').replace(/\.$/, '').slice(0, 60);
    if (!title) return;
    getDb().prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?').run(title, Date.now(), conversationId);
  } catch (err) {
    logger.warn('chat', 'title generation failed', err);
  }
}
