import assert from 'node:assert/strict';
import { formatConversationMessageContent, formatConversationSearchResult } from './conversation.js';
import { formatMcpStatusLine, formatMcpToolLine } from './mcp.js';

const attack = 'before\u001b]52;c;clipboard-secret\u0007after\u001b[2J';
const assertSafe = (value: string): void => {
  assert.match(value, /beforeafter/u);
  assert.doesNotMatch(value, /clipboard-secret/u);
  assert.equal(value.includes('\u001b]52'), false);
  assert.equal(value.includes('\u001b[2J'), false);
  assert.equal(value.includes('\u0007'), false);
};

assertSafe(formatConversationMessageContent(attack));
assertSafe(formatConversationSearchResult({
  conversationId: 'conversation', messageId: 'message', role: 'assistant', snippet: attack
}));
assertSafe(formatMcpStatusLine({ name: attack, connected: false, error: attack, tools: [] }));
assertSafe(formatMcpToolLine({ source: `mcp:${attack}`, name: attack, description: attack }));

console.log('command terminal-output sanitization tests passed');
