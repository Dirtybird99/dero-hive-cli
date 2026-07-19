import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { ProviderAdapter, ProviderStreamRequest, ProviderStreamEvent } from './base';
import type { ContentPart, Message, ProviderConfig, ProviderModel, ThinkingOption } from '@shared/types';
import { APP_VERSION } from '@shared/version';
import { logger } from '../utils/logger';
import { canonicalizePath, getWorkspaceRoot, resolveAndValidate } from '../utils/pathPolicy';

import type * as acp from '@agentclientprotocol/sdk';
import type { Client, InitializeResponse, SessionConfigOption, SessionConfigSelectOption } from '@agentclientprotocol/sdk';

const ACP_PROTOCOL_VERSION = 1;
const ACP_OPERATION_TIMEOUT_MS = 30_000;
const ACP_CONTROL_TIMEOUT_MS = 5_000;
const ACP_AUTH_TIMEOUT_MS = 180_000;
const ACP_SHUTDOWN_GRACE_MS = 1_000;
export const CODEX_ACP_MAX_READ_BYTES = 8 * 1024 * 1024;
export const CODEX_ACP_MAX_WRITE_BYTES = 8 * 1024 * 1024;

let acpModule: typeof import('@agentclientprotocol/sdk') | null = null;
async function loadAcp(): Promise<typeof import('@agentclientprotocol/sdk')> {
  if (!acpModule) acpModule = await import('@agentclientprotocol/sdk');
  return acpModule;
}

interface AcpEvent {
  type: ProviderStreamEvent['type'];
  content?: string;
  reasoning?: string;
  error?: string;
  toolActivity?: NonNullable<ProviderStreamEvent['toolActivity']>;
}

interface SessionState {
  sessionId: string;
  model: string;
  bootstrapped: boolean;
  cwd: string;
  systemPrompt?: string;
  messageKeys: string[];
}

interface Runtime {
  proc: ChildProcessWithoutNullStreams;
  exited: Promise<void>;
  conn: acp.ClientSideConnection;
  init: InitializeResponse;
  queues: Map<string, AsyncQueue<AcpEvent>>;
  permissionHandlers: Map<string, (request: { requestId: string; toolName: string; args: Record<string, unknown>; description?: string }) => Promise<boolean>>;
  readOnlySessions: Set<string>;
  sessionRoots: Map<string, string>;
  sessions: Map<string, SessionState>;
  authenticationAttempt: Promise<void> | null;
}

class AsyncQueue<T> {
  private items: T[] = [];
  private resolvers: Array<(value: T) => void> = [];
  private closed = false;
  private terminal!: T;

  push(item: T): void {
    if (this.closed) return;
    const resolve = this.resolvers.shift();
    if (resolve) resolve(item);
    else this.items.push(item);
  }

  next(): Promise<T> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve(item);
    if (this.closed) return Promise.resolve(this.terminal);
    return new Promise((resolve) => this.resolvers.push(resolve));
  }

  close(terminal: T): void {
    if (this.closed) return;
    this.closed = true;
    this.terminal = terminal;
    this.items = [];
    for (const resolve of this.resolvers.splice(0)) resolve(terminal);
  }
}

function defaultCodexAcpPath(): string {
  const appRoot = process.env.HIVE_APP_ROOT || process.cwd();
  const candidates = [
    join(appRoot, 'node_modules/@agentclientprotocol/codex-acp/dist/index.js'),
    join(process.cwd(), 'node_modules/@agentclientprotocol/codex-acp/dist/index.js'),
    'codex-acp'
  ];
  return candidates.find((candidate) => candidate === 'codex-acp' || existsSync(candidate)) || candidates[0];
}

function bundledCodexPath(): string | undefined {
  if (process.platform !== 'win32') return undefined;
  const appRoot = process.env.HIVE_APP_ROOT || process.cwd();
  const target = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
  const packageName = process.arch === 'arm64' ? 'codex-win32-arm64' : 'codex-win32-x64';
  const candidates = [
    join(appRoot, `node_modules/@openai/${packageName}/vendor/${target}/bin/codex.exe`),
    join(process.cwd(), `node_modules/@openai/${packageName}/vendor/${target}/bin/codex.exe`),
  ];
  return candidates.find(existsSync);
}

function findSelectOption(options: SessionConfigOption[] | null | undefined, category: string, id?: string): SessionConfigOption | undefined {
  return options?.find((option) => option.type === 'select' && (option.category === category || option.id === id));
}

function flattenSelectOptions(option: SessionConfigOption | undefined): SessionConfigSelectOption[] {
  if (!option || option.type !== 'select' || !option.options) return [];
  return option.options.flatMap((entry) => 'options' in entry && Array.isArray(entry.options)
    ? entry.options as SessionConfigSelectOption[]
    : [entry as SessionConfigSelectOption]);
}

