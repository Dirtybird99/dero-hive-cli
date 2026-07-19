import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'dero-hive-tui-session-'));
const workspaceA = mkdtempSync(join(tmpdir(), 'dero-hive-workspace-a-'));
const workspaceB = mkdtempSync(join(tmpdir(), 'dero-hive-workspace-b-'));
const workspaceC = mkdtempSync(join(tmpdir(), 'dero-hive-workspace-c-'));
process.env.HIVE_DATA_DIR = dataDir;
process.env.HIVE_KEYCHAIN_DISABLED = '1';

const { initDb, closeDb, getDb } = await import('../../../src/main/db/client.js');
const config = await import('../utils/config.js');
const conversations = await import('../services/conversation.js');
const projects = await import('../services/project.js');
const { initialState } = await import('./App.js');
const { canonicalWorkspacePath, sameWorkspacePath } = await import('../../../src/shared/workspace.js');

try {
  await initDb();
  getDb().prepare(`
    INSERT INTO providers (id, preset_id, name, base_url, enabled, models, custom_headers, updated_at)
    VALUES ('test', 'openai', 'Test', 'http://127.0.0.1:1', 1, ?, '{}', ?)
  `).run(JSON.stringify([{ id: 'test-model', name: 'Test model' }]), Date.now());

  const projectA = projects.createProject({ name: 'A', path: workspaceA });
  const projectB = projects.createProject({ name: 'B', path: workspaceB });
  const conversationA = conversations.createConversation({
    providerId: 'test',
    model: 'test-model',
    projectId: projectA.id,
    workspacePath: workspaceA
  });
  config.saveState({
    currentConversationId: conversationA.id,
    currentProjectId: projectA.id,
    currentProjectPath: workspaceA,
    currentProviderId: 'test',
    currentModelId: 'test-model'
  });

  const mismatch = initialState({ conversation: conversationA.id, cwd: workspaceB });
  assert.match(mismatch.error || '', /different workspace/u);
  assert.equal(mismatch.conversationId, undefined);
  assert.equal(config.loadState().currentConversationId, conversationA.id, 'failed launches do not overwrite saved state');

  const scoped = initialState({ cwd: workspaceB });
  assert.notEqual(scoped.conversationId, conversationA.id, 'a different workspace never resumes the global newest conversation');
  assert.equal(conversations.getConversation(scoped.conversationId || '')?.projectId, projectB.id);
  assert.equal(sameWorkspacePath(conversations.getConversation(scoped.conversationId || '')?.workspacePath, workspaceB), true);

  const unregistered = initialState({ cwd: workspaceC });
  const unregisteredConversation = conversations.getConversation(unregistered.conversationId || '');
  assert.equal(unregisteredConversation?.projectId, undefined);
  assert.equal(sameWorkspacePath(unregisteredConversation?.workspacePath, workspaceC), true);

  getDb().prepare(`
    INSERT INTO conversations (id, title, created_at, updated_at, message_count)
    VALUES ('legacy-unscoped', 'Legacy unscoped', 1, ?, 1)
  `).run(Date.now() + 10_000);
  getDb().prepare(`
    INSERT INTO messages (id, conversation_id, role, content, created_at, sort_order)
    VALUES ('legacy-message', 'legacy-unscoped', 'user', 'old path unknown', 1, 1)
  `).run();
  config.saveState({
    currentConversationId: 'legacy-unscoped',
    currentProjectPath: workspaceC,
    currentProviderId: 'test',
    currentModelId: 'test-model'
  });
  const guardedLegacy = initialState({ cwd: workspaceC });
  assert.notEqual(guardedLegacy.conversationId, 'legacy-unscoped', 'legacy unscoped history is never implicitly adopted');
  const explicitLegacy = initialState({ conversation: 'legacy-unscoped', cwd: workspaceC });
  assert.match(explicitLegacy.error || '', /no workspace scope/u);

  const invalidCwd = initialState({ cwd: join(workspaceC, 'missing') });
  assert.match(invalidCwd.error || '', /does not exist or is not a directory/u);
  assert.equal(invalidCwd.conversationId, undefined, 'an explicit invalid cwd never falls back into another conversation');

  const workspaceFile = join(workspaceC, 'not-a-directory.txt');
  writeFileSync(workspaceFile, 'file, not workspace');
  const fileCwd = initialState({ cwd: workspaceFile });
  assert.match(fileCwd.error || '', /does not exist or is not a directory/u);
  assert.equal(fileCwd.conversationId, undefined, 'an explicit file cwd never creates or resumes a conversation');

  const mixedCaseDirectory = join(workspaceC, 'MiXeD-Workspace');
  mkdirSync(mixedCaseDirectory);
  assert.equal(canonicalWorkspacePath('MiXeD-Workspace', workspaceC), realpathSync.native(mixedCaseDirectory));

  const resumed = initialState({ conversation: conversationA.id });
  assert.equal(resumed.error, undefined);
  assert.equal(resumed.conversationId, conversationA.id);
  assert.equal(sameWorkspacePath(resumed.cwd, workspaceA), true);
} finally {
  closeDb();
  delete process.env.HIVE_KEYCHAIN_DISABLED;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workspaceA, { recursive: true, force: true });
  rmSync(workspaceB, { recursive: true, force: true });
  rmSync(workspaceC, { recursive: true, force: true });
}

console.log('TUI session isolation tests passed');
