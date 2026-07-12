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
} finally {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
}