function thinkingOptionsFromConfig(options: SessionConfigOption[] | null | undefined): ThinkingOption[] {
  const option = findSelectOption(options, 'thought_level', 'reasoning_effort');
  return flattenSelectOptions(option).flatMap((entry) => {
    const id = entry.value as ThinkingOption['id'];
    if (!['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(id)) return [];
    return [{ id, label: entry.name || id, description: entry.description || `${entry.name || id} reasoning` }];
  });
}

function attachmentBlock(part: ContentPart): acp.ContentBlock[] {
  if (part.type === 'text') return [{ type: 'text', text: part.text }];
  if (part.type === 'image_url') {
    const match = /^data:([^;,]+);base64,([\s\S]+)$/u.exec(part.image_url.url);
    return match
      ? [{ type: 'image', mimeType: match[1], data: match[2] }]
      : [{ type: 'resource_link', name: 'image', uri: part.image_url.url }];
  }
  if (part.type === 'input_audio') {
    return [{ type: 'audio', mimeType: part.input_audio.format === 'wav' ? 'audio/wav' : 'audio/mpeg', data: part.input_audio.data }];
  }
  if (part.type === 'file') {
    const uri = `hive-attachment:///${encodeURIComponent(part.file.filename)}`;
    if (/^(text\/|application\/(json|javascript|xml))/u.test(part.file.mimeType)) {
      return [{ type: 'resource', resource: { uri, mimeType: part.file.mimeType, text: Buffer.from(part.file.data, 'base64').toString('utf8') } }];
    }
    return [{ type: 'resource', resource: { uri, mimeType: part.file.mimeType, blob: part.file.data } }];
  }
  return [{ type: 'resource_link', name: part.attachment.filename, uri: `hive-attachment:///${part.attachment.id}`, mimeType: part.attachment.mimeType, size: part.attachment.size }];
}

function contentBlocksFromMessages(messages: Message[], systemPrompt?: string): acp.ContentBlock[] {
  const blocks: acp.ContentBlock[] = [];
  if (systemPrompt) blocks.push({ type: 'text', text: systemPrompt });
  for (const message of messages) {
    if (typeof message.content === 'string') {
      blocks.push({ type: 'text', text: `[${message.role}]: ${message.content}` });
      continue;
    }
    blocks.push({ type: 'text', text: `[${message.role} message]` });
    for (const part of message.content) blocks.push(...attachmentBlock(part));
  }
  return blocks;
}

export function acpMessageContextKey(message: Message): string {
  return createHash('sha256')
    .update(message.id)
    .update('\0')
    .update(message.role)
    .update('\0')
    .update(JSON.stringify(message.content))
    .digest('base64url');
}

export function continuesAcpContext(
  previousSystemPrompt: string | undefined,
  previousMessageKeys: readonly string[],
  systemPrompt: string | undefined,
  messages: readonly Message[]
): boolean {
  return previousSystemPrompt === systemPrompt
    && previousMessageKeys.every((key, index) => messages[index] && acpMessageContextKey(messages[index]) === key);
}

function toolArgs(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { input: value ?? null };
}

function toolResult(update: acp.ToolCall | acp.ToolCallUpdate): { content: string; meta: Record<string, unknown> } {
  const rendered: string[] = [];
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const item of update.content || []) {
    if (item.type === 'diff') {
      const oldLines = (item.oldText || '').split('\n').length;
      const newLines = item.newText.split('\n').length;
      linesAdded += Math.max(0, newLines - oldLines);
      linesRemoved += Math.max(0, oldLines - newLines);
      rendered.push(`Updated ${item.path} (+${Math.max(0, newLines - oldLines)} -${Math.max(0, oldLines - newLines)})`);
    } else if (item.type === 'terminal') {
      rendered.push(`Terminal: ${item.terminalId}`);
    } else if (item.content.type === 'text') {
      rendered.push(item.content.text);
    } else {
      rendered.push(`[${item.content.type} result]`);
    }
  }
  if (update.rawOutput !== undefined) {
    rendered.push(typeof update.rawOutput === 'string' ? update.rawOutput : JSON.stringify(update.rawOutput, null, 2));
  }
  return {
    content: rendered.filter(Boolean).join('\n') || (update.status === 'failed' ? 'Codex tool failed.' : 'Codex tool completed.'),
    meta: {
      source: 'codex-acp',
      ...(update.kind ? { kind: update.kind } : {}),
      ...(update.locations?.length ? { locations: update.locations } : {}),
      ...(linesAdded || linesRemoved ? { linesAdded, linesRemoved } : {})
    }
  };
}

function sessionFilePath(sessionRoots: ReadonlyMap<string, string>, sessionId: string, input: string): string {
  const root = sessionRoots.get(sessionId);
  if (!root) throw new Error(`Unknown Codex session ${JSON.stringify(sessionId)}; file access denied.`);
  return resolveAndValidate(input, root);
}

function readParameter(name: 'line' | 'limit', value: number | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1 || value > 0xffff_ffff) {
    throw new Error(`${name} must be an integer from 1 through 4294967295.`);
  }
  return value;
}

