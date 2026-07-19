import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message } from '../../../src/shared/types.js';

const dataDir = mkdtempSync(join(tmpdir(), 'dero-hive-conversation-'));
process.env.HIVE_DATA_DIR = dataDir;
process.env.HIVE_CLI = '1';

const { initDb, closeDb, getDb, getSetting, setSetting } = await import('../../../src/main/db/client.js');
const conversations = await import('./conversation.js');
const projects = await import('./project.js');
const cliConfig = await import('../utils/config.js');
const { sameWorkspacePath } = await import('../../../src/shared/workspace.js');
const { storeAttachment } = await import('../../../src/main/utils/attachments.js');
type CreateOptions = Parameters<typeof conversations.createConversation>[0];
const createConversation = (options: Omit<CreateOptions, 'workspacePath'> & { workspacePath?: string } = {}) =>
  conversations.createConversation({ workspacePath: dataDir, ...options });

function runConcurrentWriter(conversationId: string, writer: number, count: number): Promise<void> {
  const dbClientUrl = new URL('../../../src/main/db/client.ts', import.meta.url).href;
  const conversationUrl = new URL('./conversation.ts', import.meta.url).href;
  const source = `
    const db = await import(${JSON.stringify(dbClientUrl)});
    const conversations = await import(${JSON.stringify(conversationUrl)});
    await db.initDb();
    for (let index = 0; index < ${count}; index++) {
      conversations.persistMessage(${JSON.stringify(conversationId)}, {
        id: ${JSON.stringify(`writer-${writer}-`)} + index,
        role: 'user', content: ${JSON.stringify(`writer ${writer} message `)} + index, createdAt: index
      });
    }
    db.closeDb();`;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], {
      cwd: process.cwd(),
      env: { ...process.env, HIVE_DATA_DIR: dataDir, HIVE_CLI: '1' },
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolvePromise();
      else reject(new Error(`concurrent writer ${writer} exited ${code}: ${stderr}`));
    });
  });
}

