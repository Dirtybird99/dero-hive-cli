import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setupSimulator, simulatorInstallIsCurrent, withSimulatorInstallLock } from './setup-simulator.mjs';

const root = mkdtempSync(join(tmpdir(), 'dero-hive-simulator-setup-'));
const binaryPath = join(root, 'bin', 'derod-simulator');
const markerPath = `${binaryPath}.source.json`;
const commit = 'e9df1205b6603c62f0651d0e18e5e77a2584b15e';
const sourceSha256 = '5497dca08ffc6411a66ac66e038cabe10b4184ac840269d5490aacd1aaa6dbea';

try {
  mkdirSync(dirname(binaryPath), { recursive: true });
  const knownGood = Buffer.from('known-good-simulator');
  writeFileSync(binaryPath, knownGood);
  writeFileSync(markerPath, `${JSON.stringify({
    commit,
    sourceSha256,
    binarySha256: createHash('sha256').update(knownGood).digest('hex')
  })}\n`);
  assert.equal(await simulatorInstallIsCurrent(binaryPath, markerPath), true);
  writeFileSync(binaryPath, 'corrupted');
  assert.equal(await simulatorInstallIsCurrent(binaryPath, markerPath), false, 'startup verifies the installed binary hash');

  const priorBinary = Buffer.from('prior-working-binary');
  const priorMarker = '{"prior":"marker"}\n';
  const restorePrior = () => {
    writeFileSync(binaryPath, priorBinary);
    writeFileSync(markerPath, priorMarker);
  };
  const assertPriorPreserved = () => {
    assert.deepEqual(readFileSync(binaryPath), priorBinary);
    assert.equal(readFileSync(markerPath, 'utf8'), priorMarker);
    assert.equal(readdirSync(dirname(binaryPath)).some((name) => name.endsWith('.tmp')), false);
  };

  restorePrior();
  await assert.rejects(setupSimulator({
    binaryPath,
    markerPath,
    strictMode: true,
    hasGoImpl: () => true,
    fetchImpl: async () => { throw new Error('offline fixture'); }
  }), /offline fixture/u);
  assertPriorPreserved();

  restorePrior();
  const archive = Buffer.from('verified fake archive');
  await assert.rejects(setupSimulator({
    binaryPath,
    markerPath,
    strictMode: true,
    hasGoImpl: () => true,
    sourceCommit: 'test-commit',
    sourceSha256: createHash('sha256').update(archive).digest('hex'),
    sourceUrl: 'https://fixture.invalid/archive.tar.gz',
    fetchImpl: async () => new Response(archive),
    tarCommandImpl: () => 'fixture-tar',
    runImpl(command, args, cwd) {
      if (command === 'fixture-tar') {
        mkdirSync(join(cwd, 'source'), { recursive: true });
        writeFileSync(join(cwd, 'source', 'go.mod'), 'module fixture');
        return { status: 0 };
      }
      assert.equal(command, 'go');
      assert.ok(args.includes('build'));
      return { status: 1 };
    }
  }), /go build failed/u);
  assertPriorPreserved();
  assert.equal(existsSync(binaryPath), true);

  // Separate setup processes must never overlap the destination's critical
  // section. A sentinel makes overlap deterministic instead of relying on the
  // tiny timing window between the binary and provenance renames.
  const lockModule = new URL('./setup-simulator.mjs', import.meta.url).href;
  const barrier = join(root, 'lock-barrier');
  const sentinel = join(root, 'lock-critical');
  const worker = `
    import { existsSync, rmSync, writeFileSync } from 'node:fs';
    import { withSimulatorInstallLock } from ${JSON.stringify(lockModule)};
    while (!existsSync(process.argv[1])) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    await withSimulatorInstallLock(process.argv[2], async () => {
      if (existsSync(process.argv[3])) throw new Error('simulator install lock overlap');
      writeFileSync(process.argv[3], String(process.pid), { flag: 'wx' });
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
      rmSync(process.argv[3], { force: true });
    });`;
  const runWorker = () => new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', worker, barrier, binaryPath, sentinel], {
      stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolvePromise() : reject(new Error(`lock worker exited ${code}: ${stderr}`)));
  });
  const workers = [runWorker(), runWorker()];
  writeFileSync(barrier, 'go');
  await Promise.all(workers);
  assert.equal(existsSync(`${binaryPath}.install.lock`), false);
  assert.equal(existsSync(sentinel), false);

  // A process can die after O_EXCL creates the lock but before owner JSON is
  // written. That incomplete lock must recover inside the caller's timeout.
  const lockPath = `${binaryPath}.install.lock`;
  writeFileSync(lockPath, '');
  const stale = new Date(Date.now() - 2_000);
  utimesSync(lockPath, stale, stale);
  let recovered = false;
  await withSimulatorInstallLock(binaryPath, async () => { recovered = true; }, 1_000);
  assert.equal(recovered, true, 'an abandoned incomplete lock is recovered');
  assert.equal(existsSync(lockPath), false, 'the recovered lock is released');

  await assert.rejects(withSimulatorInstallLock(binaryPath, async () => {
    throw new Error('critical-section fixture');
  }), /critical-section fixture/u);
  assert.equal(existsSync(lockPath), false, 'operation failure still releases its owned lock');
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('simulator setup durability tests passed');
