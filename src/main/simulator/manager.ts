import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readlinkSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { logger } from '../utils/logger';
import { paths } from '../utils/paths';
import { resourcesRoot } from '../utils/paths';
import type { SimulatorChainInfo, SimulatorHealth, SimulatorStatus, SimulatorStartOptions } from '@shared/types';

const DEFAULT_BIN_NAME = process.platform === 'win32' ? 'derod-simulator.exe' : 'derod-simulator';
const SECONDARY_BIN_NAME = process.platform === 'win32' ? 'simulator.exe' : 'simulator';
const START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 8_000;
const CHILD_ENV_KEYS = [
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'ComSpec',
  'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
  'LANG', 'LC_ALL', 'DERO_NETWORK'
] as const;

interface DetachedSimulatorRecord {
  pid: number;
  binaryPath: string;
  args: string[];
  cwd: string;
  startedAt: number;
}

const pidFile = (): string => join(paths.userData, 'simulator.pid.json');
const startLockFile = (): string => join(paths.userData, 'simulator.start.lock');

function claimStartLock(): boolean {
  try {
    writeFileSync(startLockFile(), String(Date.now()), { flag: 'wx', mode: 0o600 });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return false;
    try {
      const createdAt = Number(readFileSync(startLockFile(), 'utf8'));
      if (Number.isFinite(createdAt) && Date.now() - createdAt > START_TIMEOUT_MS) {
        unlinkSync(startLockFile());
        writeFileSync(startLockFile(), String(Date.now()), { flag: 'wx', mode: 0o600 });
        return true;
      }
    } catch { /* another process owns or replaced the lock */ }
    return false;
  }
}

function releaseStartLock(): void {
  try { unlinkSync(startLockFile()); } catch { /* already released */ }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function canonicalPath(path: string): string {
  try { return realpathSync.native(path); } catch { return resolvePath(path); }
}

function readDetachedRecord(): DetachedSimulatorRecord | null {
  try {
    const record = JSON.parse(readFileSync(pidFile(), 'utf8')) as Partial<DetachedSimulatorRecord>;
    if (!Number.isSafeInteger(record.pid) || (record.pid ?? 0) <= 0 || typeof record.binaryPath !== 'string' ||
        !Array.isArray(record.args) || !record.args.every((arg) => typeof arg === 'string') ||
        typeof record.cwd !== 'string' || typeof record.startedAt !== 'number') throw new Error('Invalid simulator PID record.');
    if (!processAlive(record.pid!)) {
      unlinkSync(pidFile());
      return null;
    }
    return record as DetachedSimulatorRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      try { unlinkSync(pidFile()); } catch { /* already gone */ }
    }
    return null;
  }
}

function simulatorEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of CHILD_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}

function sameProcess(record: DetachedSimulatorRecord): boolean {
  const expected = canonicalPath(record.binaryPath);
  const startedNear = (actual: number): boolean => Number.isFinite(actual) && Math.abs(actual - record.startedAt) < 5_000;
  const hasArgs = (command: string): boolean => !record.args[0] || command.includes(record.args[0]);
  try {
    if (process.platform === 'linux' || process.platform === 'darwin') {
      const actualBinary = process.platform === 'linux' ? canonicalPath(readlinkSync(`/proc/${record.pid}/exe`)) : expected;
      const output = spawnSync('ps', ['-p', String(record.pid), '-o', 'lstart=', '-o', 'command='], {
        encoding: 'utf8', timeout: 3_000
      }).stdout.trim();
      const startedAt = Date.parse(output.slice(0, 24));
      const command = output.slice(24).trim();
      return actualBinary === expected && startedNear(startedAt) && command.includes(expected) && hasArgs(command);
    }
    if (process.platform === 'win32') {
      const command = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${record.pid}'; if($p){[pscustomobject]@{ExecutablePath=$p.ExecutablePath;StartedAt=([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds();CommandLine=$p.CommandLine}|ConvertTo-Json -Compress}`;
      const output = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
        encoding: 'utf8', timeout: 3_000, windowsHide: true
      }).stdout.trim();
      const actual = JSON.parse(output) as { ExecutablePath?: string; StartedAt?: number; CommandLine?: string };
      return !!actual.ExecutablePath && canonicalPath(actual.ExecutablePath).toLowerCase() === expected.toLowerCase()
        && startedNear(actual.StartedAt ?? Number.NaN) && hasArgs(actual.CommandLine || '');
    }
  } catch { /* refuse to kill when ownership cannot be verified */ }
  return false;
}