try {
  await initDb();
  mkdirSync(join(dataDir, 'attachments'), { recursive: true });
  const conversation = createConversation({ providerId: 'test', model: 'test-model' });
  assert.equal(sameWorkspacePath(conversation.workspacePath, dataDir), true);
  for (let index = 0; index < 12; index += 1) {
    const message: Message = {
      id: randomUUID(),
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: index % 2 === 0 ? `request ${index}: inspect src/file-${index}.ts` : `progress ${index}: read the requested file`,
      createdAt: Date.now() + index
    };
    conversations.persistMessage(conversation.id, message);
  }

  assert.equal(conversations.getMessages(conversation.id).length, 12);
  assert.ok(conversations.estimateContext(conversation.id).estimatedTokens > 0);
  assert.ok(conversations.searchConversations('request 2').some((result) => result.conversationId === conversation.id));

  const compacted = await conversations.compactConversation(conversation.id, 4);
  assert.equal(compacted.removedCount, 8);
  assert.ok(compacted.afterTokens > 0);
  assert.ok(compacted.tokensSaved >= 0);
  assert.equal(conversations.getMessages(conversation.id).length, 5);
  assert.equal(conversations.getConversation(conversation.id)?.compactionCount, 1);

  conversations.persistMessage(conversation.id, { id: randomUUID(), role: 'user', content: 'latest request', createdAt: Date.now() });
  conversations.persistMessage(conversation.id, { id: randomUUID(), role: 'assistant', content: 'latest answer', createdAt: Date.now() });
  assert.equal(await conversations.removeLastExchange(conversation.id), 2);
  assert.equal(conversations.getMessages(conversation.id).length, 5);

  await conversations.deleteConversation(conversation.id);
  const ftsCount = getDb().prepare('SELECT COUNT(*) AS count FROM messages_fts WHERE conversation_id = ?')
    .get(conversation.id) as { count: number };
  assert.equal(ftsCount.count, 0);

  const attachmentContent = (id: string, filename: string) => [{
    type: 'attachment_ref' as const,
    attachment: { id, type: 'file' as const, filename, mimeType: 'text/plain', size: 7 }
  }];
  const sharedAttachmentId = await storeAttachment(Buffer.from('shared'));
  const attachmentSource = createConversation({ title: 'Shared attachment source' });
  conversations.persistMessage(attachmentSource.id, {
    id: randomUUID(), role: 'user', content: attachmentContent(sharedAttachmentId, 'shared.txt'), createdAt: 1
  });
  const attachmentFork = conversations.forkConversation(attachmentSource.id);
  assert.ok(attachmentFork);
  await conversations.deleteConversation(attachmentSource.id);
  assert.equal(existsSync(join(dataDir, 'attachments', sharedAttachmentId)), true, 'a fork keeps its shared attachment');
  await conversations.deleteConversation(attachmentFork.id);
  assert.equal(existsSync(join(dataDir, 'attachments', sharedAttachmentId)), false, 'the final reference deletion reclaims the blob');

  const rewindAttachmentId = await storeAttachment(Buffer.from('rewind'));
  const attachmentRewind = createConversation({ title: 'Attachment rewind' });
  conversations.persistMessage(attachmentRewind.id, {
    id: randomUUID(), role: 'user', content: attachmentContent(rewindAttachmentId, 'rewind.txt'), createdAt: 1
  });
  conversations.persistMessage(attachmentRewind.id, { id: randomUUID(), role: 'assistant', content: 'ok', createdAt: 2 });
  assert.equal(await conversations.removeLastExchange(attachmentRewind.id), 2);
  assert.equal(existsSync(join(dataDir, 'attachments', rewindAttachmentId)), false, 'rewind reclaims removed attachments');

  const compactAttachmentId = await storeAttachment(Buffer.from('compact'));
  const attachmentCompact = createConversation({ title: 'Attachment compact' });
  conversations.persistMessage(attachmentCompact.id, {
    id: randomUUID(), role: 'user', content: attachmentContent(compactAttachmentId, 'compact.txt'), createdAt: 1
  });
  conversations.persistMessage(attachmentCompact.id, { id: randomUUID(), role: 'assistant', content: 'old answer', createdAt: 2 });
  conversations.persistMessage(attachmentCompact.id, { id: randomUUID(), role: 'user', content: 'recent question', createdAt: 3 });
  await conversations.compactConversation(attachmentCompact.id, 1);
  assert.equal(existsSync(join(dataDir, 'attachments', compactAttachmentId)), false, 'compaction reclaims attachments dropped from context');

  // Message, FTS, and conversation counters commit as one unit. A failure in
  // the last statement must roll the earlier inserts back.
  const atomicMessage = createConversation({ title: 'Atomic message' });
  const failedMessageId = randomUUID();
  getDb().exec(`CREATE TRIGGER fail_atomic_message_count
    BEFORE UPDATE OF message_count ON conversations WHEN NEW.id = '${atomicMessage.id}'
    BEGIN SELECT RAISE(ABORT, 'forced message counter failure'); END`);
  assert.throws(() => conversations.persistMessage(atomicMessage.id, {
    id: failedMessageId, role: 'user', content: 'must roll back', createdAt: 1
  }), /forced message counter failure/);
  getDb().exec('DROP TRIGGER fail_atomic_message_count');
  assert.equal((getDb().prepare('SELECT COUNT(*) AS count FROM messages WHERE id = ?').get(failedMessageId) as { count: number }).count, 0);
  assert.equal((getDb().prepare('SELECT COUNT(*) AS count FROM messages_fts WHERE message_id = ?').get(failedMessageId) as { count: number }).count, 0);
  assert.equal(conversations.getConversation(atomicMessage.id)?.messageCount, 0);

  // BEGIN IMMEDIATE serializes the MAX(sort_order)+1 allocation across real
  // CLI processes without a schema change or duplicate ordering values.
  const concurrent = createConversation({ title: 'Concurrent writers' });
  const writerCount = 4;
  const messagesPerWriter = 12;
  await Promise.all(Array.from({ length: writerCount }, (_, writer) =>
    runConcurrentWriter(concurrent.id, writer, messagesPerWriter)
  ));
  const concurrentRows = getDb().prepare(
    'SELECT sort_order FROM messages WHERE conversation_id = ? ORDER BY sort_order ASC'
  ).all(concurrent.id) as Array<{ sort_order: number }>;
  const expectedConcurrentMessages = writerCount * messagesPerWriter;
  assert.equal(concurrentRows.length, expectedConcurrentMessages);
  assert.equal(new Set(concurrentRows.map((row) => row.sort_order)).size, expectedConcurrentMessages);
  assert.deepEqual(concurrentRows.map((row) => row.sort_order), Array.from({ length: expectedConcurrentMessages }, (_, index) => index + 1));
  assert.equal(conversations.getConversation(concurrent.id)?.messageCount, expectedConcurrentMessages);
  assert.equal((getDb().prepare('SELECT COUNT(*) AS count FROM messages_fts WHERE conversation_id = ?')
    .get(concurrent.id) as { count: number }).count, expectedConcurrentMessages);

  // --- Creation defaults and lookup misses ---
  const defaults = createConversation({});
  assert.equal(defaults.title, 'New chat'); // missing title falls back
  assert.equal(defaults.providerId, '');
  assert.equal(defaults.model, '');
  assert.equal(defaults.messageCount, 0);
  assert.equal(createConversation({ title: '   ' }).title, 'New chat'); // whitespace-only title falls back
  const padded = createConversation({ title: '  Padded  ' });
  assert.equal(conversations.getConversation(padded.id)?.title, 'Padded'); // titles are trimmed before insert
  assert.equal(conversations.getConversation(randomUUID()), null); // unknown id maps to null
  await assert.doesNotReject(conversations.deleteConversation(randomUUID())); // deleting an unknown id is a no-op

  // --- Title/metadata updates ---
  const meta = createConversation({ title: 'Meta', systemPrompt: 'keep me' });
  conversations.updateConversationTitle(meta.id, 'Renamed');
  assert.equal(conversations.getConversation(meta.id)?.title, 'Renamed');

  // An empty update object returns before touching SQL: updated_at stays put.
  getDb().prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(12345, meta.id);
  conversations.updateConversation(meta.id, {});
  assert.equal(conversations.getConversation(meta.id)?.updatedAt, 12345);

  // Multi-field update: booleans map to 1/0 and updated_at is bumped.
  conversations.updateConversation(meta.id, { pinned: true, archived: true, model: 'new-model', providerId: 'new-provider' });
  const metaRow = conversations.getConversation(meta.id);
  assert.equal(metaRow?.pinned, true);
  assert.equal(metaRow?.archived, true);
  assert.equal(metaRow?.model, 'new-model');
  assert.equal(metaRow?.providerId, 'new-provider');
  assert.equal(metaRow?.systemPrompt, 'keep me'); // untouched columns survive
  assert.ok((metaRow?.updatedAt ?? 0) > 12345);
  conversations.updateConversation(meta.id, { pinned: false });
  assert.equal(conversations.getConversation(meta.id)?.pinned, false);
  // Explicit undefined clears a nullable column (value ?? null).
  conversations.updateConversation(meta.id, { systemPrompt: undefined });
  assert.equal(conversations.getConversation(meta.id)?.systemPrompt, undefined);

  // --- Token accounting and preview ---
  assert.equal(conversations.getConversation(meta.id)?.totalTokens, undefined); // stored 0 maps to undefined
  conversations.updateConversationTokens(meta.id, 100.9);
  assert.equal(conversations.getConversation(meta.id)?.totalTokens, 100); // fractional tokens are floored
  conversations.updateConversationTokens(meta.id, Number.NaN);
  conversations.updateConversationTokens(meta.id, Number.POSITIVE_INFINITY);
  conversations.updateConversationTokens(meta.id, 0);
  conversations.updateConversationTokens(meta.id, -5);
  assert.equal(conversations.getConversation(meta.id)?.totalTokens, 100); // non-finite/zero/negative inputs ignored
  conversations.updateConversationTokens(meta.id, 50);
  assert.equal(conversations.getConversation(meta.id)?.totalTokens, 150); // accumulates
  conversations.updateConversationPreview(meta.id, 'p'.repeat(300));
  assert.equal(conversations.getConversation(meta.id)?.preview, 'p'.repeat(200)); // preview capped at 200 chars

  // --- Message field round-trips (structured content, tool calls, usage) ---
  const rich = createConversation({});
  const structured: Message = {
    id: randomUUID(),
    role: 'user',
    content: [
      { type: 'text', text: 'look at this' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
    ],
    createdAt: 1111
  };
  conversations.persistMessage(rich.id, structured);
  const toolCallMsg: Message = {
    id: randomUUID(),
    role: 'assistant',
    content: 'calling a tool',
    reasoning: 'thinking hard',
    model: 'test-model-2',
    provider: 'test-provider',
    toolCalls: [{ id: 'tc-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }],
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    createdAt: 2222
  };
  conversations.persistMessage(rich.id, toolCallMsg);
  conversations.persistMessage(rich.id, {
    id: randomUUID(), role: 'tool', content: 'file contents', toolCallId: 'tc-1',
    name: 'read_file', error: 'boom', createdAt: 3333
  });
  const richMsgs = conversations.getMessages(rich.id);
  assert.equal(richMsgs.length, 3);
  assert.deepEqual(richMsgs[0].content, structured.content); // JSON array content parses back to parts
  assert.equal(richMsgs[0].createdAt, 1111);
  assert.deepEqual(richMsgs[1].toolCalls, toolCallMsg.toolCalls);
  assert.deepEqual(richMsgs[1].usage, toolCallMsg.usage);
  assert.equal(richMsgs[1].reasoning, 'thinking hard');
  assert.equal(richMsgs[1].model, 'test-model-2');
  assert.equal(richMsgs[1].provider, 'test-provider');
  assert.equal(richMsgs[2].toolCallId, 'tc-1');
  assert.equal(richMsgs[2].name, 'read_file');
  assert.equal(richMsgs[2].error, 'boom');
  assert.equal(conversations.getConversation(rich.id)?.messageCount, 3); // counter tracks each insert

  // --- Rewind (removeLastExchange) edges ---
  const rewind = createConversation({});
  assert.equal(await conversations.removeLastExchange(rewind.id), 0); // empty conversation: nothing to remove
  conversations.persistMessage(rewind.id, { id: randomUUID(), role: 'system', content: 'sys', createdAt: 1 });
  conversations.persistMessage(rewind.id, { id: randomUUID(), role: 'assistant', content: 'greeting', createdAt: 2 });
  assert.equal(await conversations.removeLastExchange(rewind.id), 0); // no user message: no-op
  assert.equal(conversations.getMessages(rewind.id).length, 2);
  conversations.persistMessage(rewind.id, { id: randomUUID(), role: 'user', content: 'first ask', createdAt: 3 });
  conversations.persistMessage(rewind.id, { id: randomUUID(), role: 'assistant', content: 'first answer', createdAt: 4 });
  conversations.persistMessage(rewind.id, { id: randomUUID(), role: 'user', content: 'second ask', createdAt: 5 });
  conversations.persistMessage(rewind.id, { id: randomUUID(), role: 'assistant', content: 'partial answer', createdAt: 6 });
  conversations.persistMessage(rewind.id, { id: randomUUID(), role: 'assistant', content: 'follow-up answer', createdAt: 7 });
  // Rewind removes from the LAST user message onward, including multiple trailing assistant replies.
  assert.equal(await conversations.removeLastExchange(rewind.id), 3);
  assert.deepEqual(conversations.getMessages(rewind.id).map((m) => m.content), ['sys', 'greeting', 'first ask', 'first answer']);
  assert.equal(conversations.getConversation(rewind.id)?.messageCount, 4); // recomputed via COUNT(*)
  const rewindFts = getDb().prepare('SELECT COUNT(*) AS count FROM messages_fts WHERE conversation_id = ?')
    .get(rewind.id) as { count: number };
  assert.equal(rewindFts.count, 4); // FTS rows for removed messages are purged

  // --- Search edges: empty queries, misses, prefixing, and FTS escaping ---
  const searchable = createConversation({});
  conversations.persistMessage(searchable.id, { id: randomUUID(), role: 'user', content: 'apples AND oranges make a fine salad', createdAt: 10 });
  conversations.persistMessage(searchable.id, { id: randomUUID(), role: 'assistant', content: 'alpha"beta gamma', createdAt: 11 });
  conversations.persistMessage(searchable.id, { id: randomUUID(), role: 'user', content: 'xylophonics rehearsal schedule', createdAt: 12 });
  assert.deepEqual(conversations.searchConversations(''), []); // empty query short-circuits
  assert.deepEqual(conversations.searchConversations('   '), []); // whitespace-only query short-circuits
  assert.deepEqual(conversations.searchConversations('zzyqxunmatchable'), []); // miss returns empty array
  const prefixHits = conversations.searchConversations('xylophon');
  assert.ok(prefixHits.some((r) => r.conversationId === searchable.id)); // trailing term matches as a prefix
  assert.ok(prefixHits.find((r) => r.conversationId === searchable.id)?.snippet.includes('<<')); // snippet highlighting markers
  assert.ok(conversations.searchConversations('alpha"beta').some((r) => r.conversationId === searchable.id)); // embedded quote is escaped, not a syntax error
  assert.ok(conversations.searchConversations('AND').some((r) => r.conversationId === searchable.id)); // operator keyword is quoted as a literal
  assert.ok(conversations.searchConversations('-oranges').some((r) => r.conversationId === searchable.id)); // leading '-' is not a NOT operator
  assert.ok(conversations.searchConversations('apples salad').some((r) => r.conversationId === searchable.id)); // multi-term AND semantics
  assert.equal(conversations.searchConversations('apples zebrasaurus').length, 0); // every term must match

  // --- Context estimation and compaction edges ---
  const emptyConv = createConversation({});
  assert.deepEqual(conversations.estimateContext(emptyConv.id), { messages: 0, characters: 0, estimatedTokens: 0 });
  // Compacting an empty conversation is a no-op and does not bump compaction_count.
  assert.deepEqual(await conversations.compactConversation(emptyConv.id, 4), { removedCount: 0, beforeTokens: 0, afterTokens: 0, tokensSaved: 0 });
  assert.equal(conversations.getConversation(emptyConv.id)?.compactionCount, undefined);
  // A conversation that already fits within keepRecentMessages is also a no-op.
  conversations.persistMessage(emptyConv.id, { id: randomUUID(), role: 'user', content: 'short question', createdAt: 20 });
  conversations.persistMessage(emptyConv.id, { id: randomUUID(), role: 'assistant', content: 'short answer', createdAt: 21 });
  const smallCompact = await conversations.compactConversation(emptyConv.id, 8);
  assert.equal(smallCompact.removedCount, 0);
  assert.equal(smallCompact.beforeTokens, smallCompact.afterTokens);
  assert.ok(smallCompact.beforeTokens > 0);
  assert.equal(conversations.getMessages(emptyConv.id).length, 2); // messages untouched
  assert.equal(conversations.getConversation(emptyConv.id)?.compactionCount, undefined);

  // Destructive compaction is atomic: if its final metadata update fails, the
  // original messages and FTS rows survive instead of leaving a partial rewrite.
  const atomicCompact = createConversation({ title: 'Atomic compact' });
  for (let index = 0; index < 4; index++) {
    conversations.persistMessage(atomicCompact.id, {
      id: randomUUID(), role: index % 2 ? 'assistant' : 'user', content: `atomic compact ${index}`, createdAt: index
    });
  }
  const beforeAtomicCompact = conversations.getMessages(atomicCompact.id);
  getDb().exec(`CREATE TRIGGER fail_atomic_compaction
    BEFORE UPDATE OF compaction_count ON conversations WHEN NEW.id = '${atomicCompact.id}'
    BEGIN SELECT RAISE(ABORT, 'forced compaction failure'); END`);
  await assert.rejects(conversations.compactConversation(atomicCompact.id, 1), /forced compaction failure/);
  getDb().exec('DROP TRIGGER fail_atomic_compaction');
  assert.deepEqual(conversations.getMessages(atomicCompact.id), beforeAtomicCompact);
  assert.equal(conversations.getConversation(atomicCompact.id)?.messageCount, 4);
  assert.equal(conversations.getConversation(atomicCompact.id)?.compactionCount, undefined);
  assert.equal((getDb().prepare('SELECT COUNT(*) AS count FROM messages_fts WHERE conversation_id = ?')
    .get(atomicCompact.id) as { count: number }).count, 4);

  // Full compaction: system prompt preserved, summary sections built, telemetry recorded.
  const compactable = createConversation({});
  const filler = ' the quick brown fox jumps over the lazy dog'.repeat(24);
  conversations.persistMessage(compactable.id, { id: randomUUID(), role: 'system', content: 'You are a careful engineer.', createdAt: 30 });
  conversations.persistMessage(compactable.id, { id: randomUUID(), role: 'user', content: `refactor the retry logic${filler}`, createdAt: 31 });
  conversations.persistMessage(compactable.id, { id: randomUUID(), role: 'assistant', content: `added exponential backoff${filler}`, createdAt: 32 });
  conversations.persistMessage(compactable.id, { id: randomUUID(), role: 'tool', content: 'Error: failed to open C:/repo/src/db/client.ts while reading', createdAt: 33 });
  conversations.persistMessage(compactable.id, { id: randomUUID(), role: 'user', content: `next step please${filler}`, createdAt: 34 });
  conversations.persistMessage(compactable.id, { id: randomUUID(), role: 'assistant', content: `applied the migration${filler}`, createdAt: 35 });
  conversations.persistMessage(compactable.id, { id: randomUUID(), role: 'user', content: `check the tests${filler}`, createdAt: 36 });
  conversations.persistMessage(compactable.id, { id: randomUUID(), role: 'assistant', content: `tests are green${filler}`, createdAt: 37 });
  conversations.persistMessage(compactable.id, { id: randomUUID(), role: 'assistant', content: `noting a follow-up${filler}`, createdAt: 38 });
  conversations.persistMessage(compactable.id, { id: randomUUID(), role: 'user', content: 'final question', createdAt: 39 });
  conversations.persistMessage(compactable.id, { id: randomUUID(), role: 'assistant', content: 'final answer', createdAt: 40 });
  const fullCompact = await conversations.compactConversation(compactable.id, 2, 'Focus on the database work');
  assert.equal(fullCompact.removedCount, 8); // 10 normal messages, keep 2
  assert.ok(fullCompact.tokensSaved > 0);
  const compactedMsgs = conversations.getMessages(compactable.id);
  assert.equal(compactedMsgs.length, 4); // preserved system + summary + 2 recent
  assert.equal(compactedMsgs[0].role, 'system');
  assert.equal(compactedMsgs[0].content, 'You are a careful engineer.'); // plain system prompt survives compaction
  assert.equal(compactedMsgs[0].name, undefined);
  assert.equal(compactedMsgs[1].role, 'system');
  assert.equal(compactedMsgs[1].name, 'context_compaction');
  const summaryText = String(compactedMsgs[1].content);
  assert.ok(summaryText.includes('<context_compaction>'));
  assert.ok(summaryText.includes('Compacted 8 older messages.'));
  assert.ok(summaryText.includes('## User guidance for this compaction'));
  assert.ok(summaryText.includes('Focus on the database work'));
  assert.ok(summaryText.includes('## User requests'));
  assert.ok(summaryText.includes('## Progress and decisions'));
  assert.ok(summaryText.includes('## Files referenced'));
  assert.ok(summaryText.includes('C:/repo/src/db/client.ts')); // file path harvested from tool output
  assert.ok(summaryText.includes('## Errors observed'));
  assert.equal(compactedMsgs[2].content, 'final question');
  assert.equal(compactedMsgs[3].content, 'final answer');
  const compactedConv = conversations.getConversation(compactable.id);
  assert.equal(compactedConv?.messageCount, 4);
  assert.equal(compactedConv?.compactionCount, 1);
  assert.ok((compactedConv?.lastCompactionAt ?? 0) > 0);
  assert.equal(compactedConv?.tokensSavedByCompaction, fullCompact.tokensSaved);

  // Re-compaction folds the previous summary into '## Previous compacted context'.
  conversations.persistMessage(compactable.id, { id: randomUUID(), role: 'user', content: 'newer question', createdAt: 41 });
  conversations.persistMessage(compactable.id, { id: randomUUID(), role: 'assistant', content: 'newer answer', createdAt: 42 });
  const secondCompact = await conversations.compactConversation(compactable.id, 1);
  assert.equal(secondCompact.removedCount, 4); // prior summary + 3 messages fold away
  const recompacted = conversations.getMessages(compactable.id);
  assert.equal(recompacted.length, 3); // system + new summary + 1 recent
  assert.ok(String(recompacted[1].content).includes('## Previous compacted context'));
  assert.equal(conversations.getConversation(compactable.id)?.compactionCount, 2);

  // --- Fork: null miss, lineage, and deep copy with fresh ids ---
  assert.equal(conversations.forkConversation(randomUUID()), null);
  const forkSource = createConversation({ title: 'Fork me', providerId: 'p', model: 'm', systemPrompt: 'sys' });
  conversations.persistMessage(forkSource.id, { id: randomUUID(), role: 'user', content: 'seedling question', createdAt: 50 });
  conversations.persistMessage(forkSource.id, { id: randomUUID(), role: 'assistant', content: 'seedling answer', createdAt: 51 });
  conversations.persistMessage(forkSource.id, { id: randomUUID(), role: 'user', content: 'seedling follow-up', createdAt: 52 });
  getDb().exec(`CREATE TRIGGER fail_atomic_fork BEFORE INSERT ON messages
    WHEN EXISTS (SELECT 1 FROM conversations WHERE id = NEW.conversation_id AND parent_id = '${forkSource.id}')
    BEGIN SELECT RAISE(ABORT, 'forced fork failure'); END`);
  assert.throws(() => conversations.forkConversation(forkSource.id), /forced fork failure/);
  getDb().exec('DROP TRIGGER fail_atomic_fork');
  assert.equal((getDb().prepare('SELECT COUNT(*) AS count FROM conversations WHERE parent_id = ?')
    .get(forkSource.id) as { count: number }).count, 0); // failed copy rolls its new conversation back
  const fork = conversations.forkConversation(forkSource.id);
  assert.notEqual(fork?.id, forkSource.id);
  assert.equal(fork?.title, 'Fork me (fork)');
  assert.equal(fork?.parentId, forkSource.id);
  assert.equal(fork?.systemPrompt, 'sys');
  assert.equal(fork?.workspacePath, forkSource.workspacePath, 'fork retains the canonical workspace scope');
  const forkMsgs = fork ? conversations.getMessages(fork.id) : [];
  const sourceMsgs = conversations.getMessages(forkSource.id);
  assert.deepEqual(forkMsgs.map((m) => [m.role, m.content]), sourceMsgs.map((m) => [m.role, m.content]));
  const sourceIds = new Set(sourceMsgs.map((m) => m.id));
  assert.ok(forkMsgs.length === 3 && forkMsgs.every((m) => !sourceIds.has(m.id))); // copies get fresh ids
  assert.equal(fork ? conversations.getConversation(fork.id)?.messageCount : -1, 3);
  assert.ok(conversations.searchConversations('seedling').some((r) => r.conversationId === fork?.id)); // fork content is FTS-indexed

  // --- Projects: creation, lookup, updates, corrupt config, ordering, scoped conversations ---
  const projDirA = join(dataDir, 'proj-a');
  const projDirB = join(dataDir, 'proj-b');
  mkdirSync(projDirA);
  mkdirSync(projDirB);
  const projA = projects.createProject({ name: 'Alpha', path: projDirA });
  const projB = projects.createProject({ name: 'Beta', path: projDirB, icon: '🚀', color: '#ff0000', config: { kind: 'dero' } });
  assert.equal(projA.icon, '📁'); // default icon branch
  assert.equal(projects.getProject(randomUUID()), null); // unknown project id maps to null
  assert.equal(projects.getProjectByPath(projA.path)?.id, projA.id);
  assert.equal(projects.getProjectByPath(join(dataDir, 'nowhere')), null);
  assert.throws(() => projects.createProject({ name: 'ghost', path: join(dataDir, 'missing-dir') })); // nonexistent path rejected
  assert.deepEqual(projects.getProject(projB.id)?.config, { kind: 'dero' }); // config JSON round-trips
  assert.equal(projects.updateProject(randomUUID(), { name: 'nope' }), null); // updating a missing project returns null
  const updatedB = projects.updateProject(projB.id, { name: 'Beta 2', config: { kind: 'general' } });
  assert.equal(updatedB?.name, 'Beta 2');
  assert.deepEqual(projects.getProject(projB.id)?.config, { kind: 'general' });
  // Corrupted config JSON in the row maps to undefined instead of throwing.
  getDb().prepare('UPDATE projects SET config = ? WHERE id = ?').run('{not json', projB.id);
  assert.equal(projects.getProject(projB.id)?.config, undefined);
  // listProjects orders by updated_at DESC.
  getDb().prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(1000, projA.id);
  getDb().prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(2000, projB.id);
  assert.deepEqual(projects.listProjects().map((p) => p.id), [projB.id, projA.id]);
  // Conversations scoped to a project: filter branch plus updated_at DESC ordering.
  const convInProj1 = createConversation({ projectId: projA.id, workspacePath: projA.path });
  const convInProj2 = createConversation({ projectId: projA.id, workspacePath: projA.path });
  const convNoProj = createConversation({ workspacePath: projDirB });
  getDb().prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(1000, convInProj1.id);
  getDb().prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(2000, convInProj2.id);
  assert.deepEqual(conversations.listConversations(projA.id).map((c) => c.id), [convInProj2.id, convInProj1.id]);
  assert.ok(conversations.listConversations(projA.id).every((c) => c.projectId === projA.id));
  assert.deepEqual(conversations.listConversationsForWorkspace(projA.path).map((c) => c.id), [convInProj2.id, convInProj1.id]);
  assert.ok(!conversations.listConversations(projA.id).some((c) => c.id === convNoProj.id)); // filter excludes unscoped
  assert.ok(conversations.listConversations().some((c) => c.id === convNoProj.id)); // unfiltered branch lists everything
  getDb().prepare(`INSERT INTO media_artifacts
    (id, project_id, kind, provider_id, model, prompt, relative_path, mime_type, bytes, created_at)
    VALUES ('project-media', ?, 'image', 'fixture', 'fixture', 'fixture', 'fixture.png', 'image/png', 1, ?)`
  ).run(projA.id, Date.now());
  assert.throws(() => projects.deleteProject(projA.id), /media artifacts or swarm runs/u, 'project removal cannot orphan project-relative media');
  assert.equal(projects.getProject(projA.id)?.id, projA.id);
  assert.equal(conversations.getConversation(convInProj1.id)?.projectId, projA.id, 'failed removal rolls back conversation metadata');
  getDb().prepare("DELETE FROM media_artifacts WHERE id = 'project-media'").run();
  projects.deleteProject(projA.id);
  assert.equal(projects.getProject(projA.id), null, 'projects with conversations can be removed');
  assert.equal(conversations.getConversation(convInProj1.id)?.projectId, undefined, 'project removal retains scoped history without a dangling FK');
  assert.equal(sameWorkspacePath(conversations.getConversation(convInProj1.id)?.workspacePath, projDirA), true);
  projects.deleteProject(projB.id);
  assert.equal(projects.getProject(projB.id), null);

  // --- Settings and CLI state (memory) persistence ---
  assert.equal(getSetting('missing-key'), undefined);
  assert.equal(getSetting('missing-key', 'fallback'), 'fallback'); // fallback branch on missing row
  setSetting('sample-key', { nested: { value: 1 }, list: [1, 2, 3] });
  assert.deepEqual(getSetting('sample-key'), { nested: { value: 1 }, list: [1, 2, 3] }); // JSON round-trip
  setSetting('sample-key', 'replaced');
  assert.equal(getSetting('sample-key'), 'replaced'); // upsert overwrites in place
  assert.deepEqual(cliConfig.loadState(), {}); // empty state defaults to {}
  cliConfig.saveState({ memory: ['prefers tabs', 'project uses pnpm'], memoryEnabled: true, theme: 'dark' });
  const state = cliConfig.loadState();
  assert.deepEqual(state.memory, ['prefers tabs', 'project uses pnpm']); // memory entries persist across loads
  assert.equal(state.memoryEnabled, true);
  assert.equal(state.theme, 'dark');
  assert.deepEqual(cliConfig.getDefaultProvider(), { providerId: undefined, modelId: undefined });
  cliConfig.setDefaultProvider('prov-1', 'model-1');
  assert.deepEqual(cliConfig.getDefaultProvider(), { providerId: 'prov-1', modelId: 'model-1' });

  // --- Direct setting passthrough (getSettingDirect/setSettingDirect) ---
  assert.equal(cliConfig.getSettingDirect('direct-missing'), undefined); // missing key, no fallback
  assert.equal(cliConfig.getSettingDirect('direct-missing', 'fb'), 'fb'); // fallback only on undefined
  cliConfig.setSettingDirect('direct-key', { a: 1 });
  assert.deepEqual(cliConfig.getSettingDirect('direct-key'), { a: 1 }); // JSON round-trip
  assert.deepEqual(getSetting('direct-key'), { a: 1 }); // shares the same settings table as db client
  cliConfig.setSettingDirect('direct-null', null);
  assert.equal(cliConfig.getSettingDirect('direct-null', 'fb'), null); // stored null is NOT undefined, so fallback is bypassed
} finally {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
}