function readBoundedFile(path: string): string {
  const fd = openSync(path, 'r');
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`Cannot read non-file path: ${path}`);
    if (stat.size > CODEX_ACP_MAX_READ_BYTES) {
      throw new Error(`File exceeds the ${CODEX_ACP_MAX_READ_BYTES}-byte Codex read limit.`);
    }

    // The extra byte detects a file that grows between fstat and read without
    // ever allocating more than the configured maximum plus one byte.
    const content = Buffer.allocUnsafe(stat.size + 1);
    let offset = 0;
    while (offset < content.length) {
      const bytesRead = readSync(fd, content, offset, content.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > stat.size) throw new Error('File changed while it was being read; retry the operation.');
    return content.subarray(0, offset).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function selectLines(content: string, line: number, limit: number | undefined): string {
  let start = 0;
  for (let current = 1; current < line; current += 1) {
    const newline = content.indexOf('\n', start);
    if (newline < 0) return '';
    start = newline + 1;
  }
  if (limit === undefined) return content.slice(start);

  let end = start;
  for (let remaining = limit; remaining > 0; remaining -= 1) {
    const newline = content.indexOf('\n', end);
    if (newline < 0) return content.slice(start);
    if (remaining === 1) return content.slice(start, newline);
    end = newline + 1;
  }
  return '';
}

/** Routes ACP notifications to the queue for the session that produced them. */
export class CodexAcpClient implements Client {
  private readonly tools = new Map<string, { name: string; args: Record<string, unknown>; startedAt: number; kind?: acp.ToolKind }>();

  constructor(
    private readonly queues: Map<string, AsyncQueue<AcpEvent>>,
    private readonly permissionHandlers: Runtime['permissionHandlers'],
    private readonly readOnlySessions: Set<string>,
    private readonly sessionRoots: ReadonlyMap<string, string>
  ) {}

  async requestPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    if (this.readOnlySessions.has(params.sessionId)) return { outcome: { outcome: 'cancelled' } };
    const handler = this.permissionHandlers.get(params.sessionId);
    if (!handler) return { outcome: { outcome: 'cancelled' } };

    const rawInput = params.toolCall.rawInput;
    const args = rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
      ? rawInput as Record<string, unknown>
      : { input: rawInput ?? null };
    const allowed = await handler({
      requestId: `codex-${randomUUID()}`,
      toolName: params.toolCall.title || params.toolCall.kind || 'Codex tool',
      args,
      description: 'Codex needs permission to perform this action.'
    });
    if (!allowed) return { outcome: { outcome: 'cancelled' } };

    const option = params.options.find((item) => item.kind === 'allow_once')
      || params.options.find((item) => item.kind === 'allow_always');
    return option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } };
  }

  sessionUpdate(params: acp.SessionNotification): void {
    const queue = this.queues.get(params.sessionId);
    if (!queue) return;
    const update = params.update;
    if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text' && update.content.text) {
      queue.push({ type: 'delta', content: update.content.text });
    } else if (update.sessionUpdate === 'agent_thought_chunk' && update.content.type === 'text' && update.content.text) {
      queue.push({ type: 'reasoning', reasoning: update.content.text });
    } else if (update.sessionUpdate === 'tool_call') {
      const state = { name: update.title, args: toolArgs(update.rawInput), startedAt: Date.now(), kind: update.kind };
      this.tools.set(`${params.sessionId}\0${update.toolCallId}`, state);
      queue.push({
        type: 'tool_start',
        toolActivity: { id: update.toolCallId, name: update.title, args: state.args, status: 'running', meta: { source: 'codex-acp', kind: update.kind } }
      });
      if (update.status === 'completed' || update.status === 'failed') {
        const result = toolResult(update);
        queue.push({
          type: 'tool_result',
          toolActivity: {
            id: update.toolCallId, name: update.title, args: state.args,
            status: update.status === 'failed' ? 'error' : 'success', result: result.content,
            durationMs: Date.now() - state.startedAt, meta: result.meta
          }
        });
        this.tools.delete(`${params.sessionId}\0${update.toolCallId}`);
      }
    } else if (update.sessionUpdate === 'tool_call_update') {
      const key = `${params.sessionId}\0${update.toolCallId}`;
      const current = this.tools.get(key) || {
        name: update.title || update.kind || 'Codex tool', args: toolArgs(update.rawInput), startedAt: Date.now(), kind: update.kind || undefined
      };
      if (update.title) current.name = update.title;
      if (update.rawInput !== undefined) current.args = toolArgs(update.rawInput);
      if (update.kind) current.kind = update.kind;
      if (!this.tools.has(key)) {
        this.tools.set(key, current);
        queue.push({ type: 'tool_start', toolActivity: { id: update.toolCallId, name: current.name, args: current.args, status: 'running', meta: { source: 'codex-acp', kind: current.kind } } });
      }
      if (update.status === 'completed' || update.status === 'failed') {
        const result = toolResult(update);
        queue.push({
          type: 'tool_result',
          toolActivity: {
            id: update.toolCallId, name: current.name, args: current.args,
            status: update.status === 'failed' ? 'error' : 'success', result: result.content,
            durationMs: Date.now() - current.startedAt, meta: result.meta
          }
        });
        this.tools.delete(key);
      }
    }
  }

  readTextFile(params: acp.ReadTextFileRequest): acp.ReadTextFileResponse {
    const line = readParameter('line', params.line) || 1;
    const limit = readParameter('limit', params.limit);
    const path = sessionFilePath(this.sessionRoots, params.sessionId, params.path);
    return { content: selectLines(readBoundedFile(path), line, limit) };
  }

  writeTextFile(params: acp.WriteTextFileRequest): acp.WriteTextFileResponse {
    const path = sessionFilePath(this.sessionRoots, params.sessionId, params.path);
    if (this.readOnlySessions.has(params.sessionId)) throw new Error('Plan mode is read-only; file writes are disabled.');
    const bytes = Buffer.byteLength(params.content, 'utf8');
    if (bytes > CODEX_ACP_MAX_WRITE_BYTES) {
      throw new Error(`Content exceeds the ${CODEX_ACP_MAX_WRITE_BYTES}-byte Codex write limit.`);
    }

    let mode = 0o600;
    try {
      const existing = statSync(path);
      if (!existing.isFile()) throw new Error(`Cannot replace non-file path: ${path}`);
      mode = existing.mode & 0o777;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    mkdirSync(dirname(path), { recursive: true });
    const temporary = join(dirname(path), `.dero-hive-${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, params.content, { encoding: 'utf8', flag: 'wx', mode });
      renameSync(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
    return {};
  }
}

interface ChildHandle {
  proc: ChildProcessWithoutNullStreams;
  exited: Promise<void>;
  spawnFailure: Promise<never>;
}

function trackChild(proc: ChildProcessWithoutNullStreams): ChildHandle {
  const spawnFailure = new Promise<never>((_resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    proc.once('error', onError);
    proc.once('spawn', () => proc.off('error', onError));
  });
  const exited = new Promise<void>((resolveExit) => {
    const done = (): void => {
      proc.off('error', onError);
      proc.off('exit', done);
      resolveExit();
    };
    const onError = (): void => {
      if (proc.pid === undefined) done();
    };
    proc.once('error', onError);
    proc.once('exit', done);
  });
  return { proc, exited, spawnFailure };
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      clearTimeout(timer);
      reject(new Error(message));
    }, ms);
    timer.unref();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

async function closeSession(runtime: Runtime, sessionId: string): Promise<void> {
  try {
    await withTimeout(
      runtime.conn.closeSession({ sessionId }),
      ACP_CONTROL_TIMEOUT_MS,
      'Codex session close timed out.'
    );
  } finally {
    runtime.sessionRoots.delete(sessionId);
  }
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function signalPosixTree(proc: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (proc.pid !== undefined) {
    try {
      process.kill(-proc.pid, signal);
      return;
    } catch { /* fall back to the direct child */ }
  }
  try { proc.kill(signal); } catch { /* best effort */ }
}

async function waitForProcessGroupExit(pid: number): Promise<boolean> {
  const deadline = Date.now() + ACP_SHUTDOWN_GRACE_MS;
  while (processGroupExists(pid)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise<void>((resolveWait) => {
      const timer = setTimeout(() => {
        clearTimeout(timer);
        resolveWait();
      }, Math.min(25, remaining));
    });
  }
  return true;
}

async function runTaskkill(pid: number): Promise<boolean> {
  const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  const result = new Promise<number | null>((resolveResult, reject) => {
    const onError = (error: Error): void => {
      killer.off('exit', onExit);
      reject(error);
    };
    const onExit = (code: number | null): void => {
      killer.off('error', onError);
      resolveResult(code);
    };
    killer.once('error', onError);
    killer.once('exit', onExit);
  });

  try {
    return await withTimeout(result, ACP_SHUTDOWN_GRACE_MS, 'taskkill timed out.') === 0;
  } catch (error) {
    try { killer.kill('SIGKILL'); } catch { /* best effort */ }
    await withTimeout(result.then(() => {}, () => {}), ACP_SHUTDOWN_GRACE_MS, 'taskkill could not be reaped.').catch(() => {});
    logger.debug('codex-acp', `taskkill failed: ${String(error)}`);
    return false;
  }
}

async function terminateChildOnce(child: Pick<ChildHandle, 'proc' | 'exited'>): Promise<void> {
  const { proc, exited } = child;
  const pid = proc.pid;
  if (pid === undefined) {
    await withTimeout(exited, ACP_SHUTDOWN_GRACE_MS, 'Codex ACP spawn could not be reaped.')
      .catch((error) => logger.warn('codex-acp', String(error)));
    return;
  }

  if (process.platform === 'win32') {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      await exited;
      return;
    }
    const killed = await runTaskkill(pid);
    if (!killed && proc.exitCode === null && proc.signalCode === null) {
      try { proc.kill('SIGKILL'); } catch { /* best effort */ }
    }
    await withTimeout(exited, ACP_SHUTDOWN_GRACE_MS, 'Codex ACP process tree could not be reaped.')
      .catch((error) => logger.warn('codex-acp', String(error)));
    return;
  }

  if ((proc.exitCode !== null || proc.signalCode !== null) && !processGroupExists(pid)) {
    await exited;
    return;
  }
  signalPosixTree(proc, 'SIGTERM');
  const [parentExited, treeExited] = await Promise.all([
    withTimeout(exited, ACP_SHUTDOWN_GRACE_MS, 'Codex ACP did not exit after termination.').then(() => true, () => false),
    waitForProcessGroupExit(pid)
  ]);
  if (parentExited && treeExited) return;
  logger.warn('codex-acp', 'process tree did not stop gracefully; forcing termination');
  signalPosixTree(proc, 'SIGKILL');
  const [parentReaped, treeReaped] = await Promise.all([
    withTimeout(exited, ACP_SHUTDOWN_GRACE_MS, 'Codex ACP process could not be reaped.').then(() => true, () => false),
    waitForProcessGroupExit(pid)
  ]);
  if (!parentReaped || !treeReaped) logger.warn('codex-acp', 'Codex ACP process tree could not be reaped.');
}

const childTerminations = new WeakMap<ChildProcessWithoutNullStreams, Promise<void>>();

function terminateChild(child: Pick<ChildHandle, 'proc' | 'exited'>): Promise<void> {
  const current = childTerminations.get(child.proc);
  if (current) return current;
  const termination = terminateChildOnce(child);
  childTerminations.set(child.proc, termination);
  return termination;
}

function extractAcpError(error: unknown): { message: string; details?: string } {
  const message = error instanceof Error ? error.message : String(error);
  const data = (error as { data?: { details?: string; message?: string } }).data;
  return { message, details: data?.details || data?.message };
}

export class CodexAcpAdapter implements ProviderAdapter {
  readonly id: string;
  private runtimePromise: Promise<Runtime> | null = null;
  private activeRuntime: Runtime | null = null;
  private startingChild: ChildHandle | null = null;
  private disposePromise: Promise<void> | null = null;
  private disposed = false;

  constructor(private readonly cfg: ProviderConfig, private readonly operationTimeoutMs = ACP_OPERATION_TIMEOUT_MS) {
    this.id = cfg.id;
  }

  private async createRuntime(): Promise<Runtime> {
    const sdk = await loadAcp();
    if (this.disposed) throw new Error('Codex provider has been disposed');
    const commandPath = this.cfg.customHeaders?.commandPath || defaultCodexAcpPath();
    const isJs = commandPath.endsWith('.js');
    const command = isJs ? process.execPath : commandPath;
    const args = isJs ? [commandPath] : commandPath === 'npx' ? ['-y', '@agentclientprotocol/codex-acp'] : [];

    logger.info('codex-acp', `starting persistent adapter: ${command} ${args.join(' ')}`);
    const codexPath = bundledCodexPath();
    const proc = spawn(command, args, {
      env: {
        ...process.env,
        ...(isJs ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
        ...(this.cfg.customHeaders?.noBrowser === '1' ? { NO_BROWSER: '1' } : {}),
        ...(codexPath ? { CODEX_PATH: codexPath } : {})
      },
      detached: process.platform !== 'win32',
      windowsHide: true
    });
    const child = trackChild(proc);
    this.startingChild = child;
    const queues = new Map<string, AsyncQueue<AcpEvent>>();
    const permissionHandlers = new Map<string, Runtime['permissionHandlers'] extends Map<string, infer T> ? T : never>();
    const readOnlySessions = new Set<string>();
    const sessionRoots = new Map<string, string>();
    const sessions = new Map<string, SessionState>();
    proc.stderr.on('data', (data: Buffer) => logger.debug('codex-acp', data.toString().trim()));
    proc.on('error', (error) => logger.error('codex-acp', `process error: ${error.message}`));
    proc.once('exit', (code) => {
      logger.info('codex-acp', `process exited (${code ?? 'signal'})`);
      const terminal = { type: 'error', error: this.disposed ? 'Codex provider disposed.' : 'Codex ACP process exited unexpectedly.' } as AcpEvent;
      for (const queue of queues.values()) queue.close(terminal);
      queues.clear();
      permissionHandlers.clear();
      readOnlySessions.clear();
      sessionRoots.clear();
      sessions.clear();
      const current = this.activeRuntime?.proc === proc || this.startingChild?.proc === proc;
      if (this.activeRuntime?.proc === proc) this.activeRuntime = null;
      if (this.startingChild?.proc === proc) this.startingChild = null;
      if (current) this.runtimePromise = null;
      // On Windows taskkill cannot traverse a dead root PID. codex-acp keeps its
      // Codex app-server on inherited stdio, so an ACP crash closes the pipe and
      // the app-server exits; live-root shutdown above still force-kills /T.
      if (process.platform !== 'win32') void terminateChild(child);
    });

    try {
      const stream = sdk.ndJsonStream(
        Writable.toWeb(proc.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>
      );
      const conn = new sdk.ClientSideConnection(() => new CodexAcpClient(queues, permissionHandlers, readOnlySessions, sessionRoots), stream);
      const init = await withTimeout(Promise.race([conn.initialize({
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientInfo: { name: 'DERO Hive', version: APP_VERSION },
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          session: { configOptions: { boolean: {} } }
        }
      }), child.spawnFailure]), ACP_OPERATION_TIMEOUT_MS, 'ACP initialize timed out. Is codex-acp running?');
      if (this.disposed) throw new Error('Codex provider has been disposed');
      return { proc, exited: child.exited, conn, init, queues, permissionHandlers, readOnlySessions, sessionRoots, sessions, authenticationAttempt: null };
    } catch (error) {
      for (const queue of queues.values()) queue.close({ type: 'error', error: extractAcpError(error).message });
      sessionRoots.clear();
      await terminateChild(child);
      if (this.startingChild?.proc === proc) this.startingChild = null;
      throw error;
    }
  }

  private getRuntime(): Promise<Runtime> {
    if (this.disposed) return Promise.reject(new Error('Codex provider has been disposed'));
    if (!this.runtimePromise) {
      const promise = this.createRuntime()
        .then(async (runtime) => {
          if (this.disposed || runtime.proc.exitCode !== null || runtime.proc.signalCode !== null) {
            await terminateChild(runtime);
            throw new Error('Codex provider has been disposed');
          }
          this.activeRuntime = runtime;
          if (this.startingChild?.proc === runtime.proc) this.startingChild = null;
          return runtime;
        })
        .catch((error) => {
          if (this.runtimePromise === promise) this.runtimePromise = null;
          throw error;
        });
      this.runtimePromise = promise;
    }
    return this.runtimePromise;
  }

  private async authenticate(runtime: Runtime): Promise<void> {
    // Concurrent first messages must share one login flow rather than each
    // opening their own browser or command window.
    if (runtime.authenticationAttempt) return runtime.authenticationAttempt;
    runtime.authenticationAttempt = this.authenticateOnce(runtime)
      .finally(() => { runtime.authenticationAttempt = null; });
    return runtime.authenticationAttempt;
  }

  private async authenticateOnce(runtime: Runtime): Promise<void> {
    const methods = runtime.init.authMethods || [];
    const method = methods.find((item) => /chatgpt|chat-gpt/i.test(`${item.id} ${item.name}`));
    if (!method) throw new Error('Codex ACP did not advertise ChatGPT authentication. Ensure NO_BROWSER is not enabled.');
    logger.info('codex-acp', `starting ChatGPT authentication (${method.id})`);
    await withTimeout(runtime.conn.authenticate({ methodId: method.id }), ACP_AUTH_TIMEOUT_MS, 'ChatGPT authentication timed out.');
  }

  private async newSessionAttempt(runtime: Runtime, cwd: string, timeoutMessage: string): Promise<acp.NewSessionResponse> {
    const canonicalCwd = canonicalizePath(cwd);
    const pending = runtime.conn.newSession({ cwd: canonicalCwd, mcpServers: [] });
    try {
      const response = await withTimeout(pending, this.operationTimeoutMs, timeoutMessage);
      runtime.sessionRoots.set(response.sessionId, canonicalCwd);
      return response;
    } catch (error) {
      // A request timeout cannot cancel the ACP operation. If it later creates
      // a session, close that orphan immediately instead of leaking it.
      void pending.then(
        (response) => closeSession(runtime, response.sessionId)
          .catch((closeError) => logger.debug('codex-acp', `late session cleanup failed: ${String(closeError)}`)),
        () => {}
      );
      throw error;
    }
  }

  private async newSession(runtime: Runtime, cwd: string): Promise<acp.NewSessionResponse> {
    try {
      return await this.newSessionAttempt(runtime, cwd, 'Codex session creation timed out.');
    } catch (firstError) {
      const { message, details } = extractAcpError(firstError);
      if (!/auth|login|sign.?in|unauth/i.test(`${message} ${details || ''}`)) throw firstError;
      await this.authenticate(runtime);
      return this.newSessionAttempt(runtime, cwd, 'Codex session creation timed out after authentication.');
    }
  }

  private async configureSession(
    runtime: Runtime,
    session: SessionState,
    model: string,
    effort?: string
  ): Promise<SessionConfigOption[]> {
    let options: SessionConfigOption[] = [];
    if (model && session.model !== model) {
      const response = await withTimeout(
        runtime.conn.setSessionConfigOption({ sessionId: session.sessionId, configId: 'model', value: model }),
        ACP_OPERATION_TIMEOUT_MS,
        'Codex model configuration timed out.'
      );
      options = response.configOptions || [];
      session.model = model;
    }
    if (effort) {
      const reasoningOption = findSelectOption(options, 'thought_level', 'reasoning_effort');
      const supported = flattenSelectOptions(reasoningOption).some((item) => item.value === effort);
      if (!supported && options.length > 0) throw new Error(`${effort} reasoning is not supported by ${model}`);
      const response = await withTimeout(
        runtime.conn.setSessionConfigOption({
          sessionId: session.sessionId,
          configId: reasoningOption?.id || 'reasoning_effort',
          value: effort
        }),
        ACP_OPERATION_TIMEOUT_MS,
        'Codex reasoning configuration timed out.'
      );
      options = response.configOptions || options;
    }
    return options;
  }

  async testConnection(): Promise<{ ok: boolean; error?: string; models?: string[]; modelDetails?: Record<string, Partial<ProviderModel>>; hint?: string }> {
    let runtime: Runtime | undefined;
    let sessionId: string | undefined;
    try {
      runtime = await this.getRuntime();
      const response = await this.newSession(runtime, getWorkspaceRoot());
      sessionId = response.sessionId;
      const modelOption = findSelectOption(response.configOptions, 'model', 'model');
      const models = flattenSelectOptions(modelOption).map((item) => item.value);
      const details: Record<string, Partial<ProviderModel>> = {};
      const state: SessionState = { sessionId, model: '', bootstrapped: false, cwd: getWorkspaceRoot(), messageKeys: [] };

      for (const model of models) {
        const options = await this.configureSession(runtime, state, model);
        const thinkingOptions = thinkingOptionsFromConfig(options);
        details[model] = { supportsReasoning: thinkingOptions.length > 0, thinkingOptions };
      }
      if (models.length === 0) throw new Error('No models were reported by Codex ACP.');
      return { ok: true, models, modelDetails: details };
    } catch (error) {
      const { message, details } = extractAcpError(error);
      logger.error('codex-acp', `connection test failed: ${message}${details ? ` - ${details}` : ''}`);
      return {
        ok: false,
        error: details || message,
        hint: 'Make sure ChatGPT Codex access is enabled for the account, then try Models again.'
      };
    } finally {
      if (runtime && sessionId) {
        try { await closeSession(runtime, sessionId); } catch { /* best effort */ }
      }
    }
  }

  async *stream(req: ProviderStreamRequest): AsyncGenerator<ProviderStreamEvent> {
    const runtime = await this.getRuntime();
    const requestedCwd = resolve(req.cwd || getWorkspaceRoot());
    let session = runtime.sessions.get(req.conversationId);
    if (session && (resolve(session.cwd) !== requestedCwd || (session.bootstrapped && !continuesAcpContext(
      session.systemPrompt,
      session.messageKeys,
      req.systemPrompt,
      req.messages
    )))) {
      runtime.queues.get(session.sessionId)?.close({ type: 'error', error: 'Codex session was replaced.' });
      try { await closeSession(runtime, session.sessionId); } catch { /* recreate below */ }
      runtime.sessions.delete(req.conversationId);
      runtime.queues.delete(session.sessionId);
      runtime.permissionHandlers.delete(session.sessionId);
      runtime.readOnlySessions.delete(session.sessionId);
      session = undefined;
    }
    if (!session) {
      const created = await this.newSession(runtime, requestedCwd);
      session = { sessionId: created.sessionId, model: '', bootstrapped: false, cwd: requestedCwd, messageKeys: [] };
      runtime.sessions.set(req.conversationId, session);
    }

    await this.configureSession(runtime, session, req.model, req.reasoning?.effort);
    if (req.signal?.aborted) {
      runtime.sessions.delete(req.conversationId);
      await closeSession(runtime, session.sessionId).catch(() => {});
      throw new DOMException('Request cancelled.', 'AbortError');
    }
    if (req.planMode) runtime.readOnlySessions.add(session.sessionId);
    else runtime.readOnlySessions.delete(session.sessionId);
    const queue = new AsyncQueue<AcpEvent>();
    runtime.queues.set(session.sessionId, queue);
    if (req.requestPermission) runtime.permissionHandlers.set(session.sessionId, req.requestPermission);

    const messages = session.bootstrapped ? req.messages.slice(-1) : req.messages;
    const prompt = contentBlocksFromMessages(messages, session.bootstrapped ? undefined : req.systemPrompt);
    for (const attachment of req.attachments || []) {
      if (attachment.type === 'image') prompt.push({ type: 'image', data: attachment.data, mimeType: attachment.mimeType });
      else if (/^(text\/|application\/(json|javascript|xml))/u.test(attachment.mimeType)) {
        prompt.push({
          type: 'resource',
          resource: {
            uri: `hive-attachment:///${encodeURIComponent(attachment.filename)}`,
            mimeType: attachment.mimeType,
            text: Buffer.from(attachment.data, 'base64').toString('utf8')
          }
        });
      } else {
        prompt.push({
          type: 'resource',
          resource: { uri: `hive-attachment:///${encodeURIComponent(attachment.filename)}`, mimeType: attachment.mimeType, blob: attachment.data }
        });
      }
    }

    let cancelPromise: Promise<void> | null = null;
    const onAbort = (): void => {
      cancelPromise ||= withTimeout(
        runtime.conn.cancel({ sessionId: session!.sessionId }),
        ACP_CONTROL_TIMEOUT_MS,
        'Codex cancellation timed out.'
      )
        .then(() => {})
        .catch((error) => { logger.debug('codex-acp', `cancel failed: ${String(error)}`); });
      queue.close({ type: 'error', error: 'Request cancelled.' });
    };
    req.signal?.addEventListener('abort', onAbort, { once: true });
    const promptPromise = runtime.conn.prompt({ sessionId: session.sessionId, prompt })
      .then(() => queue.push({ type: 'done' }))
      .catch((error) => queue.push({ type: 'error', error: extractAcpError(error).details || extractAcpError(error).message }));

    let terminalType: AcpEvent['type'] | undefined;
    try {
      while (true) {
        const event = await queue.next();
        yield event;
        if (event.type === 'done' || event.type === 'error') {
          terminalType = event.type;
          break;
        }
      }
      if (!req.signal?.aborted && terminalType === 'done') {
        await promptPromise;
        session.bootstrapped = true;
        session.systemPrompt = req.systemPrompt;
        session.messageKeys = req.messages.map(acpMessageContextKey);
      }
    } finally {
      req.signal?.removeEventListener('abort', onAbort);
      runtime.queues.delete(session.sessionId);
      runtime.permissionHandlers.delete(session.sessionId);
      runtime.readOnlySessions.delete(session.sessionId);
      if (req.signal?.aborted) {
        runtime.sessions.delete(req.conversationId);
        await Promise.allSettled([
          cancelPromise || Promise.resolve(),
          closeSession(runtime, session.sessionId)
        ]);
      }
    }
  }

  async closeConversation(conversationId: string): Promise<void> {
    const runtime = this.activeRuntime;
    const session = runtime?.sessions.get(conversationId);
    if (!runtime || !session) return;
    runtime.queues.get(session.sessionId)?.close({ type: 'error', error: 'Codex conversation closed.' });
    runtime.sessions.delete(conversationId);
    runtime.queues.delete(session.sessionId);
    runtime.permissionHandlers.delete(session.sessionId);
    runtime.readOnlySessions.delete(session.sessionId);
    try { await closeSession(runtime, session.sessionId); }
    catch (error) { logger.debug('codex-acp', `close session failed: ${String(error)}`); }
  }

  dispose(): Promise<void> {
    this.disposed = true;
    this.disposePromise ||= this.disposeRuntime();
    return this.disposePromise;
  }

  private async disposeRuntime(): Promise<void> {
    const runtime = this.activeRuntime;
    const startingChild = this.startingChild;

    if (runtime) {
      const terminal = { type: 'error', error: 'Codex provider disposed.' } as AcpEvent;
      for (const queue of runtime.queues.values()) queue.close(terminal);
      const sessionIds = [...new Set([
        ...[...runtime.sessions.values()].map((session) => session.sessionId),
        ...runtime.sessionRoots.keys()
      ])];
      runtime.queues.clear();
      runtime.sessions.clear();
      runtime.permissionHandlers.clear();
      runtime.readOnlySessions.clear();
      runtime.sessionRoots.clear();
      await Promise.allSettled(sessionIds.map((sessionId) => closeSession(runtime, sessionId)));
    }

    const children = [runtime, startingChild]
      .filter((child): child is Runtime | ChildHandle => child !== null)
      .filter((child, index, all) => all.findIndex((candidate) => candidate.proc === child.proc) === index);
    await Promise.all(children.map(terminateChild));
    this.activeRuntime = null;
    this.startingChild = null;
    this.runtimePromise = null;
  }
}
