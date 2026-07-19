#!/usr/bin/env node
// Builds the DERO blockchain simulator (cmd/simulator from DEROFDN/derohe)
// into resources/simulator/bin/ so the in-app simulator toggle can run it.
// Requires a Go toolchain; skips gracefully when Go is unavailable.
// Run manually with `npm run setup:simulator`; the build is idempotent.

import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, readdirSync, createReadStream, createWriteStream, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const binDir = join(__dirname, '..', 'resources', 'simulator', 'bin');
const binName = process.platform === 'win32' ? 'derod-simulator.exe' : 'derod-simulator';
const binPath = join(binDir, binName);

// Source tarball rather than `git clone`: the repo vendors a file with CJK
// characters in its name that git-for-windows refuses to checkout, while
// (bsd)tar extracts it fine.
const DEROHE_COMMIT = 'e9df1205b6603c62f0651d0e18e5e77a2584b15e';
const DEROHE_SHA256 = '5497dca08ffc6411a66ac66e038cabe10b4184ac840269d5490aacd1aaa6dbea';
const DEROHE_TARBALL = `https://github.com/DEROFDN/derohe/archive/${DEROHE_COMMIT}.tar.gz`;
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const INSTALL_LOCK_TIMEOUT_MS = 60_000;
const INCOMPLETE_LOCK_STALE_MS = 5 * 60_000;
const strict = process.argv.includes('--strict') || process.env.CI === 'true';
const provenancePath = `${binPath}.source.json`;

// No shell: `go` and `tar` are real executables on every platform, and a
// shell would re-split arguments containing spaces (e.g. paths).
function run(cmd, args, cwd) {
  console.log(`[simulator] ${cmd} ${args.join(' ')}`);
  return spawnSync(cmd, args, { cwd, stdio: 'inherit' });
}

/** Turn a spawnSync result into something worth reading. A missing binary sets
 *  `error` and leaves `status` null, which is otherwise indistinguishable from
 *  a non-zero exit. */
function describeFailure(result) {
  if (result.error) return result.error.message;
  if (result.signal) return `killed by ${result.signal}`;
  return `exit ${result.status}`;
}

/**
 * Windows ships bsdtar as %SystemRoot%\System32\tar.exe, but a bare `tar` may
 * instead resolve to Git-for-Windows' GNU tar — which is on PATH on any machine
 * with git, and which this app requires. Prefer bsdtar by absolute path when it
 * is there, because the two disagree about drive letters (see extraction below).
 */
function tarCommand() {
  if (process.platform !== 'win32') return 'tar';
  const bsdtar = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  return existsSync(bsdtar) ? bsdtar : 'tar';
}

