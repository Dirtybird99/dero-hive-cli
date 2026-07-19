import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareNpmGlobalPrefix } from './npm-global-prefix.mjs';

const root = await mkdtemp(join(tmpdir(), 'dero-hive-npm-prefix-'));
try {
  const windows = join(root, 'windows');
  await prepareNpmGlobalPrefix(windows, 'win32');
  assert.equal(existsSync(windows), true);
  assert.equal(existsSync(join(windows, 'lib')), false);

  for (const targetPlatform of ['linux', 'darwin']) {
    const prefix = join(root, targetPlatform);
    await prepareNpmGlobalPrefix(prefix, targetPlatform);
    assert.equal(existsSync(join(prefix, 'lib')), true);
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('npm global prefix tests passed');
