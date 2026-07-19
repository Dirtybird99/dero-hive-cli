import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachClassicFile, buildJsonResult, consumeClassicCancelInput, formatClassicSearchResult, parseClassicDeleteRequest, switchClassicWorkspace } from './chat.js';

// Success result: no `error` key, ok=true, structure preserved.
const ok = buildJsonResult({
  ok: true,
  conversationId: 'conv-1',
  messageId: 'msg-1',
  content: 'hello world',
  toolCalls: [
    { name: 'web_fetch', args: { url: 'https://example.com' }, result: 'Body', isError: false, durationMs: 12 }
  ],
  usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }
});
assert.equal(ok.ok, true);
assert.equal(ok.conversationId, 'conv-1');
assert.equal(ok.messageId, 'msg-1');
assert.equal(ok.content, 'hello world');
assert.equal(ok.toolCalls.length, 1);
assert.equal(ok.toolCalls[0].name, 'web_fetch');
assert.equal(ok.toolCalls[0].isError, false);
assert.equal(ok.usage.totalTokens, 15);
assert.equal('error' in ok, false, 'success result must not carry an error field');
// The object must round-trip through JSON.stringify unchanged (it is what --json emits).
assert.deepEqual(JSON.parse(JSON.stringify(ok)), ok);

// Failure result: ok=false and a concrete error message present.
const failed = buildJsonResult({
  ok: false,
  conversationId: '',
  messageId: '',
  content: '',
  toolCalls: [],
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  error: 'No providers configured.'
});
assert.equal(failed.ok, false);
assert.equal(failed.error, 'No providers configured.');
assert.deepEqual(failed.toolCalls, []);

// A /stop token is consumed when it cancels one turn. Ordinary stdin arriving
// while the next turn is active must not match stale bytes from that old token.
const firstTurn = new AbortController();
const stop = consumeClassicCancelInput('', '/stop\n', true);
if (stop.cancel) firstTurn.abort();
assert.equal(firstTurn.signal.aborted, true);
assert.equal(stop.tail, '');

const secondTurn = new AbortController();
const ordinary = consumeClassicCancelInput(stop.tail, 'ordinary input during turn two\n', true);
if (ordinary.cancel) secondTurn.abort();
assert.equal(secondTurn.signal.aborted, false, 'a prior /stop must not cancel a later response');
assert.equal(consumeClassicCancelInput('/sto', 'p\r\n', true).cancel, true, 'split /stop input still cancels');

// /search output is a terminal sink: OSC clipboard payloads and BEL must not
// survive even when the matching message came from provider-generated content.
const searchLine = formatClassicSearchResult('12345678-conversation', 'before\u001b]52;c;clipboard-secret\u0007after');
assert.match(searchLine, /beforeafter/u);
assert.equal(searchLine.includes('\u001b]52'), false);
assert.equal(searchLine.includes('\u0007'), false);
assert.equal(searchLine.includes('clipboard-secret'), false);

assert.deepEqual(parseClassicDeleteRequest('', 'current-id'), { targetId: 'current-id', confirmed: false });
assert.deepEqual(parseClassicDeleteRequest('target-id', 'current-id'), { targetId: 'target-id', confirmed: false });
assert.deepEqual(parseClassicDeleteRequest('target-id CONFIRM', 'current-id'), { targetId: 'target-id', confirmed: true });
assert.equal(parseClassicDeleteRequest('one two confirm', 'current-id').error, 'Usage: /delete [id] confirm');

const classicData = mkdtempSync(join(tmpdir(), 'dero-hive-classic-scope-'));
const workspaceA = mkdtempSync(join(tmpdir(), 'dero-hive-classic-a-'));
const workspaceB = mkdtempSync(join(tmpdir(), 'dero-hive-classic-b-'));
process.env.HIVE_DATA_DIR = classicData;
const db = await import('../../../src/main/db/client.js');
const conversations = await import('../services/conversation.js');
const projects = await import('../services/project.js');
const { sameWorkspacePath } = await import('../../../src/shared/workspace.js');
try {
  await db.initDb();
  mkdirSync(join(classicData, 'attachments'), { recursive: true });
  const projectA = projects.createProject({ name: 'A', path: workspaceA });
  const original = conversations.createConversation({
    providerId: 'p', model: 'm', projectId: projectA.id, workspacePath: workspaceA
  });
  const state = {
    currentConversationId: original.id,
    currentProjectId: projectA.id,
    currentProjectPath: workspaceA,
    currentProviderId: 'p',
    currentModelId: 'm'
  };
  const insideFile = join(workspaceA, 'inside.txt');
  writeFileSync(insideFile, 'bounded attachment');
  await attachClassicFile(original.id, 'inside.txt', workspaceA);
  const attachmentMessage = conversations.getMessages(original.id).at(-1);
  assert.ok(Array.isArray(attachmentMessage?.content));
  const attachment = Array.isArray(attachmentMessage?.content)
    ? attachmentMessage.content.find((part) => part.type === 'attachment_ref')
    : undefined;
  assert.ok(attachment?.type === 'attachment_ref');
  assert.equal(existsSync(join(classicData, 'attachments', attachment.attachment.id)), true);

  const outsideFile = join(workspaceB, 'outside.txt');
  writeFileSync(outsideFile, 'outside');
  await assert.rejects(attachClassicFile(original.id, outsideFile, workspaceA), /outside allowed workspace/u);
  const oversized = join(workspaceA, 'oversized.bin');
  writeFileSync(oversized, '');
  truncateSync(oversized, 20 * 1024 * 1024 + 1);
  await assert.rejects(attachClassicFile(original.id, oversized, workspaceA), /size limit/u);

  const switched = await switchClassicWorkspace(state, original.id, 'p', 'm', workspaceB);
  assert.notEqual(switched.id, original.id);
  assert.equal(switched.projectId, undefined, 'switching to an unregistered directory clears project id');
  assert.equal(sameWorkspacePath(switched.workspacePath, workspaceB), true);
  assert.equal(state.currentConversationId, switched.id);
  const nestedWorkspace = join(workspaceB, 'nested');
  mkdirSync(nestedWorkspace);
  const nested = await switchClassicWorkspace(state, switched.id, 'p', 'm', 'nested');
  assert.equal(sameWorkspacePath(nested.workspacePath, nestedWorkspace), true, 'relative switches resolve from the active workspace');
  const restarted = await switchClassicWorkspace(state, nested.id, 'p', 'm', workspaceA);
  assert.equal(restarted.projectId, projectA.id, 'switching back derives the registered project id');
  assert.equal(sameWorkspacePath(restarted.workspacePath, workspaceA), true);
} finally {
  db.closeDb();
  rmSync(classicData, { recursive: true, force: true });
  rmSync(workspaceA, { recursive: true, force: true });
  rmSync(workspaceB, { recursive: true, force: true });
}

console.log('chat.test.ts: regressions ok');