function removeDetachedRecord(pid?: number): void {
  if (pid !== undefined) {
    const current = readDetachedRecord();
    if (current && current.pid !== pid) return;
  }
  try { unlinkSync(pidFile()); } catch { /* already gone */ }
}

async function waitForExit(pid: number, timeoutMs = STOP_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !processAlive(pid);
}

/**
 * Manages the DERO blockchain simulator (`derod-simulator`) as a child process.
 * The simulator is sourced from cmd/simulator in DEROFDN/derohe and is intended
 * to be either bundled in `resources/simulator/bin/` or provided by the user.
 *
 * Only one simulator instance can run at a time. stdout/stderr are logged.
 */
export class SimulatorManager {
  private proc: ChildProcess | null = null;
  private starting = false;
  private binaryPath: string | null = null;
  private args: string[] = [];
  private cwd: string | null = null;
  private startedAt: number | null = null;
  private exitCode: number | null = null;
  private lastError: string | null = null;
  private readonly onChange?: (status: SimulatorStatus) => void;

  constructor(onChange?: (status: SimulatorStatus) => void) {
    this.onChange = onChange;
  }

  /** Best-effort guess at where a usable simulator binary lives. */
  static detectBinaryPath(override?: string): string | null {
    const candidates: string[] = [];
    const appPath = process.env.HIVE_APP_ROOT || process.cwd();

    // 1. Explicit override.
    if (override && override.trim().length > 0) candidates.push(override.trim());

    // 2. Packaged or development resources.
    candidates.push(join(resourcesRoot, 'simulator', 'bin', DEFAULT_BIN_NAME));
    candidates.push(join(resourcesRoot, 'simulator', 'bin', SECONDARY_BIN_NAME));
    candidates.push(join(appPath, 'resources', 'simulator', 'bin', DEFAULT_BIN_NAME));
    candidates.push(join(appPath, 'resources', 'simulator', 'bin', SECONDARY_BIN_NAME));

    // 3. User-provided copy in Hive data.
    candidates.push(join(paths.userData, 'simulator', DEFAULT_BIN_NAME));
    candidates.push(join(paths.userData, 'simulator', SECONDARY_BIN_NAME));

    for (const p of candidates) {
      if (p && existsSync(p)) return p;
    }
    return null;
  }

  status(): SimulatorStatus {
    const detached = this.proc ? null : readDetachedRecord();
    const knownBinary = this.binaryPath && existsSync(this.binaryPath)
      ? this.binaryPath
      : detached?.binaryPath ?? SimulatorManager.detectBinaryPath();
    return {
      installed: knownBinary !== null,
      running: this.proc !== null || detached !== null,
      starting: this.starting,
      pid: this.proc?.pid ?? detached?.pid ?? null,
      binaryPath: this.binaryPath ?? detached?.binaryPath ?? null,
      args: this.proc ? this.args : detached?.args ?? this.args,
      cwd: this.proc ? this.cwd : detached?.cwd ?? this.cwd,
      startedAt: this.proc ? this.startedAt : detached?.startedAt ?? this.startedAt,
      exitCode: this.exitCode,
      error: this.lastError
    };
  }

