import assert from 'node:assert/strict';
import type { Message } from '@shared/types';
import { acpMessageContextKey, continuesAcpContext } from './codex-acp';

const message = (id: string, content: string): Message => ({ id, role: 'user', content, createdAt: 1 });
const first = message('first', 'original request');
const priorKeys = [acpMessageContextKey(first)];

assert.equal(continuesAcpContext('system', priorKeys, 'system', [first, message('next', 'continue')]), true);
assert.equal(continuesAcpContext('system', priorKeys, 'changed system', [first]), false);
assert.equal(continuesAcpContext('system', priorKeys, 'system', [message('first', 'edited request')]), false);
assert.equal(continuesAcpContext('system', priorKeys, 'system', [message('summary', '<context_compaction>')]), false);
assert.equal(continuesAcpContext('system', priorKeys, 'system', []), false);

console.log('codex ACP context tests passed');
