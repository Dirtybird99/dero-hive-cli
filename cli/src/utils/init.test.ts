import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'dero-hive-init-'));
process.env.HIVE_DATA_DIR = dataDir;
process.env.HIVE_KEYCHAIN_DISABLED = '1';

const { getSimulatorManager } = await import('../../../src/main/simulator/instance.js');
const { initHive, shutdownHive } = await import('./init.js');

try {
  const contexts = await Promise.all([initHive(), initHive(), initHive()]);
  const context = contexts[0];
  assert.ok(contexts.every((candidate) => candidate === context), 'concurrent initialization shares one context');
  assert.equal(getSimulatorManager(), context.simulator);
  assert.ok(context.tools.listTools().some((tool) => tool.name === 'simulator_get_height'));
} finally {
  await shutdownHive();
  await shutdownHive();
  assert.equal(getSimulatorManager(), null);
  delete process.env.HIVE_KEYCHAIN_DISABLED;
  rmSync(dataDir, { recursive: true, force: true });
}

console.log('CLI initialization tests passed');
