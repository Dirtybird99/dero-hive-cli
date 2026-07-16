import assert from 'node:assert/strict';
import { buildJsonResult } from './chat.js';

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

console.log('chat.test.ts: buildJsonResult ok');
