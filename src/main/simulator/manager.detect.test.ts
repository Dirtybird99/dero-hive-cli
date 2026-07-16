import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Environment is pinned before the dynamic import so binary detection only
// sees this test's temp directories, even on machines with a real bundled
// simulator (resourcesRoot is captured at module load).
const originalDataDir = process.env.HIVE_DATA_DIR;
const originalResources = process.env.HIVE_RESOURCES;
const originalAppRoot = process.env.HIVE_APP_ROOT;

const baseDir = mkdtempSync(join(tmpdir(), 'dero-hive-simulator-detect-'));
const userDataDir = join(baseDir, 'userdata');
const resourcesDir = join(baseDir, 'resources');
const appRoot = join(baseDir, 'app');
process.env.HIVE_DATA_DIR = userDataDir;
process.env.HIVE_RESOURCES = resourcesDir;
process.env.HIVE_APP_ROOT = appRoot;

const defaultBin = process.platform === 'win32' ? 'derod-simulator.exe' : 'derod-simulator';
const secondaryBin = process.platform === 'win32' ? 'simulator.exe' : 'simulator';

try {
  const { SimulatorManager } = await import('./manager.js');

  // No candidate binaries exist anywhere.
  assert.equal(SimulatorManager.detectBinaryPath(), null);
  assert.equal(SimulatorManager.detectBinaryPath('   '), null, 'a blank override must be ignored');
  assert.equal(SimulatorManager.detectBinaryPath(join(baseDir, 'missing.exe')), null, 'a missing override must not be detected');

  // start() without any binary reports "not found" and spawns nothing.
  const missing = await new SimulatorManager().start({ detached: true });
  assert.equal(missing.running, false);
  assert.equal(missing.installed, false);
  assert.equal(missing.starting, false);
  assert.equal(missing.pid, null);
  assert.equal(missing.binaryPath, null);
  assert.match(missing.error ?? '', /Simulator binary not found/u);
  assert.equal(existsSync(join(userDataDir, 'simulator.pid.json')), false, 'no pid file may be written when the binary is missing');
  assert.equal(existsSync(join(userDataDir, 'simulator.start.lock')), false, 'no start lock may be left when the binary is missing');

  // A whitespace-only override is treated the same as no binary at all.
  const blank = await new SimulatorManager().start({ binaryPath: '   ' });
  assert.equal(blank.running, false);
  assert.equal(blank.binaryPath, null);
  assert.match(blank.error ?? '', /Simulator binary not found/u);

  // An explicit override pointing at a missing file fails but keeps the
  // requested path visible in the status for diagnostics.
  const overridePath = join(baseDir, 'custom', defaultBin);
  const missingOverride = await new SimulatorManager().start({ binaryPath: overridePath });
  assert.equal(missingOverride.running, false);
  assert.match(missingOverride.error ?? '', /Simulator binary not found/u);
  assert.ok(missingOverride.binaryPath?.includes(defaultBin), 'the requested binary path must be reported');

  // Detection walks candidates in priority order: override, then bundled
  // resources, then the app root copy, then the user-data copy; within each
  // location the default name beats the secondary name.
  const userDataSecondary = join(userDataDir, 'simulator', secondaryBin);
  mkdirSync(join(userDataDir, 'simulator'), { recursive: true });
  writeFileSync(userDataSecondary, 'fake');
  assert.equal(SimulatorManager.detectBinaryPath(), userDataSecondary);

  const userDataDefault = join(userDataDir, 'simulator', defaultBin);
  writeFileSync(userDataDefault, 'fake');
  assert.equal(SimulatorManager.detectBinaryPath(), userDataDefault, 'the default name must beat the secondary name');

  const appRootDefault = join(appRoot, 'resources', 'simulator', 'bin', defaultBin);
  mkdirSync(join(appRoot, 'resources', 'simulator', 'bin'), { recursive: true });
  writeFileSync(appRootDefault, 'fake');
  assert.equal(SimulatorManager.detectBinaryPath(), appRootDefault, 'the app root copy must beat the user-data copy');

  const resourcesSecondary = join(resourcesDir, 'simulator', 'bin', secondaryBin);
  mkdirSync(join(resourcesDir, 'simulator', 'bin'), { recursive: true });
  writeFileSync(resourcesSecondary, 'fake');
  assert.equal(SimulatorManager.detectBinaryPath(), resourcesSecondary, 'bundled resources must beat the app root copy');

  const resourcesDefault = join(resourcesDir, 'simulator', 'bin', defaultBin);
  writeFileSync(resourcesDefault, 'fake');
  assert.equal(SimulatorManager.detectBinaryPath(), resourcesDefault, 'the bundled default binary must win');

  const overrideBin = join(baseDir, 'override', defaultBin);
  mkdirSync(join(baseDir, 'override'), { recursive: true });
  writeFileSync(overrideBin, 'fake');
  assert.equal(SimulatorManager.detectBinaryPath(overrideBin), overrideBin, 'an existing override must beat every candidate');

  // With a detectable binary present, status() reports installed without running.
  const installedStatus = new SimulatorManager().status();
  assert.equal(installedStatus.installed, true);
  assert.equal(installedStatus.running, false);
  assert.equal(installedStatus.pid, null);

  console.log('simulator manager detection tests passed');
} finally {
  if (originalDataDir === undefined) delete process.env.HIVE_DATA_DIR;
  else process.env.HIVE_DATA_DIR = originalDataDir;
  if (originalResources === undefined) delete process.env.HIVE_RESOURCES;
  else process.env.HIVE_RESOURCES = originalResources;
  if (originalAppRoot === undefined) delete process.env.HIVE_APP_ROOT;
  else process.env.HIVE_APP_ROOT = originalAppRoot;
  rmSync(baseDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
