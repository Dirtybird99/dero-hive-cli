import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'dero-hive-permissions-'));
const projectA = join(dataDir, 'project-a');
const projectB = join(dataDir, 'project-b');
mkdirSync(projectA);
mkdirSync(projectB);
process.env.HIVE_DATA_DIR = dataDir;
process.env.HIVE_CLI = '1';

const { initDb, closeDb } = await import('../../../src/main/db/client.js');
const { ToolRegistry } = await import('../../../src/main/tools/registry.js');

try {
  await initDb();
  const tools = new ToolRegistry(null);
  tools.saveRule({ id: randomUUID(), toolName: 'write_file', action: 'allow', scope: 'global' });
  tools.saveRule({ id: randomUUID(), toolName: 'write_file', action: 'deny', scope: 'project', projectPath: projectA });
  tools.saveRule({ id: randomUUID(), toolName: 'read_file', action: 'allow', scope: 'project', projectPath: projectA });

  assert.equal(tools.matchRule('write_file', {}, { cwd: projectA, conversationId: 'a' })?.action, 'deny');
  assert.equal(tools.matchRule('write_file', {}, { cwd: projectB, conversationId: 'b' })?.action, 'allow');
  assert.equal(tools.matchRule('read_file', {}, { cwd: projectA, conversationId: 'a' })?.action, 'allow');
  assert.equal(tools.matchRule('read_file', {}, { cwd: projectB, conversationId: 'b' }), null);
  assert.equal(tools.matchRule('read_file', {}), null);

  // 'ask' action: an explicit ask beats a broad allow (matchRule returns askRule || allowRule).
  tools.saveRule({ id: randomUUID(), toolName: 'edit_file', action: 'allow', scope: 'global' });
  tools.saveRule({ id: randomUUID(), toolName: 'edit_file', action: 'ask', scope: 'global' });
  assert.equal(tools.matchRule('edit_file', {}, { cwd: projectA, conversationId: 'a' })?.action, 'ask');

  // deny is absolute: it wins even over a matching 'ask' rule (early return on deny).
  tools.saveRule({ id: randomUUID(), toolName: 'deploy_tool', action: 'ask', scope: 'global' });
  tools.saveRule({ id: randomUUID(), toolName: 'deploy_tool', action: 'deny', scope: 'global' });
  assert.equal(tools.matchRule('deploy_tool', {})?.action, 'deny');

  // Precedence tie between two overlapping same-scope rules: deny beats allow.
  tools.saveRule({ id: randomUUID(), toolName: 'send_tx', action: 'allow', scope: 'global' });
  tools.saveRule({ id: randomUUID(), toolName: 'send_tx', action: 'deny', scope: 'global' });
  assert.equal(tools.matchRule('send_tx', {})?.action, 'deny');

  // Wildcard toolName '*' matches any tool; deleteRule then removes it (probe tool has no other rule).
  const wildcardId = randomUUID();
  tools.saveRule({ id: wildcardId, toolName: '*', action: 'allow', scope: 'global' });
  assert.equal(tools.matchRule('any_unregistered_tool', {}, { cwd: projectA, conversationId: 'a' })?.action, 'allow');
  tools.deleteRule(wildcardId);
  assert.equal(tools.matchRule('any_unregistered_tool', {}, { cwd: projectA, conversationId: 'a' }), null);

  // Substring pattern: rule applies only when JSON.stringify(args) contains the pattern.
  tools.saveRule({ id: randomUUID(), toolName: 'shell', pattern: 'rm -rf', action: 'deny', scope: 'global' });
  assert.equal(tools.matchRule('shell', { command: 'rm -rf /tmp' })?.action, 'deny');
  assert.equal(tools.matchRule('shell', { command: 'ls -la' }), null);

  // Regex pattern (/.../): compiled and tested against the JSON-stringified args.
  tools.saveRule({ id: randomUUID(), toolName: 'git', pattern: '/push|force/', action: 'deny', scope: 'global' });
  assert.equal(tools.matchRule('git', { cmd: 'git push origin main' })?.action, 'deny');
  assert.equal(tools.matchRule('git', { cmd: 'git status' }), null);

  // saveRule ON CONFLICT(id): re-saving the same id updates in place (no duplicate row).
  const updateId = randomUUID();
  tools.saveRule({ id: updateId, toolName: 'sign_tx', action: 'allow', scope: 'global' });
  assert.equal(tools.matchRule('sign_tx', {})?.action, 'allow');
  tools.saveRule({ id: updateId, toolName: 'sign_tx', action: 'deny', scope: 'global' });
  assert.equal(tools.matchRule('sign_tx', {})?.action, 'deny');
  assert.equal(tools.listRules().filter((r) => r.id === updateId).length, 1);

  // deleteRule removes a rule so it no longer matches (fallthrough to null).
  const deleteId = randomUUID();
  tools.saveRule({ id: deleteId, toolName: 'temp_tool', action: 'deny', scope: 'global' });
  assert.equal(tools.matchRule('temp_tool', {})?.action, 'deny');
  tools.deleteRule(deleteId);
  assert.equal(tools.matchRule('temp_tool', {}), null);

  // listRules exposes stored rule fields (id, toolName, action, pattern).
  const shellRule = tools.listRules().find((r) => r.toolName === 'shell');
  assert.ok(shellRule);
  assert.equal(shellRule?.action, 'deny');
  assert.equal(shellRule?.pattern, 'rm -rf');

  // Project-scope path normalization: a trailing separator on projectPath still matches cwd.
  tools.saveRule({ id: randomUUID(), toolName: 'norm_tool', action: 'allow', scope: 'project', projectPath: projectA + '/' });
  assert.equal(tools.matchRule('norm_tool', {}, { cwd: projectA, conversationId: 'a' })?.action, 'allow');
  assert.equal(tools.matchRule('norm_tool', {}, { cwd: projectB, conversationId: 'b' }), null);

  // A prompt resolved immediately must clear its two-minute fallback timer so
  // short-lived CLI commands can exit without waiting for the safety timeout.
  tools.once('request', (request: { requestId: string }) => {
    tools.decidePermission(request.requestId, 'allow');
  });
  assert.equal(await tools.requestPermission(
    { requestId: 'approve-now', toolName: 'approval-probe', args: {} },
    { cwd: projectA, conversationId: 'approval' }
  ), true);

  // Cancellation must also settle a pending approval promptly.
  const cancelled = new AbortController();
  tools.once('request', () => cancelled.abort());
  assert.equal(await tools.requestPermission(
    { requestId: 'cancel-now', toolName: 'approval-probe', args: {} },
    { cwd: projectA, conversationId: 'approval', signal: cancelled.signal }
  ), false);

  const preCancelled = new AbortController();
  preCancelled.abort();
  let emitted = false;
  tools.once('request', () => { emitted = true; });
  assert.equal(await tools.requestPermission(
    { requestId: 'already-cancelled', toolName: 'approval-probe', args: {} },
    { cwd: projectA, conversationId: 'approval', signal: preCancelled.signal }
  ), false);
  assert.equal(emitted, false, 'a pre-cancelled request must never reach the approval UI');
} finally {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
}
