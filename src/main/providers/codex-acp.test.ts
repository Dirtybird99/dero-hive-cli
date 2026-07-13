import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { Message } from '@shared/types';
import type { ProviderConfig } from '@shared/types';
import { acpMessageContextKey, CodexAcpAdapter, continuesAcpContext } from './codex-acp';

const message = (id: string, content: string): Message => ({ id, role: 'user', content, createdAt: 1 });
const first = message('first', 'original request');
const priorKeys = [acpMessageContextKey(first)];

assert.equal(continuesAcpContext('system', priorKeys, 'system', [first, message('next', 'continue')]), true);
assert.equal(continuesAcpContext('system', priorKeys, 'changed system', [first]), false);
assert.equal(continuesAcpContext('system', priorKeys, 'system', [message('first', 'edited request')]), false);
assert.equal(continuesAcpContext('system', priorKeys, 'system', [message('summary', '<context_compaction>')]), false);
assert.equal(continuesAcpContext('system', priorKeys, 'system', []), false);

const fakeCommand = fileURLToPath(new URL('./fake-codex-acp.fixture.js', import.meta.url));
const config: ProviderConfig = {
  id: 'codex-fake', presetId: 'codex', name: 'Codex fake', baseUrl: '', enabled: true,
  models: [{ id: 'fake-model', name: 'Fake model' }], customHeaders: { commandPath: fakeCommand }
};
const adapter = new CodexAcpAdapter(config);
try {
  const controller = new AbortController();
  const first = adapter.stream({
    conversationId: 'first', cwd: process.cwd(), model: 'fake-model', messages: [message('cancel', 'cancel me')], signal: controller.signal
  });
  assert.equal((await first.next()).value?.content, 'first-start');
  controller.abort();
  assert.equal((await first.next()).value?.error, 'Request cancelled.');
  assert.equal((await first.next()).done, true);

  const secondContent: string[] = [];
  for await (const event of adapter.stream({
    conversationId: 'first', cwd: process.cwd(), model: 'fake-model', messages: [message('next', 'next turn')]
  })) {
    if (event.content) secondContent.push(event.content);
  }
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(secondContent, ['second-only'], 'late events from a cancelled session must not reach the next turn');
} finally {
  await adapter.dispose();
}

console.log('codex ACP context tests passed');
