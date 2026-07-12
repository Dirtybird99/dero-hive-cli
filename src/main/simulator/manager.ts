import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../utils/logger';
import { paths } from '../utils/paths';
import { resourcesRoot } from '../utils/paths';
import type { SimulatorChainInfo, SimulatorHealth, SimulatorStatus, SimulatorStartOptions } from '@shared/types';

const DEFAULT_BIN_NAME = process.platform === 'win32' ? 'derod-simulator.exe' : 'derod-simulator';
const SECONDARY_BIN_NAME = process.platform === 'win32' ? 'simulator.exe' : 'simulator';
const START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 8_000;

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
    const knownBinary = this.binaryPath && existsSync(this.binaryPath)
      ? this.binaryPath
      : SimulatorManager.detectBinaryPath();
    return {
      installed: knownBinary !== null,
      running: this.proc !== null,
      starting: this.starting,
      pid: this.proc?.pid ?? null,
      binaryPath: this.binaryPath,
      args: this.args,
      cwd: this.cwd,
      startedAt: this.startedAt,
      exitCode: this.exitCode,
      error: this.lastError
    };
  }

  async start(options: SimulatorStartOptions = {}): Promise<SimulatorStatus> {
    if (this.proc || this.starting) return this.status();

    const resolved = SimulatorManager.detectBinaryPath(options.binaryPath);
    this.binaryPath = resolved ?? options.binaryPath?.trim() ?? null;

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
          env: { ...process.env, ...(options.env ?? {}) },
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
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
        });

        child.on('exit', (code, signal) => {
          logger.info('simulator', `exited code=${code} signal=${signal}`);
          this.exitCode = code;
          this.proc = null;
          this.startedAt = null;
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

        // Once we've hooked everything up, declare "running" even if the
        // process hasn't emitted anything yet. We treat the child being alive
        // as success.
        settled = true;
        clearTimeout(timer);
        this.starting = false;
        this.emit(resolve);
      } catch (err) {
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
    if (!this.proc) {
      this.starting = false;
      this.emit();
      return this.status();
    }

    const proc = this.proc;
    const exited = new Promise<void>((resolve) => {
      if (!proc) return resolve();
      proc.once('exit', () => resolve());
      try {
        if (process.platform === 'win32') {
          // Try graceful, then force.
          proc.kill();
        } else {
          proc.kill('SIGTERM');
        }
      } catch {
        // already gone
        resolve();
      }
    });

    const timeout = new Promise<void>((resolve) => setTimeout(resolve, STOP_TIMEOUT_MS));

    await Promise.race([exited, timeout]);

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
    if (!this.proc) return { reachable: false, endpoint, error: 'Simulator is not running.' };
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
    if (!this.proc) throw new Error('Simulator is not running.');
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
    if (!this.proc) throw new Error('Simulator is not running.');
    const result = await this.callRpc<{ address?: string }>('DERO.GetRandomAddress');
    return { address: result.address || 'unknown', scid: '' };
  }

  async getContractState(scid: string, keys?: string[]): Promise<Record<string, unknown>> {
    if (!this.proc) throw new Error('Simulator is not running.');
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
    if (!this.proc) throw new Error('Simulator is not running.');
    const result = await this.callRpc<{ balance?: number; unlocked_balance?: number }>('DERO.GetEncryptedBalance', { address, scid });
    return { balance: result.balance ?? 0, scid };
  }

  async sendTransaction(txHex: string): Promise<{ txid: string }> {
    if (!this.proc) throw new Error('Simulator is not running.');
    const result = await this.callRpc<{ txid?: string }>('DERO.SendTransaction', { tx_hex: txHex });
    return { txid: result.txid || 'unknown' };
  }

  async getTransaction(txid: string): Promise<Record<string, unknown>> {
    if (!this.proc) throw new Error('Simulator is not running.');
    return this.callRpc<Record<string, unknown>>('DERO.GetTransaction', { txid });
  }

  async getHeight(): Promise<number> {
    if (!this.proc) throw new Error('Simulator is not running.');
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
