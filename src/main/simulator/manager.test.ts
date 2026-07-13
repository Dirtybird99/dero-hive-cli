import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { SimulatorManager } from './manager.js';

const originalDataDir = process.env.HIVE_DATA_DIR;
const originalProviderKey = process.env.HIVE_PROVIDER_SIMULATOR_TEST_API_KEY;
const dataDir = mkdtempSync(join(tmpdir(), 'dero-hive-simulator-'));
let pid: number | null = null;
process.env.HIVE_DATA_DIR = dataDir;
process.env.HIVE_PROVIDER_SIMULATOR_TEST_API_KEY = 'must-not-reach-simulator';

try {
  const envProbe = join(dataDir, 'child-env.txt');
  const childScript = `process.getBuiltinModule('fs').writeFileSync(${JSON.stringify(envProbe)},process.env.HIVE_PROVIDER_SIMULATOR_TEST_API_KEY||'missing');setInterval(()=>{},1000)`;
  const started = await new SimulatorManager().start({
    binaryPath: process.execPath,
    args: ['-e', childScript],
    cwd: dataDir,
    detached: true
  });
  pid = started.pid;
  assert.equal(started.running, true);
  assert.ok(pid);
  assert.equal(existsSync(join(dataDir, 'simulator.pid.json')), true);
  for (let attempt = 0; attempt < 50 && !existsSync(envProbe); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(readFileSync(envProbe, 'utf8'), 'missing', 'provider secrets must not be inherited by the simulator');

  const freshManager = new SimulatorManager();
  assert.equal(freshManager.status().pid, pid);
  assert.notEqual((await freshManager.health()).error, 'Simulator is not running.');

  const recordPath = join(dataDir, 'simulator.pid.json');
  const recordJson = readFileSync(recordPath, 'utf8');
  writeFileSync(recordPath, JSON.stringify({ ...JSON.parse(recordJson), binaryPath: join(dataDir, 'not-the-simulator') }));
  assert.match((await freshManager.stop()).error ?? '', /Refused to stop PID/u);
  assert.doesNotThrow(() => process.kill(pid!, 0));
  writeFileSync(recordPath, recordJson);

  writeFileSync(recordPath, JSON.stringify({ ...JSON.parse(recordJson), startedAt: Date.now() - 60_000 }));
  assert.match((await freshManager.stop()).error ?? '', /Refused to stop PID/u);
  assert.doesNotThrow(() => process.kill(pid!, 0));
  writeFileSync(recordPath, recordJson);

  const stopped = await new SimulatorManager().stop();
  assert.equal(stopped.running, false);
  assert.equal(stopped.error, null);
  assert.throws(() => process.kill(pid!, 0));
  assert.equal(existsSync(join(dataDir, 'simulator.pid.json')), false);
  pid = null;

  const relativeStart = await new SimulatorManager().start({
    binaryPath: relative(process.cwd(), process.execPath),
    args: ['-e', 'setInterval(()=>{},1000)'],
    cwd: dataDir,
    detached: true
  });
  pid = relativeStart.pid;
  assert.equal(relativeStart.running, true);
  assert.equal((await new SimulatorManager().stop()).running, false, 'relative binaries must remain stoppable');
  pid = null;

  writeFileSync(join(dataDir, 'simulator.start.lock'), String(Date.now()));
  const blocked = await new SimulatorManager().start({ binaryPath: process.execPath, detached: true });
  assert.match(blocked.error ?? '', /start is already in progress/u);
  rmSync(join(dataDir, 'simulator.start.lock'), { force: true });

  const invalid = await new SimulatorManager().start({ binaryPath: dataDir, detached: true });
  assert.match(invalid.error ?? '', /PID|spawn|permission|EACCES|EINVAL/u);

  console.log('simulator manager tests passed');
} finally {
  if (pid) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  if (originalDataDir === undefined) delete process.env.HIVE_DATA_DIR;
  else process.env.HIVE_DATA_DIR = originalDataDir;
  if (originalProviderKey === undefined) delete process.env.HIVE_PROVIDER_SIMULATOR_TEST_API_KEY;
  else process.env.HIVE_PROVIDER_SIMULATOR_TEST_API_KEY = originalProviderKey;
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
