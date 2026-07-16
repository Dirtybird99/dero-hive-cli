import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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

  // --- stop() when nothing is running is a graceful no-op ---
  const idleStop = await new SimulatorManager().stop();
  assert.equal(idleStop.running, false);
  assert.equal(idleStop.pid, null);
  assert.equal(idleStop.error, null);

  // --- corrupted or invalid PID files are discarded, not fatal ---
  writeFileSync(recordPath, 'not json {{{');
  const corrupted = new SimulatorManager().status();
  assert.equal(corrupted.running, false);
  assert.equal(corrupted.pid, null);
  assert.equal(existsSync(recordPath), false, 'corrupted pid file must be deleted');

  writeFileSync(recordPath, JSON.stringify({ pid: process.pid, binaryPath: 42, args: 'nope', cwd: null, startedAt: 'now' }));
  assert.equal(new SimulatorManager().status().running, false);
  assert.equal(existsSync(recordPath), false, 'malformed pid record must be deleted');

  writeFileSync(recordPath, JSON.stringify({ pid: -1, binaryPath: process.execPath, args: [], cwd: dataDir, startedAt: Date.now() }));
  assert.equal(new SimulatorManager().status().running, false);
  assert.equal(existsSync(recordPath), false, 'non-positive pid must be rejected and cleaned up');

  // --- stale PID file (recorded process already exited) ---
  const dead = spawnSync(process.execPath, ['-e', '0']);
  assert.equal(dead.status, 0);
  const staleRecord = JSON.stringify({ pid: dead.pid, binaryPath: process.execPath, args: [], cwd: dataDir, startedAt: Date.now() });
  writeFileSync(recordPath, staleRecord);
  const stale = new SimulatorManager().status();
  assert.equal(stale.running, false);
  assert.equal(existsSync(recordPath), false, 'stale pid file must be cleaned up by status()');
  writeFileSync(recordPath, staleRecord);
  const staleStop = await new SimulatorManager().stop();
  assert.equal(staleStop.running, false);
  assert.equal(staleStop.error, null);
  assert.equal(existsSync(recordPath), false, 'stale pid file must be cleaned up by stop()');

  // --- a second detached start adopts the running instance instead of spawning another ---
  const lockPath = join(dataDir, 'simulator.start.lock');
  const first = await new SimulatorManager().start({
    binaryPath: process.execPath,
    args: ['-e', 'setInterval(()=>{},1000)'],
    cwd: dataDir,
    detached: true
  });
  pid = first.pid;
  assert.equal(first.running, true);
  const second = await new SimulatorManager().start({
    binaryPath: process.execPath,
    args: ['-e', 'setInterval(()=>{},1000)'],
    cwd: dataDir,
    detached: true
  });
  assert.equal(second.running, true);
  assert.equal(second.pid, pid, 'second start must return the already-running instance');
  assert.equal(second.error, null);
  assert.equal(existsSync(lockPath), false, 'idempotent start must not leave a start lock behind');

  // --- restart() replaces the running instance with a new process ---
  const restarted = await new SimulatorManager().restart({
    binaryPath: process.execPath,
    args: ['-e', 'setInterval(()=>{},1000)'],
    cwd: dataDir,
    detached: true
  });
  assert.equal(restarted.running, true);
  assert.ok(restarted.pid);
  assert.notEqual(restarted.pid, pid, 'restart must spawn a fresh process');
  assert.throws(() => process.kill(pid!, 0), 'restart must stop the previous process');
  pid = restarted.pid;
  assert.equal((await new SimulatorManager().stop()).running, false);
  assert.throws(() => process.kill(pid!, 0));
  pid = null;

  // --- a stale start lock (older than the start timeout) is reclaimed ---
  writeFileSync(lockPath, String(Date.now() - 60_000));
  const reclaimed = await new SimulatorManager().start({
    binaryPath: process.execPath,
    args: ['-e', 'setInterval(()=>{},1000)'],
    cwd: dataDir,
    detached: true
  });
  pid = reclaimed.pid;
  assert.equal(reclaimed.running, true, 'stale start locks must not block starts forever');
  assert.equal(reclaimed.error, null);
  assert.equal(existsSync(lockPath), false, 'reclaimed lock must be released after start');
  assert.equal((await new SimulatorManager().stop()).running, false);
  pid = null;

  // --- an unreadable lock timestamp blocks the start (fail closed) ---
  writeFileSync(lockPath, 'not-a-timestamp');
  const garbageLock = await new SimulatorManager().start({ binaryPath: process.execPath, detached: true });
  assert.equal(garbageLock.running, false);
  assert.match(garbageLock.error ?? '', /start is already in progress/u);
  rmSync(lockPath, { force: true });

  // --- spawn ENOENT (missing cwd) fails the start, releases the lock, records the error ---
  const enoentManager = new SimulatorManager();
  const enoent = await enoentManager.start({
    binaryPath: process.execPath,
    args: ['-e', '0'],
    cwd: join(dataDir, 'no-such-cwd'),
    detached: true
  });
  assert.equal(enoent.running, false);
  assert.equal(enoent.pid, null);
  assert.ok(enoent.error, 'spawn failure must surface an error');
  for (let attempt = 0; attempt < 50 && !/ENOENT/u.test(enoentManager.status().error ?? ''); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.match(enoentManager.status().error ?? '', /ENOENT/u, 'the spawn ENOENT must be recorded');
  assert.equal(enoentManager.status().running, false);
  assert.equal(existsSync(lockPath), false, 'failed detached start must release the start lock');
  assert.equal(existsSync(recordPath), false, 'failed detached start must not leave a pid file');

  // --- attached (non-detached) lifecycle: no pid file, per-manager visibility, throwing onChange tolerated ---
  let changeCount = 0;
  const attachedManager = new SimulatorManager(() => { changeCount += 1; throw new Error('listener boom'); });
  const attached = await attachedManager.start({
    binaryPath: process.execPath,
    args: ['-e', 'setInterval(()=>{},1000)'],
    cwd: dataDir
  });
  pid = attached.pid;
  assert.equal(attached.running, true);
  assert.ok(pid);
  assert.ok(changeCount > 0, 'onChange must be invoked even when it throws');
  assert.equal(existsSync(recordPath), false, 'attached starts must not write a pid file');
  assert.equal(new SimulatorManager().status().running, false, 'attached instances are invisible to other managers');

  const attachedAgain = await attachedManager.start({
    binaryPath: process.execPath,
    args: ['-e', 'setInterval(()=>{},1000)'],
    cwd: dataDir
  });
  assert.equal(attachedAgain.pid, pid, 'start while running must be a no-op that reports the live pid');

  const attachedStop = await attachedManager.stop();
  assert.equal(attachedStop.running, false);
  assert.equal(attachedStop.pid, null);
  assert.throws(() => process.kill(pid!, 0));
  pid = null;

  // --- RPC surface refuses to run while the simulator is down ---
  const idle = new SimulatorManager();
  assert.deepEqual(await idle.health(), {
    reachable: false,
    endpoint: 'http://127.0.0.1:20000/json_rpc',
    error: 'Simulator is not running.'
  });
  await assert.rejects(idle.chainInfo(), /Simulator is not running/u);
  await assert.rejects(idle.getHeight(), /Simulator is not running/u);
  await assert.rejects(idle.getBalance('deto1example'), /Simulator is not running/u);
  await assert.rejects(idle.sendTransaction('00'), /Simulator is not running/u);
  await assert.rejects(idle.getTransaction('feed'), /Simulator is not running/u);
  await assert.rejects(idle.createFixtureWallet(), /Simulator is not running/u);
  await assert.rejects(idle.getContractState('scid'), /Simulator is not running/u);
  assert.deepEqual(await idle.listContracts(), []);

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