function hasGo() {
  return spawnSync('go', ['version'], { stdio: 'ignore' }).status === 0;
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function simulatorInstallMatches(binaryPath, markerPath, sourceCommit, sourceSha256) {
  if (!existsSync(binaryPath) || !existsSync(markerPath)) return false;
  try {
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    return marker.commit === sourceCommit
      && marker.sourceSha256 === sourceSha256
      && typeof marker.binarySha256 === 'string'
      && marker.binarySha256 === await sha256(binaryPath);
  } catch {
    return false;
  }
}

export async function simulatorInstallIsCurrent(binaryPath = binPath, markerPath = provenancePath) {
  return simulatorInstallMatches(binaryPath, markerPath, DEROHE_COMMIT, DEROHE_SHA256);
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function removeAbandonedInstallLock(lockPath, incompleteStaleMs) {
  let raw;
  let ageMs;
  try {
    raw = readFileSync(lockPath, 'utf8');
    ageMs = Date.now() - statSync(lockPath).mtimeMs;
  } catch {
    return true;
  }
  try {
    const owner = JSON.parse(raw);
    if (processIsAlive(owner.pid)) return false;
  } catch {
    if (ageMs < incompleteStaleMs) return false;
  }
  // Re-read immediately before removal so a lock replaced by another process
  // is not mistaken for the abandoned owner we inspected.
  try {
    if (readFileSync(lockPath, 'utf8') !== raw) return false;
    rmSync(lockPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

function wait(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/** Serialize the final binary+provenance swap for one destination. */
export async function withSimulatorInstallLock(binaryPath, operation, timeoutMs = INSTALL_LOCK_TIMEOUT_MS) {
  const lockPath = `${binaryPath}.install.lock`;
  const token = `${process.pid}.${randomBytes(12).toString('hex')}`;
  const owner = JSON.stringify({ pid: process.pid, token, createdAt: Date.now() });
  const deadline = Date.now() + timeoutMs;
  // A creator can crash after O_EXCL creates an empty file. Recover within the
  // same wait budget; ownership verification below keeps a paused creator from
  // entering the critical section if another process reaps that empty inode.
  const incompleteStaleMs = Math.min(INCOMPLETE_LOCK_STALE_MS, Math.max(100, Math.floor(timeoutMs / 2)));
  mkdirSync(dirname(binaryPath), { recursive: true });
  while (true) {
    try {
      writeFileSync(lockPath, owner, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      removeAbandonedInstallLock(lockPath, incompleteStaleMs);
      if (Date.now() >= deadline) throw new Error(`timed out waiting for simulator install lock: ${lockPath}`);
      await wait(50);
      continue;
    }
    try {
      if (readFileSync(lockPath, 'utf8') === owner) break;
    } catch { /* a stale-lock reaper replaced our inode; acquire again */ }
    if (Date.now() >= deadline) throw new Error(`timed out acquiring simulator install lock: ${lockPath}`);
    await wait(50);
  }
  try {
    return await operation();
  } finally {
    try {
      const currentOwner = JSON.parse(readFileSync(lockPath, 'utf8'));
      if (currentOwner.token === token) rmSync(lockPath, { force: true });
    } catch { /* another process can recover a lock left by an interrupted owner */ }
  }
}

function installStagedPair(stagedBinary, stagedMarker, binaryPath, markerPath) {
  const token = `${process.pid}.${randomBytes(6).toString('hex')}`;
  const binaryBackup = `${binaryPath}.${token}.bak`;
  const markerBackup = `${markerPath}.${token}.bak`;
  let binaryBackedUp = false;
  let markerBackedUp = false;
  let binaryInstalled = false;
  let markerInstalled = false;
  try {
    if (existsSync(binaryPath)) { renameSync(binaryPath, binaryBackup); binaryBackedUp = true; }
    if (existsSync(markerPath)) { renameSync(markerPath, markerBackup); markerBackedUp = true; }
    renameSync(stagedBinary, binaryPath);
    binaryInstalled = true;
    renameSync(stagedMarker, markerPath);
    markerInstalled = true;
  } catch (error) {
    if (markerInstalled) rmSync(markerPath, { force: true });
    if (binaryInstalled) rmSync(binaryPath, { force: true });
    const restoreErrors = [];
    if (binaryBackedUp) {
      try { renameSync(binaryBackup, binaryPath); } catch (restoreError) { restoreErrors.push(restoreError); }
    }
    if (markerBackedUp) {
      try { renameSync(markerBackup, markerPath); } catch (restoreError) { restoreErrors.push(restoreError); }
    }
    if (restoreErrors.length) {
      throw new AggregateError([error, ...restoreErrors], 'Simulator install failed and its previous files could not be fully restored');
    }
    throw error;
  } finally {
    rmSync(stagedBinary, { force: true });
    rmSync(stagedMarker, { force: true });
  }
  // The new binary+marker pair is already committed. Backup cleanup must not
  // roll it back or remove it if antivirus/indexing temporarily holds a backup.
  try { rmSync(binaryBackup, { force: true }); } catch { /* harmless stale backup */ }
  try { rmSync(markerBackup, { force: true }); } catch { /* harmless stale backup */ }
}

export async function setupSimulator(options = {}) {
  const binaryPath = options.binaryPath || binPath;
  const markerPath = options.markerPath || `${binaryPath}.source.json`;
  const strictMode = options.strictMode ?? strict;
  const fetchImpl = options.fetchImpl || fetch;
  const hasGoImpl = options.hasGoImpl || hasGo;
  const runImpl = options.runImpl || run;
  const tarCommandImpl = options.tarCommandImpl || tarCommand;
  const sourceCommit = options.sourceCommit || DEROHE_COMMIT;
  const sourceSha256 = options.sourceSha256 || DEROHE_SHA256;
  const sourceUrl = options.sourceUrl || DEROHE_TARBALL;
  if (await simulatorInstallMatches(binaryPath, markerPath, sourceCommit, sourceSha256)) {
    console.log(`[simulator] up to date (${binaryPath})`);
    return true;
  }
  if (!hasGoImpl()) {
    const message = 'Go toolchain not found. Install Go (https://go.dev/dl) and retry.';
    if (strictMode) throw new Error(message);
    console.warn(`[simulator] ${message} Skipping optional simulator build.`);
    return false;
  }

  const work = mkdtempSync(join(tmpdir(), 'hive-derohe-'));
  const destinationDir = dirname(binaryPath);
  mkdirSync(destinationDir, { recursive: true });
  const stagingToken = `${process.pid}.${randomBytes(6).toString('hex')}`;
  const stagedBinary = join(destinationDir, `.${basename(binaryPath)}.${stagingToken}.tmp`);
  const stagedMarker = join(destinationDir, `.${basename(markerPath)}.${stagingToken}.tmp`);
  try {
    const archive = 'derohe.tar.gz';
    console.log(`[simulator] downloading ${sourceUrl}`);
    const res = await fetchImpl(sourceUrl, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
    if (!res.ok || !res.body) throw new Error(`download failed: ${res.status} ${res.statusText}`);
    const declaredBytes = Number(res.headers.get('content-length') || 0);
    if (declaredBytes > MAX_ARCHIVE_BYTES) throw new Error(`source archive exceeds ${MAX_ARCHIVE_BYTES} bytes`);
    let receivedBytes = 0;
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        receivedBytes += chunk.length;
        callback(receivedBytes > MAX_ARCHIVE_BYTES ? new Error(`source archive exceeds ${MAX_ARCHIVE_BYTES} bytes`) : null, chunk);
      }
    });
    await pipeline(res.body, limiter, createWriteStream(join(work, archive), { flags: 'wx' }));
    const actualSha256 = await sha256(join(work, archive));
    if (actualSha256 !== sourceSha256) {
      throw new Error(`source checksum mismatch: expected ${sourceSha256}, got ${actualSha256}`);
    }
    console.log(`[simulator] verified source ${sourceCommit} (${actualSha256})`);

    // Extract from inside `work` with a relative archive name. GNU tar reads
    // `host:path` as a remote archive, so an absolute Windows path makes it try
    // to reach a host named after the drive letter:
    //   tar (child): Cannot connect to C: resolve failed
    // Never handing it a colon sidesteps that, and bsdtar is happy either way.
    const r1 = runImpl(tarCommandImpl(), ['-xzf', archive], work);
    if (r1.status !== 0) throw new Error(`tar extract failed: ${describeFailure(r1)}`);

    const srcDir = readdirSync(work).map((n) => join(work, n)).find((p) => existsSync(join(p, 'go.mod')));
    if (!srcDir) throw new Error('extracted source tree not found (no go.mod)');

    const r2 = runImpl('go', ['build', '-trimpath', '-o', stagedBinary, './cmd/simulator'], srcDir);
    if (r2.status !== 0) throw new Error(`go build failed: ${describeFailure(r2)}`);
    const binarySha256 = await sha256(stagedBinary);
    const provenance = { commit: sourceCommit, sourceSha256, binarySha256 };
    writeFileSync(stagedMarker, `${JSON.stringify(provenance)}\n`, { flag: 'wx' });
    await withSimulatorInstallLock(binaryPath, async () => {
      // A concurrent build may have completed while this process was building.
      // Keep its verified result instead of needlessly swapping the same source.
      if (await simulatorInstallMatches(binaryPath, markerPath, sourceCommit, sourceSha256)) {
        rmSync(stagedBinary, { force: true });
        rmSync(stagedMarker, { force: true });
        return;
      }
      installStagedPair(stagedBinary, stagedMarker, binaryPath, markerPath);
    });

    console.log(`[simulator] built ${binaryPath} (${binarySha256})`);
    return true;
  } catch (err) {
    rmSync(stagedBinary, { force: true });
    rmSync(stagedMarker, { force: true });
    console.warn(`[simulator] build failed: ${err.message}`);
    console.warn('[simulator] rerun "npm run setup:simulator" to retry.');
    if (strictMode) throw err;
    return false;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await setupSimulator();
  } catch {
    process.exitCode = 1;
  }
}
