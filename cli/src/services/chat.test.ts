import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message, StreamEvent, TokenUsage } from '../../../src/shared/types.js';

const dataDir = mkdtempSync(join(tmpdir(), 'dero-hive-chat-service-'));
const workspace = mkdtempSync(join(tmpdir(), 'dero-hive-chat-workspace-'));
const otherWorkspace = mkdtempSync(join(tmpdir(), 'dero-hive-chat-other-workspace-'));
process.env.HIVE_DATA_DIR = dataDir;
process.env.HIVE_KEYCHAIN_DISABLED = '1';
writeFileSync(join(workspace, 'evidence.txt'), 'tool-evidence');

const sse = (payload: unknown): string => `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
let requests = 0;
let orphanedToolTranscript = false;
const server = createServer((request, response) => {
  let body = '';
  request.setEncoding('utf8');
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => {
    requests += 1;
    const parsed = JSON.parse(body) as { messages?: Array<{
      role?: string;
      content?: string;
      tool_calls?: Array<{ id?: string }>;
      tool_call_id?: string;
    }> };
    const resultIds = new Set(parsed.messages?.filter((message) => message.role === 'tool').map((message) => message.tool_call_id) || []);
    orphanedToolTranscript ||= Boolean(parsed.messages?.some((message) =>
      message.role === 'assistant' && message.tool_calls?.some((call) => call.id && !resultIds.has(call.id))
    ));
    if (orphanedToolTranscript) {
      response.writeHead(422, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'assistant tool call is missing its tool result' } }));
      return;
    }
    const userText = [...(parsed.messages || [])].reverse().find((message) => message.role === 'user')?.content || '';
    const hasToolResult = parsed.messages?.some((message) => message.role === 'tool');
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (userText.includes('cancel')) {
      response.end([
        sse({ choices: [{ delta: { tool_calls: [
          { index: 0, id: 'call-cancel', function: { name: 'run_shell', arguments: JSON.stringify({ command: process.platform === 'win32' ? 'Start-Sleep -Seconds 10' : 'sleep 10' }) } },
          { index: 1, id: 'call-after-cancel', function: { name: 'write_file', arguments: JSON.stringify({ path: 'should-not-exist.txt', content: 'late side effect' }) } }
        ] } }] }),
        sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
        sse({ usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
        sse('[DONE]')
      ].join(''));
    } else if (hasToolResult) {
      response.end([
        sse({ choices: [{ delta: { content: 'final answer' } }] }),
        sse({ usage: { prompt_tokens: 7, completion_tokens: 11, total_tokens: 18 } }),
        sse('[DONE]')
      ].join(''));
    } else {
      response.end([
        sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-read', function: { name: 'read_file', arguments: '{"path":"evidence.txt"}' } }] } }] }),
        sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
        sse({ usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }),
        sse('[DONE]')
      ].join(''));
    }
  });
});

await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

const { initDb, closeDb, getDb, setSetting } = await import('../../../src/main/db/client.js');
const { shutdownAdapterCache } = await import('../../../src/main/providers/registry.js');
const { ToolRegistry } = await import('../../../src/main/tools/registry.js');
const conversationService = await import('./conversation.js');
const { runChat, shutdownChatTasks } = await import('./chat.js');

try {
  await initDb();
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  getDb().prepare(`
    INSERT INTO providers (id, preset_id, name, base_url, enabled, models, custom_headers, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, '{}', ?)
  `).run(
    'fake',
    'openai',
    'Fake provider',
    `http://127.0.0.1:${address.port}`,
    JSON.stringify([{ id: 'fake-model', name: 'Fake model', supportsTools: true, contextWindow: 32_000 }]),
    Date.now()
  );
  setSetting('appSettings', { autoTitle: false, toolApprovalMode: 'never' });
  const tools = new ToolRegistry(null);

  const conversation = conversationService.createConversation({ providerId: 'fake', model: 'fake-model', workspacePath: workspace });
  const user: Message = { id: 'user-1', role: 'user', content: 'read the evidence', createdAt: Date.now() };
  const usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const events: StreamEvent[] = [];
  const result = await runChat({
    conversationId: conversation.id,
    providerId: 'fake',
    model: 'fake-model',
    messages: [user]
  }, {
    tools,
    cwd: workspace,
    onEvent(event) {
      events.push(event);
      if (event.type === 'usage') {
        usage.promptTokens += event.usage.promptTokens;
        usage.completionTokens += event.usage.completionTokens;
        usage.totalTokens += event.usage.totalTokens;
      }
    }
  });
  const saved = conversationService.getMessages(conversation.id);
  const final = saved.at(-1);
  assert.equal(requests, 2);
  assert.equal(final?.role, 'assistant');
  assert.equal(final?.content, 'final answer');
  assert.equal(result.messageId, final?.id, 'runChat returns the final assistant turn, not the tool-call turn');
  assert.deepEqual(usage, { promptTokens: 9, completionTokens: 14, totalTokens: 23 });
  assert.ok(saved.some((message) => message.role === 'tool' && message.content === 'tool-evidence'));
  assert.equal(events.filter((event) => event.type === 'done').length, 1);

  const requestCountBeforeMismatch = requests;
  const mismatchEvents: StreamEvent[] = [];
  await runChat({
    conversationId: conversation.id,
    providerId: 'fake',
    model: 'fake-model',
    messages: [{ id: 'wrong-workspace', role: 'user', content: 'must not persist', createdAt: Date.now() }]
  }, { tools, cwd: otherWorkspace, onEvent: (event) => mismatchEvents.push(event) });
  assert.match(mismatchEvents.find((event) => event.type === 'error')?.error || '', /different workspace/u);
  assert.equal(requests, requestCountBeforeMismatch, 'workspace mismatch fails before provider I/O');
  assert.ok(!conversationService.getMessages(conversation.id).some((message) => message.id === 'wrong-workspace'));

  const cancellation = conversationService.createConversation({ providerId: 'fake', model: 'fake-model', workspacePath: workspace });
  const abort = new AbortController();
  let cancelledTool = '';
  const startedAt = Date.now();
  const cancelledResult = await runChat({
    conversationId: cancellation.id,
    providerId: 'fake',
    model: 'fake-model',
    messages: [{ id: 'user-2', role: 'user', content: 'cancel the slow tool', createdAt: Date.now() }]
  }, {
    tools,
    cwd: workspace,
    signal: abort.signal,
    onEvent() {},
    onToolStart() { setTimeout(() => abort.abort(), 50); },
    onToolResult(info) { cancelledTool = info.result.content; }
  });
  assert.match(cancelledTool, /cancelled/u);
  assert.ok(Date.now() - startedAt < 8_000, 'chat cancellation reaches the running tool promptly');
  assert.equal(existsSync(join(workspace, 'should-not-exist.txt')), false, 'cancellation skips later tool calls in the same batch');
  const cancelledSaved = conversationService.getMessages(cancellation.id);
  const cancelledAssistant = [...cancelledSaved].reverse()
    .find((message) => message.role === 'assistant');
  assert.equal(cancelledResult.messageId, cancelledAssistant?.id);
  const resultIds = new Set(cancelledSaved.filter((message) => message.role === 'tool').map((message) => message.toolCallId));
  assert.ok(cancelledAssistant?.toolCalls?.every((call) => resultIds.has(call.id)), 'cancelled tool batch remains protocol-complete');
  assert.match(cancelledSaved.find((message) => message.toolCallId === 'call-after-cancel')?.content as string, /not started/u);

  const resumeUser: Message = { id: 'user-3', role: 'user', content: 'resume after cancel', createdAt: Date.now() };
  const resumed = await runChat({
    conversationId: cancellation.id,
    providerId: 'fake',
    model: 'fake-model',
    messages: [...cancelledSaved, resumeUser]
  }, { tools, cwd: workspace, onEvent() {} });
  assert.equal(orphanedToolTranscript, false, 'resumed provider request has a result for every assistant tool call');
  assert.equal(conversationService.getMessages(cancellation.id).at(-1)?.id, resumed.messageId);
} finally {
  await shutdownChatTasks();
  await shutdownAdapterCache();
  closeDb();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.HIVE_KEYCHAIN_DISABLED;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
  rmSync(otherWorkspace, { recursive: true, force: true });
}

console.log('chat service integration tests passed');
