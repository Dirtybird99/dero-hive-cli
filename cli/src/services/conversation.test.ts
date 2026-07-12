import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message } from '../../../src/shared/types.js';

const dataDir = mkdtempSync(join(tmpdir(), 'dero-hive-conversation-'));
process.env.HIVE_DATA_DIR = dataDir;
process.env.HIVE_CLI = '1';

const { initDb, closeDb, getDb } = await import('../../../src/main/db/client.js');
const conversations = await import('./conversation.js');

try {
  await initDb();
  const conversation = conversations.createConversation({ providerId: 'test', model: 'test-model' });
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

  const compacted = conversations.compactConversation(conversation.id, 4);
  assert.equal(compacted.removedCount, 8);
  assert.ok(compacted.afterTokens > 0);
  assert.ok(compacted.tokensSaved >= 0);
  assert.equal(conversations.getMessages(conversation.id).length, 5);
  assert.equal(conversations.getConversation(conversation.id)?.compactionCount, 1);

  conversations.persistMessage(conversation.id, { id: randomUUID(), role: 'user', content: 'latest request', createdAt: Date.now() });
  conversations.persistMessage(conversation.id, { id: randomUUID(), role: 'assistant', content: 'latest answer', createdAt: Date.now() });
  assert.equal(conversations.removeLastExchange(conversation.id), 2);
  assert.equal(conversations.getMessages(conversation.id).length, 5);

  conversations.deleteConversation(conversation.id);
  const ftsCount = getDb().prepare('SELECT COUNT(*) AS count FROM messages_fts WHERE conversation_id = ?')
    .get(conversation.id) as { count: number };
  assert.equal(ftsCount.count, 0);
} finally {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
}