  async start(options: SimulatorStartOptions = {}): Promise<SimulatorStatus> {
    if (this.starting || this.status().running) return this.status();

    const resolved = SimulatorManager.detectBinaryPath(options.binaryPath);
    this.binaryPath = resolved ? canonicalPath(resolved) : options.binaryPath?.trim() ? canonicalPath(options.binaryPath.trim()) : null;

    if (!this.binaryPath || !existsSync(this.binaryPath)) {
      this.lastError = `Simulator binary not found. Place "${DEFAULT_BIN_NAME}" in resources/simulator/bin (or set a custom path via SIMULATOR_START).`;
      this.emit();
      return this.status();
    }

    this.lastError = null;
    this.exitCode = null;
    this.starting = true;
    // Default to a writable data dir under userData. Note: cmd/simulator's
    // docopt usage has no "--simulator" flag; passing unknown flags makes it
    // print usage and exit immediately.
    const dataDir = join(paths.userData, 'simulator-data');
    try { mkdirSync(dataDir, { recursive: true }); } catch { /* best-effort */ }
    // Pin the local RPC port so the Studio health check and future structured
    // simulator operations have a stable, loopback-only endpoint.
    this.args = options.args ?? [`--data-dir=${dataDir}`, '--rpc-bind=127.0.0.1:20000'];
    this.cwd = options.cwd ?? dataDir;
    this.emit();

    logger.info('simulator', `starting ${this.binaryPath} ${this.args.join(' ')}`);

    if (options.detached) {
      if (!claimStartLock()) {
        this.lastError = 'Another simulator start is already in progress.';
        this.starting = false;
        this.emit();
        return this.status();
      }
      if (readDetachedRecord()) {
        releaseStartLock();
        this.starting = false;
        this.emit();
        return this.status();
      }
    }

    return new Promise<SimulatorStatus>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.lastError = `Simulator failed to start within ${START_TIMEOUT_MS}ms.`;
        this.starting = false;
        this.emit(resolve);
      }, START_TIMEOUT_MS);

      try {
        const child = spawn(this.binaryPath!, this.args, {
          cwd: this.cwd ?? undefined,
          env: simulatorEnvironment(options.env),
          detached: options.detached,
          windowsHide: true,
          stdio: options.detached ? 'ignore' : ['ignore', 'pipe', 'pipe']
        });

        this.proc = child;
        this.startedAt = Date.now();

        const onStream = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
          const data = chunk.toString('utf8');
          this.sendOutput(stream, data);
        };

        child.stdout?.on('data', onStream('stdout'));
        child.stderr?.on('data', onStream('stderr'));

        child.on('error', (err) => {
          logger.error('simulator', 'spawn error', err);
          this.lastError = err.message;
          this.proc = null;
          this.startedAt = null;
          if (options.detached) removeDetachedRecord(child.pid);
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            this.starting = false;
            this.emit(resolve);
          } else {
            this.emit();
          }
        });

        child.on('exit', (code, signal) => {
          logger.info('simulator', `exited code=${code} signal=${signal}`);
          this.exitCode = code;
          this.proc = null;
          this.startedAt = null;
          if (options.detached) removeDetachedRecord(child.pid);
          if (settled) {
            this.starting = false;
            this.emit();
          } else {
            settled = true;
            clearTimeout(timer);
            this.starting = false;
            // If it exited before we marked it started, it's a failure.
            if (code !== 0 && code !== null) {
              this.lastError = `Simulator exited with code ${code}`;
            }
            this.emit(resolve);
          }
        });

        if (!child.pid) {
          this.proc = null;
          throw new Error('Simulator process did not return a PID.');
        }
        if (options.detached) {
          try {
            writeFileSync(pidFile(), JSON.stringify({
              pid: child.pid,
              binaryPath: resolvePath(this.binaryPath!),
              args: this.args,
              cwd: this.cwd!,
              startedAt: this.startedAt
            } satisfies DetachedSimulatorRecord), { mode: 0o600 });
          } catch (error) {
            child.kill();
            this.proc = null;
            throw error;
          }
          child.unref();
          releaseStartLock();
        }

        // Once we've hooked everything up, declare "running" even if the
        // process hasn't emitted anything yet. We treat the child being alive
        // as success.
        settled = true;
        clearTimeout(timer);
        this.starting = false;
        this.emit(resolve);
      } catch (err) {
        if (options.detached) releaseStartLock();
        if (!settled) {
          settled = true;
          clearTimeout(timer);
        }
        this.lastError = err instanceof Error ? err.message : String(err);
        this.starting = false;
        this.emit(resolve);
      }
    });
  }

  async stop(): Promise<SimulatorStatus> {
    const detached = this.proc ? null : readDetachedRecord();
    if (!this.proc && !detached) {
      this.starting = false;
      this.emit();
      return this.status();
    }

    if (detached) {
      if (!sameProcess(detached)) {
        removeDetachedRecord(detached.pid);
        this.lastError = `Refused to stop PID ${detached.pid}: it is no longer the recorded simulator process.`;
        this.emit();
        return this.status();
      }

      this.lastError = null;
      try { process.kill(detached.pid, 'SIGTERM'); } catch { /* already gone */ }
      if (!await waitForExit(detached.pid) && sameProcess(detached)) {
        try { process.kill(detached.pid, 'SIGKILL'); } catch { /* already gone */ }
        await waitForExit(detached.pid, 1_000);
      }
      if (!processAlive(detached.pid)) removeDetachedRecord(detached.pid);
      else this.lastError = `Simulator PID ${detached.pid} did not stop.`;
      this.starting = false;
      this.emit();
      return this.status();
    }

    const proc = this.proc;
    try { proc!.kill('SIGTERM'); } catch { /* already gone */ }
    await waitForExit(proc!.pid!);

    if (this.proc) {
      try {
        this.proc.kill('SIGKILL');
      } catch {
        // ignore
      }
      this.proc = null;
      this.startedAt = null;
    }

    this.starting = false;
    this.emit();
    return this.status();
  }

  async restart(options: SimulatorStartOptions = {}): Promise<SimulatorStatus> {
    await this.stop();
    return this.start(options);
  }

  async health(): Promise<SimulatorHealth> {
    const endpoint = 'http://127.0.0.1:20000/json_rpc';
    if (!this.status().running) return { reachable: false, endpoint, error: 'Simulator is not running.' };
    const started = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3_000);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'dero-hive-health', method: 'DERO.Ping' }),
        signal: controller.signal
      });
      const body = await response.json() as { error?: { message?: string } };
      if (!response.ok || body.error) return { reachable: false, endpoint, latencyMs: Date.now() - started, error: body.error?.message || `HTTP ${response.status}` };
      return { reachable: true, endpoint, latencyMs: Date.now() - started };
    } catch (error) {
      return { reachable: false, endpoint, latencyMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timeout);
    }
  }

  async chainInfo(): Promise<SimulatorChainInfo> {
    if (!this.status().running) throw new Error('Simulator is not running.');
    const result = await this.callRpc<Record<string, unknown>>('DERO.GetInfo');
    const number = (key: string): number => typeof result[key] === 'number' ? result[key] : 0;
    const text = (key: string): string => typeof result[key] === 'string' ? result[key] : 'unknown';
    return {
      height: number('height'),
      topoHeight: number('topoheight'),
      network: text('network'),
      version: text('version'),
      txPoolSize: number('tx_pool_size'),
      status: text('status')
    };
  }

  async createFixtureWallet(): Promise<{ address: string; scid: string }> {
    if (!this.status().running) throw new Error('Simulator is not running.');
    const result = await this.callRpc<{ address?: string }>('DERO.GetRandomAddress');
    return { address: result.address || 'unknown', scid: '' };
  }

  async getContractState(scid: string, keys?: string[]): Promise<Record<string, unknown>> {
    if (!this.status().running) throw new Error('Simulator is not running.');
    const result = await this.callRpc<{ valuesstring?: string[]; stringkeys?: string[] }>('DERO.GetSC', { scid, keys });
    const state: Record<string, unknown> = {};
    if (result.stringkeys && result.valuesstring) {
      for (let i = 0; i < result.stringkeys.length; i++) {
        state[result.stringkeys[i]] = result.valuesstring[i];
      }
    }
    return state;
  }

  async getBalance(address: string, scid?: string): Promise<{ balance: number; scid?: string }> {
    if (!this.status().running) throw new Error('Simulator is not running.');
    const result = await this.callRpc<{ balance?: number; unlocked_balance?: number }>('DERO.GetEncryptedBalance', { address, scid });
    return { balance: result.balance ?? 0, scid };
  }

  async sendTransaction(txHex: string): Promise<{ txid: string }> {
    if (!this.status().running) throw new Error('Simulator is not running.');
    const result = await this.callRpc<{ txid?: string }>('DERO.SendTransaction', { tx_hex: txHex });
    return { txid: result.txid || 'unknown' };
  }

  async getTransaction(txid: string): Promise<Record<string, unknown>> {
    if (!this.status().running) throw new Error('Simulator is not running.');
    return this.callRpc<Record<string, unknown>>('DERO.GetTransaction', { txid });
  }

  async getHeight(): Promise<number> {
    if (!this.status().running) throw new Error('Simulator is not running.');
    const result = await this.callRpc<{ height?: number }>('DERO.GetHeight');
    return result.height ?? 0;
  }

  async listContracts(): Promise<Array<{ scid: string; height: number }>> {
    return [];
  }

  private async callRpc<T>(method: string, params?: unknown): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetch('http://127.0.0.1:20000/json_rpc', {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ jsonrpc: '2.0', id: 'dero-hive-simulator', method, ...(params === undefined ? {} : { params }) })
      });
      const body = await response.json() as { result?: T; error?: { message?: string } };
      if (!response.ok || body.error) throw new Error(body.error?.message || `Simulator RPC HTTP ${response.status}`);
      if (body.result === undefined) throw new Error('Simulator RPC response did not contain a result.');
      return body.result;
    } finally {
      clearTimeout(timeout);
    }
  }

  private sendOutput(stream: 'stdout' | 'stderr', data: string): void {
    logger.info('simulator', `[${stream}] ${data.trim()}`);
  }

  private emit(extra?: (s: SimulatorStatus) => void): void {
    const s = this.status();
    try {
      this.onChange?.(s);
    } catch (err) {
      logger.error('simulator', 'onChange handler threw', err);
    }
    if (extra) extra(s);
  }
}
