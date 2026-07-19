import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dataDir = mkdtempSync(join(tmpdir(), 'dero-hive-secrets-concurrent-'));
const moduleUrl = pathToFileURL(join(process.cwd(), 'src', 'main', 'utils', 'secrets.ts')).href;

function runChild(source: string, args: string[], profileDir = dataDir, homeDir?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source, ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HIVE_DATA_DIR: profileDir,
        HIVE_KEYCHAIN_DISABLED: '1',
        HIVE_CLI: '1',
        ...(homeDir ? { HOME: homeDir, USERPROFILE: homeDir } : {}),
        USERNAME: 'hive-concurrent-user',
        COMPUTERNAME: 'hive-concurrent-host'
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => code === 0
      ? resolve(stdout.trim())
      : reject(new Error(`secret fixture exited ${code}: ${stderr}`)));
  });
}

try {
  const userHome = join(dataDir, 'user-home');
  mkdirSync(userHome);
  const keyFile = join(userHome, 'fixture-keychain.txt');
  const masterBarrier = join(dataDir, 'master.go');
  const masterSource = `
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const { __loadOrCreateMasterKeyForTest, __masterKeyLockPathForTest } = await import(${JSON.stringify(moduleUrl)});
while (!existsSync(process.argv[1])) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
const key = __loadOrCreateMasterKeyForTest(
  () => existsSync(process.argv[2]) ? readFileSync(process.argv[2], 'utf8') : null,
  (value) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40); writeFileSync(process.argv[2], value); }
);
process.stdout.write(JSON.stringify({ key: key.toString('hex'), lockPath: __masterKeyLockPathForTest() }));
`;
  const profileDirs = Array.from({ length: 6 }, (_, index) => join(dataDir, `profile-${index}`));
  const masterChildren = profileDirs.map((profileDir) => {
    mkdirSync(profileDir);
    return runChild(masterSource, [masterBarrier, keyFile], profileDir, userHome);
  });
  writeFileSync(masterBarrier, 'go');
  const results = (await Promise.all(masterChildren))
    .map((output) => JSON.parse(output) as { key: string; lockPath: string });
  const keys = results.map(({ key }) => key);
  assert.equal(new Set(keys).size, 1, 'concurrent first initialization returns one winning master key');
  assert.match(keys[0], /^[0-9a-f]{64}$/u);
  assert.equal(readFileSync(keyFile, 'utf8'), keys[0], 'every process re-reads the retained keychain winner');
  assert.deepEqual(
    [...new Set(results.map(({ lockPath }) => lockPath))],
    [join(userHome, '.dero-hive-secrets-master-key-v2.lock')],
    'all profiles use one per-user lock outside HIVE_DATA_DIR'
  );

  const mutationBarrier = join(dataDir, 'mutation.go');
  const mutationSource = `
import { existsSync } from 'node:fs';
const { setSecret } = await import(${JSON.stringify(moduleUrl)});
while (!existsSync(process.argv[1])) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
setSecret(process.argv[2], process.argv[3]);
`;
  const mutations = Array.from({ length: 12 }, (_, index) =>
    runChild(mutationSource, [mutationBarrier, `concurrent-${index}`, `value-${index}`]));
  writeFileSync(mutationBarrier, 'go');
  await Promise.all(mutations);
  const store = JSON.parse(readFileSync(join(dataDir, 'secrets.json'), 'utf8')) as Record<string, string>;
  assert.equal(Object.keys(store).filter((key) => key.startsWith('concurrent-')).length, 12, 'locked mutations retain every distinct key');
  assert.equal(existsSync(join(dataDir, 'secrets.json.lock')), false, 'mutation lock is released');
  assert.equal(existsSync(join(userHome, '.dero-hive-secrets-master-key-v2.lock')), false, 'global master-key lock is released');
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}

console.log('multiprocess secret-store tests passed');
