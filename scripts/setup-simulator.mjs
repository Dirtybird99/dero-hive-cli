#!/usr/bin/env node
// Builds the DERO blockchain simulator (cmd/simulator from DEROFDN/derohe)
// into resources/simulator/bin/ so the in-app simulator toggle can run it.
// Requires a Go toolchain; skips gracefully when Go or git is unavailable.
// Runs automatically on `npm install` (postinstall) and is idempotent.

import { existsSync, mkdirSync, rmSync, readdirSync, createWriteStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const binDir = join(__dirname, '..', 'resources', 'simulator', 'bin');
const binName = process.platform === 'win32' ? 'derod-simulator.exe' : 'derod-simulator';
const binPath = join(binDir, binName);

// Source tarball rather than `git clone`: the repo vendors a file with CJK
// characters in its name that git-for-windows refuses to checkout, while
// (bsd)tar extracts it fine.
const DEROHE_TARBALL = 'https://github.com/DEROFDN/derohe/archive/refs/heads/main.tar.gz';

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

async function main() {
  if (existsSync(binPath)) {
    console.log(`[simulator] up to date (${binPath})`);
    return;
  }
  if (!hasGo()) {
    console.warn('[simulator] Go toolchain not found — skipping simulator build.');
    console.warn('[simulator] Install Go (https://go.dev/dl) and run "npm run setup:simulator" to build it.');
    return;
  }

  const work = join(tmpdir(), `hive-derohe-${Date.now()}`);
  try {
    mkdirSync(work, { recursive: true });
    const archive = 'derohe.tar.gz';
    console.log(`[simulator] downloading ${DEROHE_TARBALL}`);
    const res = await fetch(DEROHE_TARBALL, { redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`download failed: ${res.status} ${res.statusText}`);
    await pipeline(res.body, createWriteStream(join(work, archive)));

    // Extract from inside `work` with a relative archive name. GNU tar reads
    // `host:path` as a remote archive, so an absolute Windows path makes it try
    // to reach a host named after the drive letter:
    //   tar (child): Cannot connect to C: resolve failed
    // Never handing it a colon sidesteps that, and bsdtar is happy either way.
    const r1 = run(tarCommand(), ['-xzf', archive], work);
    if (r1.status !== 0) throw new Error(`tar extract failed: ${describeFailure(r1)}`);

    const srcDir = readdirSync(work).map((n) => join(work, n)).find((p) => existsSync(join(p, 'go.mod')));
    if (!srcDir) throw new Error('extracted source tree not found (no go.mod)');

    mkdirSync(binDir, { recursive: true });
    const r2 = run('go', ['build', '-trimpath', '-o', binPath, './cmd/simulator'], srcDir);
    if (r2.status !== 0) throw new Error(`go build failed: ${describeFailure(r2)}`);

    console.log(`[simulator] built ${binPath}`);
  } catch (err) {
    // Never fail the top-level install; the simulator toggle will show
    // "not installed" until the build succeeds.
    console.warn(`[simulator] build failed: ${err.message}`);
    console.warn('[simulator] rerun "npm run setup:simulator" to retry.');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main();
