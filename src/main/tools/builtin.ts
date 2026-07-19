import type { ToolDefinition, MediaKind, MediaGenerationRequest } from '@shared/types';
import { readFile, writeFile, readdir, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { lookup } from 'node:dns/promises';
import type { LookupFunction } from 'node:net';
import ipaddr from 'ipaddr.js';
import fg from 'fast-glob';
import { Agent } from 'undici';
import { resolveAndValidate } from '../utils/pathPolicy';
import type { ToolExecutor, ToolContext, ToolResult } from './registry';
import { getMediaManager } from '../media/instance';
import { getSimulatorManager } from '../simulator/instance';
import { getXswdManager } from '../xswd/instance';
import { lintDvmBasic } from '@shared/dvm';
import type { IndexQuery } from '@shared/gnomon';
import { diffLines, diffCounts } from '@shared/diff';

const SHELL_MAX_BUFFER_BYTES = 1024 * 1024;
const SHELL_OUTPUT_BYTES = 50_000;
const SHELL_TASKKILL_TIMEOUT_MS = 5_000;
const SHELL_CLOSE_GRACE_MS = 1_000;

type ShellStopReason = 'cancelled' | 'timeout' | 'maxBuffer';

interface ShellOutcome {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  stopReason?: ShellStopReason;
  error?: Error;
}

interface ShellProcessHooks {
  platform: NodeJS.Platform;
  spawnShell: (command: string, options: SpawnOptions) => ChildProcess;
  spawnTaskkill: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  taskkillTimeoutMs: number;
  closeGraceMs: number;
}

const defaultShellProcessHooks: ShellProcessHooks = {
  platform: process.platform,
  spawnShell: (command, options) => spawn(command, options),
  spawnTaskkill: (command, args, options) => spawn(command, args, options),
  taskkillTimeoutMs: SHELL_TASKKILL_TIMEOUT_MS,
  closeGraceMs: SHELL_CLOSE_GRACE_MS
};
let shellProcessHooks = defaultShellProcessHooks;

/** Test seam for process lifecycle failures that cannot be produced reliably on every OS. */
export function __setShellProcessHooksForTest(hooks: Partial<ShellProcessHooks> | null): void {
  shellProcessHooks = hooks ? { ...defaultShellProcessHooks, ...hooks } : defaultShellProcessHooks;
}

function tryKillChild(child: ChildProcess): boolean {
  try { return child.kill('SIGKILL'); } catch { return false; }
}

function killProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid) return Promise.reject(new Error('Cannot terminate process tree: child PID is unavailable.'));

  if (shellProcessHooks.platform !== 'win32') {
    try { process.kill(-pid, 'SIGKILL'); }
    catch (error) {
      tryKillChild(child);
      return Promise.reject(new Error(`Failed to terminate process group ${pid}.`, { cause: error }));
    }
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    let killer: ChildProcess;
    try {
      killer = shellProcessHooks.spawnTaskkill('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      });
    } catch (error) {
      tryKillChild(child);
      reject(new Error(`Failed to start taskkill for process tree ${pid}.`, { cause: error }));
      return;
    }
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      tryKillChild(killer);
      tryKillChild(child);
      finish(new Error(`taskkill did not settle within ${shellProcessHooks.taskkillTimeoutMs}ms for process tree ${pid}.`));
    }, shellProcessHooks.taskkillTimeoutMs);
    killer.once('error', (error) => {
      tryKillChild(child);
      finish(new Error(`taskkill failed for process tree ${pid}: ${error.message}`, { cause: error }));
    });
    killer.once('close', (code, signal) => {
      if (code === 0) finish();
      else {
        tryKillChild(child);
        finish(new Error(`taskkill failed for process tree ${pid} (exit ${code ?? 'unknown'}${signal ? `, signal ${signal}` : ''}).`));
      }
    });
  });
}

function runShellProcess(command: string, cwd: string, timeout: number, signal?: AbortSignal): Promise<ShellOutcome> {
  return new Promise((resolve) => {
    const child = shellProcessHooks.spawnShell(command, {
      cwd,
      shell: shellProcessHooks.platform === 'win32' ? 'powershell.exe' : '/bin/sh',
      detached: shellProcessHooks.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let totalBytes = 0;
    let stopReason: ShellStopReason | undefined;
    let termination: Promise<void> | undefined;
    let spawnError: Error | undefined;
    let closeSeen = false;
    let closeCode: number | null = null;
    let closeSignal: NodeJS.Signals | null = null;
    let settled = false;
    let resolveClosed!: () => void;
    const closed = new Promise<void>((done) => { resolveClosed = done; });

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (!closeSeen) {
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref?.();
      }
      resolve({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        code: closeCode,
        signal: closeSignal,
        stopReason,
        error: error ?? spawnError
      });
    };

    const settleStoppedProcess = async (): Promise<void> => {
      let terminationError: Error | undefined;
      try { await termination; }
      catch (error) { terminationError = error instanceof Error ? error : new Error(String(error)); }
      if (!closeSeen) {
        let graceTimer!: NodeJS.Timeout;
        await Promise.race([
          closed,
          new Promise<void>((done) => { graceTimer = setTimeout(done, shellProcessHooks.closeGraceMs); })
        ]);
        clearTimeout(graceTimer);
      }
      if (!closeSeen) {
        tryKillChild(child);
        terminationError ??= new Error(`Process did not close within ${shellProcessHooks.closeGraceMs}ms after tree termination.`);
      }
      finish(terminationError);
    };

    const stop = (reason: ShellStopReason): void => {
      if (stopReason) return;
      stopReason = reason;
      termination = killProcessTree(child);
      void settleStoppedProcess();
    };
    const capture = (target: Buffer[], retained: number, chunk: Buffer): number => {
      totalBytes += chunk.byteLength;
      if (retained < SHELL_OUTPUT_BYTES) {
        const kept = chunk.subarray(0, SHELL_OUTPUT_BYTES - retained);
        target.push(kept);
        retained += kept.byteLength;
      }
      if (totalBytes > SHELL_MAX_BUFFER_BYTES) stop('maxBuffer');
      return retained;
    };
    const onAbort = (): void => stop('cancelled');
    const timer = setTimeout(() => stop('timeout'), timeout);

    child.stdout?.on('data', (chunk: Buffer) => { stdoutBytes = capture(stdout, stdoutBytes, chunk); });
    child.stderr?.on('data', (chunk: Buffer) => { stderrBytes = capture(stderr, stderrBytes, chunk); });
    child.once('error', (error) => {
      spawnError = error;
      finish(error);
    });
    child.once('close', (code, exitSignal) => {
      closeSeen = true;
      closeCode = code;
      closeSignal = exitSignal;
      resolveClosed();
      if (!stopReason) finish();
    });

    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function shellOutput(stdout: string, stderr: string): string {
  return `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ''}`.trim();
}

function cappedShellResult(prefix: string, output = '', detail = ''): string {
  return [prefix, output, detail].filter(Boolean).join('\n').trim().slice(0, SHELL_OUTPUT_BYTES);
}

function safeResolve(p: string, cwd: string): string {
  return resolveAndValidate(p, cwd);
}

// Capture a bounded before/after snapshot of a file edit so the renderer can
// render a terminal-style diff. We cap each side at ~50KB so very large files
// don't bloat the IPC payload — anything over the cap is truncated with a
// marker the UI can show. The numbers are intentionally generous because the
// diff is the most useful signal in the activity log.
const DIFF_SNAPSHOT_MAX_BYTES = 50_000;
const MAX_READ_FILE_BYTES = 10 * 1024 * 1024;
const MAX_BASE64_FILE_BYTES = 5 * 1024 * 1024;
const MAX_FILE_WRITE_BYTES = 5 * 1024 * 1024;
const MAX_TOOL_TEXT_BYTES = 200_000;
const MAX_GREP_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SIMULATOR_RPC_BYTES = 1024 * 1024;
const GREP_REGEX_TIMEOUT_MS = 5_000;

interface RegexWorkerSession {
  search(text: string, limit: number): Promise<number[]>;
  close(): Promise<void>;
}

function startRegexWorker(pattern: string, signal?: AbortSignal): RegexWorkerSession {
  const worker = new Worker(`
const { parentPort, workerData } = require('node:worker_threads');
const expression = new RegExp(workerData.pattern, 'm');
parentPort.on('message', ({ id, text, limit }) => {
  const lines = text.split('\\n');
  const matches = [];
  for (let index = 0; index < lines.length && matches.length < limit; index++) {
    expression.lastIndex = 0;
    if (expression.test(lines[index])) matches.push(index);
  }
  parentPort.postMessage({ id, matches });
});
`, { eval: true, workerData: { pattern } });
  let sequence = 0;
  let pending: { id: number; resolve(value: number[]): void; reject(error: Error): void } | null = null;
  let failure: Error | null = null;
  let closed = false;
  const fail = (error: Error): void => {
    failure ||= error;
    if (pending) {
      const active = pending;
      pending = null;
      active.reject(failure);
    }
  };
  const onAbort = (): void => {
    fail(new Error('Search cancelled.'));
    void worker.terminate();
  };
  const timer = setTimeout(() => {
    fail(new Error(`Regular-expression search exceeded ${GREP_REGEX_TIMEOUT_MS}ms.`));
    void worker.terminate();
  }, GREP_REGEX_TIMEOUT_MS);
  timer.unref?.();
  worker.on('message', (message: { id: number; matches: number[] }) => {
    if (!pending || pending.id !== message.id) return;
    const active = pending;
    pending = null;
    active.resolve(message.matches);
  });
  worker.once('error', (error) => fail(error));
  worker.once('exit', (code) => {
    if (!closed && code !== 0 && !failure) fail(new Error(`Regular-expression worker exited with code ${code}.`));
  });
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();

  return {
    search(text, limit) {
      if (failure) return Promise.reject(failure);
      if (pending) return Promise.reject(new Error('Regular-expression worker is already busy.'));
      const id = ++sequence;
      return new Promise<number[]>((resolve, reject) => {
        pending = { id, resolve, reject };
        worker.postMessage({ id, text, limit });
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fail(new Error('Regular-expression worker closed.'));
      await worker.terminate();
    }
  };
}

function simulatorRpcEndpoint(): string {
  const configured = process.env.HIVE_SIMULATOR_RPC_URL?.trim();
  if (!configured) return 'http://127.0.0.1:20000/json_rpc';
  const url = new URL(configured);
  if (url.protocol !== 'http:' || url.username || url.password || !['127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('HIVE_SIMULATOR_RPC_URL must be an unauthenticated numeric loopback HTTP URL.');
  }
  return url.toString();
}

function boundedText(text: string, maxBytes = MAX_TOOL_TEXT_BYTES): { text: string; truncated: boolean } {
  const encoded = Buffer.from(text, 'utf8');
  if (encoded.length <= maxBytes) return { text, truncated: false };
  return { text: encoded.subarray(0, maxBytes).toString('utf8').replace(/\uFFFD$/u, ''), truncated: true };
}

function unsafeSearchPattern(pattern: string): boolean {
  return pattern.length > 500
    || /\\[1-9]/u.test(pattern)
    || /\((?:[^()\\]|\\.)*[*+{](?:[^()\\]|\\.)*\)\s*[*+{]/u.test(pattern);
}

function snapshotForDiff(content: string): { text: string; truncated: boolean } {
  if (content.length <= DIFF_SNAPSHOT_MAX_BYTES) return { text: content, truncated: false };
  return {
    text: content.slice(0, DIFF_SNAPSHOT_MAX_BYTES),
    truncated: true
  };
}

const READ_FILE_DEF: ToolDefinition = {
  name: 'read_file',
  description: 'Read the contents of a file. Returns text, or base64 for binary files. Supports line ranges.',
  source: 'builtin',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or working-directory-relative path' },
      start_line: { type: 'integer', description: '1-based start line (optional)' },
      end_line: { type: 'integer', description: '1-based end line (optional, inclusive)' },
      encoding: { type: 'string', enum: ['utf-8', 'base64'], description: 'Default utf-8; use base64 for binaries' }
    },
    required: ['path']
  }
};

const WRITE_FILE_DEF: ToolDefinition = {
  name: 'write_file',
  description: 'Write content to a file, creating parent directories as needed. Overwrites existing files.',
  source: 'builtin',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      content: { type: 'string' }
    },
    required: ['path', 'content']
  }
};

const EDIT_FILE_DEF: ToolDefinition = {
  name: 'edit_file',
  description: 'Replace exact text in a file. old_text must match uniquely.',
  source: 'builtin',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      old_text: { type: 'string', description: 'Exact text to replace' },
      new_text: { type: 'string' }
    },
    required: ['path', 'old_text', 'new_text']
  }
};

const LIST_DIR_DEF: ToolDefinition = {
  name: 'list_directory',
  description: 'List files and subdirectories in a directory.',
  source: 'builtin',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path']
  }
};

const GLOB_DEF: ToolDefinition = {
  name: 'glob_files',
  description: 'Find files matching a glob pattern. Example: "src/**/*.ts".',
  source: 'builtin',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string' },
      cwd: { type: 'string' },
      ignore: { type: 'array', items: { type: 'string' } }
    },
    required: ['pattern']
  }
};

const GREP_DEF: ToolDefinition = {
  name: 'grep_files',
  description: 'Search for a regex pattern across files. Returns file:line:content matches.',
  source: 'builtin',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string' },
      cwd: { type: 'string' },
      include: { type: 'string', description: 'Glob filter, e.g. "*.ts"' },
      ignore: { type: 'array', items: { type: 'string' } },
      max_results: { type: 'integer', default: 100 }
    },
    required: ['pattern']
  }
};

const SHELL_DEF: ToolDefinition = {
  name: 'run_shell',
  description: 'Execute a shell command. Output is captured stdout+stderr. Use with care.',
  source: 'builtin',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      cwd: { type: 'string' },
      timeout_ms: { type: 'integer', minimum: 100, maximum: 300_000, default: 30_000 }
    },
    required: ['command']
  }
};

const WEB_FETCH_DEF: ToolDefinition = {
  name: 'web_fetch',
  description: 'Fetch a public web page or API over HTTP(S) and return its text. HTML is reduced to readable text. Blocks localhost and private/internal addresses.',
  source: 'builtin',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Absolute http(s) URL to fetch.' },
      max_bytes: { type: 'integer', description: 'Maximum characters of body text to return (default 100000).' }
    },
    required: ['url']
  }
};

const WEB_SEARCH_DEF: ToolDefinition = {
  name: 'web_search',
  description: 'Search the web and return ranked results (title, url, snippet). Uses a configured provider (HIVE_SEARCH_API_KEY) when set, otherwise a keyless fallback.',
  source: 'builtin',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query.' },
      count: { type: 'integer', description: 'Number of results to return (default 5, max 10).' }
    },
    required: ['query']
  }
};

const TODO_DEF: ToolDefinition = {
  name: 'todo_write',
  description: 'Maintain a structured task list. Use for multi-step work to track progress.',
  source: 'builtin',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string' },
            status: { enum: ['pending', 'in_progress', 'completed'] },
            active_form: { type: 'string' }
          },
          required: ['content', 'status']
        }
      }
    },
    required: ['todos']
  }
};

const DVM_LINT_DEF: ToolDefinition = {
  name: 'lint_dvm_basic',
  description: 'Run deterministic structural checks on DERO DVM-BASIC source. Read-only; this is not a compiler, so use a simulator or daemon gas estimate to confirm execution validity.',
  source: 'builtin',
  parameters: {
    type: 'object',
    properties: { source: { type: 'string', description: 'Complete DVM-BASIC smart-contract source code' } },
    required: ['source']
  }
};

const SIMULATOR_INFO_DEF: ToolDefinition = {
  name: 'get_simulator_chain_info',
  description: 'Read the local DERO simulator chain state from its loopback-only RPC endpoint (127.0.0.1:20000). Read-only; returns an error if the simulator is not running.',
  source: 'builtin',
  parameters: { type: 'object', properties: {} }
};

const SIMULATOR_CREATE_WALLET_DEF: ToolDefinition = {
  name: 'simulator_create_wallet',
  description: 'Create a new fixture wallet on the DERO simulator and return its address.',
  source: 'builtin',
  parameters: { type: 'object', properties: {} }
};

const SIMULATOR_GET_BALANCE_DEF: ToolDefinition = {
  name: 'simulator_get_balance',
  description: 'Get the encrypted balance for an address on the simulator.',
  source: 'builtin',
  parameters: {
    type: 'object',
    properties: {
      address: { type: 'string', description: 'DERO address (dero1...) to check balance for.' },
      scid: { type: 'string', description: 'Optional SCID to check token balance; omit for native DERO.' }
    }
  }
};

const SIMULATOR_GET_CONTRACT_STATE_DEF: ToolDefinition = {
  name: 'simulator_get_contract_state',
  description: 'Read smart contract storage state from the simulator by SCID and optional keys.',
  source: 'builtin',
  parameters: {
    type: 'object',
    properties: {
      scid: { type: 'string', description: 'Smart Contract ID (64-char hex).' },
      keys: { type: 'string', description: 'Comma-separated storage key names to read; omit for all keys.' }
    }
  }
};

const SIMULATOR_GET_HEIGHT_DEF: ToolDefinition = {
  name: 'simulator_get_height',
  description: 'Get the current block height of the running simulator.',
  source: 'builtin',
  parameters: { type: 'object', properties: {} }
};

const GENERATE_IMAGE_DEF: ToolDefinition = {
  name: 'generate_image',
  description: 'Generate an image from a text prompt and save it for the user. Use this whenever the user asks you to create, draw, or make an image/picture/illustration.',
  source: 'builtin',
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'A detailed description of the image to generate.' },
      aspect: { type: 'string', enum: ['square', 'portrait', 'landscape'], description: 'Aspect ratio. Default square.' }
    },
    required: ['prompt']
  }
};

const GENERATE_AUDIO_DEF: ToolDefinition = {
  name: 'generate_audio',
  description: 'Generate spoken audio (text-to-speech) from text and save it for the user. Use when the user asks you to say something aloud, narrate, or produce a voiceover.',
  source: 'builtin',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The text to speak.' },
      voice: { type: 'string', description: 'Optional voice name (e.g. alloy, nova) or ElevenLabs voice id.' }
    },
    required: ['text']
  }
};

const GENERATE_VIDEO_DEF: ToolDefinition = {
  name: 'generate_video',
  description: 'Generate a short video from a text prompt and save it for the user. Requires a dedicated video-capable media provider (e.g. Replicate or ComfyUI).',
  source: 'builtin',
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'A description of the video to generate.' },
      duration_seconds: { type: 'integer', description: 'Clip length in seconds (default 5).' }
    },
    required: ['prompt']
  }
};

const GENERATE_DVM_CONTRACT_DEF: ToolDefinition = {
  name: 'generate_dvm_contract',
  description: 'Generate a complete DVM-BASIC smart contract from a plain-language specification. The model should provide a detailed brief describing actors, assets, state variables, access rules, functions, failure cases, and test scenarios. This tool validates the structure with the DVM linter.',
  source: 'builtin',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Contract name (PascalCase, e.g. "Token", "Lottery", "Vault").' },
      brief: { type: 'string', description: 'Detailed contract specification: actors, state, access rules, functions, failure modes, and test cases.' }
    },
    required: ['name', 'brief']
  }
};

const AUDIT_DVM_CONTRACT_DEF: ToolDefinition = {
  name: 'audit_dvm_contract',
  description: 'Run a comprehensive DERO DVM-BASIC security audit against a fixed checklist. Reviews access control, fund safety, state integrity, reentrancy, overflow, initialization, denial-of-service, and privacy. Returns findings with severity, affected lines, exploit paths, and remediations.',
  source: 'builtin',
  parameters: {
    type: 'object',
    properties: {
      source: { type: 'string', description: 'Full DVM-BASIC contract source code to audit.' },
      contractName: { type: 'string', description: 'Optional contract name for context.' }
    },
    required: ['source']
  }
};

const GENERATE_TELA_DAPP_DEF: ToolDefinition = {
  name: 'generate_tela_dapp',
  description: 'Scaffold a complete TELA dApp project including DVM-BASIC contract, HTML/CSS/JS frontend, XSWD wallet connection, mock fixtures, and deployment manifest.',
  source: 'builtin',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'dApp name (used as directory name and contract name).' },
      description: { type: 'string', description: 'Brief description of what the dApp does.' }
    },
    required: ['name', 'description']
  }
};

const DISCOVER_CONTRACTS_DEF: ToolDefinition = {
  name: 'discover_contracts',
  description: 'Discover DERO smart contracts indexed by Gnomon. Search by function name, similarity, transaction history, or TELA apps. Results include SCID, deployment height, functions, and related contracts.',
  source: 'builtin',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query: a function name, SCID, or keyword to find related contracts.' },
      kind: { type: 'string', description: 'Search kind: similar-contracts, by-function, by-transaction, or tela-apps. Default: similar-contracts.' }
    }
  }
};

const WALLET_ADDRESS_DEF: ToolDefinition = {
  name: 'dero_wallet_address',
  description: 'Get the receiving address of the user\'s connected DERO wallet (via XSWD). Requires the XSWD wallet connection to be enabled.',
  source: 'builtin',
  parameters: { type: 'object', properties: {} }
};

const WALLET_BALANCE_DEF: ToolDefinition = {
  name: 'dero_wallet_balance',
  description: 'Get the balance of the user\'s connected DERO wallet (via XSWD). Amounts are atomic units: 1 DERO = 100000.',
  source: 'builtin',
  parameters: {
    type: 'object',
    properties: {
      scid: { type: 'string', description: 'Token SCID (64-hex) to query a token balance; omit for native DERO.' }
    }
  }
};

const WALLET_HEIGHT_DEF: ToolDefinition = {
  name: 'dero_wallet_height',
  description: 'Get the current block height as seen by the user\'s connected DERO wallet (via XSWD).',
  source: 'builtin',
  parameters: { type: 'object', properties: {} }
};

const WALLET_HISTORY_DEF: ToolDefinition = {
  name: 'dero_wallet_history',
  description: 'List transaction entries from the user\'s connected DERO wallet (via XSWD). Amounts are atomic units: 1 DERO = 100000.',
  source: 'builtin',
  parameters: {
    type: 'object',
    properties: {
      in: { type: 'boolean', description: 'Include incoming entries. Default true.' },
      out: { type: 'boolean', description: 'Include outgoing entries. Default true.' },
      coinbase: { type: 'boolean', description: 'Include coinbase entries. Default false.' },
      min_height: { type: 'integer', description: 'Only entries at or above this height.' },
      max_height: { type: 'integer', description: 'Only entries at or below this height.' }
    }
  }
};

const WALLET_TRANSFER_DEF: ToolDefinition = {
  name: 'dero_wallet_transfer',
  description: 'Send DERO (or a token) from the user\'s connected wallet via XSWD. amount is in atomic units: 1 DERO = 100000. The user\'s wallet will show its own confirmation dialog before broadcasting.',
  source: 'builtin',
  parameters: {
    type: 'object',
    properties: {
      destination: { type: 'string', description: 'Destination DERO address (dero1... / deto1...).' },
      amount: { type: 'integer', description: 'Amount in atomic units (1 DERO = 100000). Must be a positive integer.' },
      scid: { type: 'string', description: 'Token SCID (64-hex) to send a token instead of native DERO.' },
      ringsize: { type: 'integer', description: 'Anonymity ring size (power of 2, 2-128). Default 16.' }
    },
    required: ['destination', 'amount']
  }
};

const WALLET_SCINVOKE_DEF: ToolDefinition = {
  name: 'dero_wallet_scinvoke',
  description: 'Invoke a DERO smart contract entrypoint from the user\'s connected wallet via XSWD. Contract deposits are burn semantics and use atomic units: 1 DERO = 100000. Hive and the wallet both require approval.',
  source: 'builtin',
  parameters: {
    type: 'object',
    properties: {
      scid: { type: 'string', description: 'Smart contract ID (64-hex).' },
      entrypoint: { type: 'string', description: 'Contract function name to invoke.' },
      parameters: {
        type: 'array',
        description: 'Additional entrypoint arguments.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Argument name.' },
            datatype: { type: 'string', enum: ['S', 'U'], description: 'S = string, U = uint64.' },
            value: { description: 'Argument value (string or integer to match datatype).' }
          },
          required: ['name', 'datatype', 'value']
        }
      },
      sc_dero_deposit: { type: 'integer', description: 'DERO burned/deposited into the contract, atomic units. Default 0.' },
      sc_token_deposit: { type: 'integer', description: 'Token amount burned/deposited into the contract, atomic units. Default 0.' },
      ringsize: { type: 'integer', description: 'Anonymity ring size. Default 2.' }
    },
    required: ['scid', 'entrypoint']
  }
};

export const BUILTIN_TOOLS: ToolDefinition[] = [
  READ_FILE_DEF, WRITE_FILE_DEF, EDIT_FILE_DEF,
  LIST_DIR_DEF, GLOB_DEF, GREP_DEF,
  SHELL_DEF, WEB_FETCH_DEF, WEB_SEARCH_DEF, TODO_DEF, DVM_LINT_DEF, SIMULATOR_INFO_DEF,
  SIMULATOR_CREATE_WALLET_DEF, SIMULATOR_GET_BALANCE_DEF, SIMULATOR_GET_CONTRACT_STATE_DEF, SIMULATOR_GET_HEIGHT_DEF,
  GENERATE_IMAGE_DEF, GENERATE_AUDIO_DEF, GENERATE_VIDEO_DEF,
  GENERATE_DVM_CONTRACT_DEF,
  AUDIT_DVM_CONTRACT_DEF,
  GENERATE_TELA_DAPP_DEF,
  DISCOVER_CONTRACTS_DEF,
  WALLET_ADDRESS_DEF, WALLET_BALANCE_DEF, WALLET_HEIGHT_DEF, WALLET_HISTORY_DEF,
  WALLET_TRANSFER_DEF, WALLET_SCINVOKE_DEF
];

const ATOMIC_PER_DERO = 100000;
const SCID_RE = /^[0-9a-fA-F]{64}$/;

function xswdOffline(): ToolResult {
  return {
    content: 'XSWD wallet is not connected. Ask the user to enable it: press Alt+X or run /xswd on. A DERO wallet with XSWD enabled (Engram, derotui, HOLOGRAM) must be running at ws://127.0.0.1:44326/xswd.',
    isError: true
  };
}

function connectedXswd(): ReturnType<typeof getXswdManager> {
  const mgr = getXswdManager();
  if (!mgr || mgr.status().state !== 'connected') return null;
  return mgr;
}

export const builtinExecutors: Record<string, ToolExecutor> = {
  async dero_wallet_address() {
    const mgr = connectedXswd();
    if (!mgr) return xswdOffline();
    try {
      const address = await mgr.getAddress();
      return { content: `Wallet address: ${address}`, meta: { address } };
    } catch (err) {
      return { content: `Wallet address lookup failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  },

  async dero_wallet_balance(args) {
    const mgr = connectedXswd();
    if (!mgr) return xswdOffline();
    const scid = typeof args.scid === 'string' && args.scid.trim() ? args.scid.trim() : undefined;
    if (scid && !SCID_RE.test(scid)) return { content: 'scid must be a 64-character hex string.', isError: true };
    try {
      const b = await mgr.getBalance(scid);
      const dero = (b.unlocked_balance / ATOMIC_PER_DERO).toFixed(5);
      return {
        content: `Balance: ${b.balance} atomic units (unlocked ${b.unlocked_balance}) = ${dero} DERO unlocked${scid ? ` for token ${scid}` : ''}`,
        meta: b
      };
    } catch (err) {
      return { content: `Wallet balance lookup failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  },

  async dero_wallet_height() {
    const mgr = connectedXswd();
    if (!mgr) return xswdOffline();
    try {
      const height = await mgr.getHeight();
      return { content: `Wallet block height: ${height}`, meta: { height } };
    } catch (err) {
      return { content: `Wallet height lookup failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  },

  async dero_wallet_history(args) {
    const mgr = connectedXswd();
    if (!mgr) return xswdOffline();
    try {
      const result = await mgr.getTransfers({
        in: typeof args.in === 'boolean' ? args.in : true,
        out: typeof args.out === 'boolean' ? args.out : true,
        coinbase: typeof args.coinbase === 'boolean' ? args.coinbase : false,
        ...(typeof args.min_height === 'number' ? { min_height: args.min_height } : {}),
        ...(typeof args.max_height === 'number' ? { max_height: args.max_height } : {})
      });
      const count = result.entries.length;
      return {
        content: count === 0
          ? 'No matching wallet transactions.'
          : `${count} wallet transaction(s):\n${JSON.stringify(result.entries, null, 2)}`,
        meta: { count }
      };
    } catch (err) {
      return { content: `Wallet history lookup failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  },

  async dero_wallet_transfer(args) {
    const mgr = connectedXswd();
    if (!mgr) return xswdOffline();
    const { destination, amount } = args as { destination?: unknown; amount?: unknown };
    if (!destination || typeof destination !== 'string') return { content: 'destination is required.', isError: true };
    if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) {
      return { content: 'amount must be a positive integer in atomic units (1 DERO = 100000).', isError: true };
    }
    const scid = typeof args.scid === 'string' && args.scid.trim() ? args.scid.trim() : undefined;
    if (scid && !SCID_RE.test(scid)) return { content: 'scid must be a 64-character hex string.', isError: true };
    try {
      const { txid } = await mgr.transfer({
        destination,
        amount,
        scid,
        ringsize: typeof args.ringsize === 'number' ? args.ringsize : undefined
      });
      return { content: `Transaction submitted. TXID: ${txid}`, meta: { txid } };
    } catch (err) {
      return { content: `Transfer failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  },

  async dero_wallet_scinvoke(args) {
    const mgr = connectedXswd();
    if (!mgr) return xswdOffline();
    const { scid, entrypoint } = args as { scid?: unknown; entrypoint?: unknown };
    if (!scid || typeof scid !== 'string' || !SCID_RE.test(scid)) {
      return { content: 'scid is required and must be a 64-character hex string.', isError: true };
    }
    if (!entrypoint || typeof entrypoint !== 'string') return { content: 'entrypoint is required.', isError: true };
    const rawParams = Array.isArray(args.parameters) ? args.parameters : [];
    const parameters: Array<{ name: string; datatype: 'S' | 'U'; value: string | number }> = [];
    for (const p of rawParams) {
      const item = p as { name?: unknown; datatype?: unknown; value?: unknown };
      if (typeof item.name !== 'string' || (item.datatype !== 'S' && item.datatype !== 'U')) {
        return { content: 'each parameter needs a name and a datatype of S or U.', isError: true };
      }
      if (item.datatype === 'U' && typeof item.value !== 'number') {
        return { content: `parameter ${item.name} has datatype U and needs an integer value.`, isError: true };
      }
      parameters.push({ name: item.name, datatype: item.datatype, value: item.value as string | number });
    }
    try {
      const { txid } = await mgr.scinvoke({
        scid,
        entrypoint,
        parameters,
        sc_dero_deposit: typeof args.sc_dero_deposit === 'number' ? args.sc_dero_deposit : undefined,
        sc_token_deposit: typeof args.sc_token_deposit === 'number' ? args.sc_token_deposit : undefined,
        ringsize: typeof args.ringsize === 'number' ? args.ringsize : undefined
      });
      return { content: `Contract call submitted. TXID: ${txid}`, meta: { txid } };
    } catch (err) {
      return { content: `Contract invocation failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  },

  async read_file(args, ctx: ToolContext) {
    const { path, start_line, end_line, encoding } = args as { path: string; start_line?: number; end_line?: number; encoding?: 'utf-8' | 'base64' };
    const abs = safeResolve(path, ctx.cwd);
    if (!existsSync(abs)) return { content: `Error: file not found: ${abs}`, isError: true };

    const enc = encoding || 'utf-8';
    const size = (await stat(abs)).size;
    if (enc === 'base64') {
      if (size > MAX_BASE64_FILE_BYTES) return { content: `Error: base64 reads are limited to ${MAX_BASE64_FILE_BYTES} bytes.`, isError: true };
      const buf = await readFile(abs);
      return { content: buf.toString('base64') };
    }
    if (size > MAX_READ_FILE_BYTES) return { content: `Error: text reads are limited to ${MAX_READ_FILE_BYTES} bytes. Use a narrower external tool.`, isError: true };
    const text = await readFile(abs, 'utf-8');
    const lines = text.split('\n');
    if (start_line || end_line) {
      const start = (start_line || 1) - 1;
      const end = end_line || lines.length;
      const selected = boundedText(lines.slice(start, end).join('\n'));
      return {
        content: selected.text + (selected.truncated ? `\n\n... [truncated at ${MAX_TOOL_TEXT_BYTES} bytes]` : ''),
        meta: { totalLines: lines.length, range: [start + 1, end], truncated: selected.truncated }
      };
    }
    const selected = boundedText(lines.slice(0, 2000).join('\n'));
    const truncated = lines.length > 2000 || selected.truncated;
    return { content: selected.text + (truncated ? `\n\n... [truncated; ${lines.length} total lines. Use start_line/end_line to read more.]` : '') };
  },

  async write_file(args, ctx) {
    const { path, content } = args as { path: string; content: string };
    const abs = safeResolve(path, ctx.cwd);
    if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_FILE_WRITE_BYTES) {
      return { content: `Error: writes are limited to ${MAX_FILE_WRITE_BYTES} bytes.`, isError: true };
    }
    let prevText = '';
    let isNewFile = true;
    try {
      if ((await stat(abs)).size > MAX_READ_FILE_BYTES) return { content: `Error: existing file exceeds the ${MAX_READ_FILE_BYTES} byte edit limit.`, isError: true };
      prevText = await readFile(abs, 'utf-8');
      isNewFile = false;
    } catch { /* new file */ }
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, content, 'utf-8');
    const stats = diffCounts(diffLines(prevText, content));
    const beforeSnap = snapshotForDiff(prevText);
    const afterSnap = snapshotForDiff(content);
    return {
      content: `Wrote ${content.length} bytes to ${abs}`,
      meta: {
        path: abs,
        kind: 'write',
        isNewFile,
        bytesAdded: content.length - prevText.length,
        linesAdded: stats.added,
        linesRemoved: stats.removed,
        finalLines: content.split('\n').length,
        // Snapshot for the renderer's terminal-style diff view. Capped.
        before: beforeSnap.text,
        after: afterSnap.text,
        beforeTruncated: beforeSnap.truncated,
        afterTruncated: afterSnap.truncated
      }
    };
  },

  async edit_file(args, ctx) {
    const { path, old_text, new_text } = args as { path: string; old_text: string; new_text: string };
    const abs = safeResolve(path, ctx.cwd);
    if (typeof old_text !== 'string' || typeof new_text !== 'string' || Buffer.byteLength(new_text, 'utf8') > MAX_FILE_WRITE_BYTES) {
      return { content: `Error: edits require text and replacement content is limited to ${MAX_FILE_WRITE_BYTES} bytes.`, isError: true };
    }
    if ((await stat(abs)).size > MAX_READ_FILE_BYTES) return { content: `Error: file exceeds the ${MAX_READ_FILE_BYTES} byte edit limit.`, isError: true };
    const text = await readFile(abs, 'utf-8');
    const occurrences = text.split(old_text).length - 1;
    if (occurrences === 0) return { content: `Error: old_text not found in ${abs}`, isError: true };
    if (occurrences > 1) return { content: `Error: old_text matches ${occurrences} locations; make it unique.`, isError: true };
    // Function replacement so `$&`/`$'` patterns in new_text are written literally
    const updated = text.replace(old_text, () => new_text);
    const stats = diffCounts(diffLines(old_text, new_text));
    await writeFile(abs, updated, 'utf-8');
    // Build a hunk-level snapshot: 3 lines of context before + old_text +
    // 3 lines of context after, both sides — enough to give the renderer the
    // line numbers and surrounding context a `git diff`-style view needs.
    const editLineNo = text.slice(0, text.indexOf(old_text)).split('\n').length;
    const beforeLines = text.split('\n');
    const afterLines = updated.split('\n');
    const contextLines = 3;
    const oldHunk = [
      ...beforeLines.slice(Math.max(0, editLineNo - 1 - contextLines), editLineNo - 1),
      ...old_text.split('\n')
    ].join('\n');
    const newHunkStart = editLineNo;
    const newHunk = [
      ...afterLines.slice(Math.max(0, newHunkStart - 1 - contextLines), newHunkStart - 1),
      ...new_text.split('\n')
    ].join('\n');
    const beforeSnap = snapshotForDiff(oldHunk);
    const afterSnap = snapshotForDiff(newHunk);
    return {
      content: `Edited ${abs}`,
      meta: {
        path: abs,
        kind: 'edit',
        bytesAdded: new_text.length - old_text.length,
        linesAdded: stats.added,
        linesRemoved: stats.removed,
        // Hunk-relative start line (1-based) — the renderer adds/subtracts
        // context lines to compute absolute line numbers.
        hunkStartLine: Math.max(1, editLineNo - contextLines),
        before: beforeSnap.text,
        after: afterSnap.text,
        beforeTruncated: beforeSnap.truncated,
        afterTruncated: afterSnap.truncated
      }
    };
  },

  async list_directory(args, ctx) {
    const { path } = args as { path: string };
    const abs = safeResolve(path, ctx.cwd);
    const entries = await readdir(abs, { withFileTypes: true });
    const out = entries
      .filter((e) => !e.name.startsWith('.') || e.name === '.gitignore' || e.name === '.env.example')
      .map((e) => `${e.isDirectory() ? 'd' : 'f'}  ${e.name}`)
      .sort();
    return { content: out.slice(0, 1_000).join('\n') + (out.length > 1_000 ? `\n... [${out.length - 1_000} more]` : '') || '(empty)' };
  },

  async glob_files(args, ctx) {
    const { pattern, cwd, ignore } = args as { pattern: string; cwd?: string; ignore?: string[] };
    const base = cwd ? safeResolve(cwd, ctx.cwd) : ctx.cwd;
    const matches = await fg(pattern, {
      cwd: base,
      ignore: ignore || ['**/node_modules/**', '**/.git/**', '**/dist/**'],
      dot: false,
      followSymbolicLinks: false
    });
    return { content: matches.slice(0, 500).join('\n') + (matches.length > 500 ? `\n... [${matches.length - 500} more]` : '') };
  },

  async grep_files(args, ctx) {
    const { pattern, cwd, include, ignore, max_results } = args as { pattern: string; cwd?: string; include?: string; ignore?: string[]; max_results?: number };
    const base = cwd ? safeResolve(cwd, ctx.cwd) : ctx.cwd;
    if (typeof pattern !== 'string' || unsafeSearchPattern(pattern)) {
      return { content: 'Search pattern is missing, too long, or potentially unsafe.', isError: true };
    }
    const matches = await fg(include || '**/*', {
      cwd: base,
      ignore: ignore || ['**/node_modules/**', '**/.git/**', '**/dist/**'],
      absolute: false,
      followSymbolicLinks: false
    });
    try { void new RegExp(pattern, 'm'); } catch {
      return { content: 'Search pattern is not a valid regular expression.', isError: true };
    }
    const out: string[] = [];
    const limit = Math.min(1_000, Math.max(1, Math.floor(max_results || 100)));
    const regex = startRegexWorker(pattern, ctx.signal);
    try {
      for (const file of matches.slice(0, 10_000)) {
        if (ctx.signal?.aborted) throw new Error('Search cancelled.');
        let abs: string;
        try { abs = safeResolve(file, base); } catch { continue; }
        let content: string;
        try {
          if ((await stat(abs)).size > MAX_GREP_FILE_BYTES) continue;
          content = await readFile(abs, 'utf-8');
        } catch { continue; }
        const remaining = limit - out.length;
        const lineNumbers = await regex.search(content, remaining);
        if (lineNumbers.length) {
          const lines = content.split('\n');
          for (const index of lineNumbers) out.push(`${file}:${index + 1}:${lines[index]}`);
        }
        if (out.length >= limit) { out.push(`... [truncated at ${limit}]`); break; }
      }
    } catch (error) {
      return {
        content: ctx.signal?.aborted ? '[cancelled] Search was cancelled.' : error instanceof Error ? error.message : String(error),
        isError: true
      };
    } finally {
      await regex.close();
    }
    return { content: out.join('\n') || '(no matches)' };
  },

  async run_shell(args, ctx) {
    const { command, cwd, timeout_ms } = args as { command: string; cwd?: string; timeout_ms?: number };
    const base = cwd ? safeResolve(cwd, ctx.cwd) : ctx.cwd;
    const timeout = timeout_ms ?? 30_000;
    if (!Number.isInteger(timeout) || timeout < 100 || timeout > 300_000) {
      return { content: 'timeout_ms must be an integer between 100 and 300000.', isError: true };
    }
    // An already-cancelled request never spawns a process at all.
    if (ctx.signal?.aborted) {
      return { content: '[cancelled] Command was cancelled before it started.', isError: true };
    }
    try {
      const outcome = await runShellProcess(command, base, timeout, ctx.signal);
      const output = shellOutput(outcome.stdout, outcome.stderr);
      if (outcome.stopReason === 'cancelled') {
        return { content: cappedShellResult('[cancelled]', output, outcome.error?.message), isError: true };
      }
      if (outcome.stopReason === 'timeout') {
        return {
          content: cappedShellResult('[exit err]', output, [`Command timed out after ${timeout}ms.`, outcome.error?.message].filter(Boolean).join('\n')),
          isError: true
        };
      }
      if (outcome.stopReason === 'maxBuffer') {
        return {
          content: cappedShellResult(`[exit err] Command output exceeded ${SHELL_MAX_BUFFER_BYTES} bytes.`, output, outcome.error?.message),
          isError: true
        };
      }
      if (outcome.error || outcome.code !== 0) {
        return {
          content: cappedShellResult(`[exit ${outcome.code ?? 'err'}]`, output, outcome.error?.message || (outcome.signal ? `Killed by ${outcome.signal}.` : '')),
          isError: true
        };
      }
      return { content: output.slice(0, SHELL_OUTPUT_BYTES) || '(no output)' };
    } catch (err) {
      return { content: cappedShellResult('[exit err]', '', err instanceof Error ? err.message : String(err)), isError: true };
    }
  },

  async web_fetch(args, ctx) {
    const url = typeof (args as { url?: unknown }).url === 'string' ? (args as { url: string }).url.trim() : '';
    if (!url) return { content: 'url is required.', isError: true };
    const maxBytes = typeof args.max_bytes === 'number' && args.max_bytes > 0
      ? Math.min(1_000_000, Math.floor(args.max_bytes))
      : 100_000;
    const blocked = isBlockedUrl(url);
    if (blocked.blocked) return { content: `Refusing to fetch ${url}: ${blocked.reason}`, isError: true };
    try {
      const guarded = await fetchWithRedirectGuard(url, ctx.signal, webFetchTimeoutMs);
      try {
        const { response: res } = guarded;
        const contentType = res.headers.get('content-type') || '';
        const isText = /^(text\/|application\/(json|xml|xhtml|javascript|ld\+json)|application\/[^;]*\+(json|xml))/i.test(contentType);
        if (!isText) {
          const len = res.headers.get('content-length');
          await res.body?.cancel();
          return {
            content: `[${res.status}] ${guarded.url}\nNon-text content (${contentType || 'unknown type'}${len ? `, ${len} bytes` : ''}); body omitted.`,
            meta: { url: guarded.url, status: res.status, contentType }
          };
        }
        const bodyResult = await readLimitedBody(res, maxBytes, guarded.signal);
        const body = /html/i.test(contentType) ? htmlToText(bodyResult.text) : bodyResult.text;
        const out = bodyResult.truncated ? `${body}\n\n... [truncated at ${maxBytes} bytes]` : body;
        return {
          content: `[${res.status}] ${guarded.url}\n\n${out}`.trim(),
          meta: {
            url: guarded.url,
            status: res.status,
            contentType,
            bytes: bodyResult.bytes,
            truncated: bodyResult.truncated
          }
        };
      } finally {
        await guarded.cleanup();
      }
    } catch (err) {
      if (ctx.signal?.aborted) return { content: '[cancelled] Fetch was cancelled.', isError: true };
      return { content: `Fetch failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  },

  async web_search(args, ctx) {
    const query = typeof (args as { query?: unknown }).query === 'string' ? (args as { query: string }).query.trim() : '';
    if (!query) return { content: 'query is required.', isError: true };
    const count = typeof args.count === 'number' && args.count > 0 ? Math.min(10, Math.floor(args.count)) : 5;
    try {
      const results = await runWebSearch(query, count, ctx.signal);
      if (results.length === 0) return { content: `No results for: ${query}`, meta: { query, results: [] } };
      const text = results
        .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`)
        .join('\n\n');
      return { content: text, meta: { query, results } };
    } catch (err) {
      if (ctx.signal?.aborted) return { content: '[cancelled] Search was cancelled.', isError: true };
      return { content: `Search failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  },

  async todo_write(args) {
    const { todos } = args as { todos: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed'; active_form?: string }> };
    const formatted = todos.map((t) => `[${t.status === 'completed' ? 'x' : t.status === 'in_progress' ? '~' : ' '}] ${t.content}`).join('\n');
    return { content: formatted, meta: { todos } };
  },

  async lint_dvm_basic(args) {
    const { source } = args as { source: unknown };
    if (typeof source !== 'string') return { content: 'Error: source must be a string.', isError: true };
    if (source.length > 250_000) return { content: 'Error: source exceeds the 250 KB analysis limit.', isError: true };
    const result = lintDvmBasic(source);
    const summary = `${result.valid ? 'No structural errors' : 'Structural errors found'}; ${result.functions.length} function(s), ${result.findings.length} finding(s).`;
    return { content: `${summary}\n${JSON.stringify(result, null, 2)}`, meta: { dvmLint: result } };
  },

  async generate_dvm_contract(args) {
    const { name, brief } = args as { name: unknown; brief: unknown };
    if (!name || typeof name !== 'string' || !brief || typeof brief !== 'string') {
      return { content: 'Both "name" (PascalCase) and "brief" (contract specification) are required.', isError: true };
    }
    const contractName = String(name);
    const contractBrief = String(brief);
    return {
      content: `Contract brief received. Generate a complete DVM-BASIC contract named "${contractName}" from this specification. Use lint_dvm_basic after generating to validate structure.\n\n## Specification\n${contractBrief}\n\n## Requirements\n- Use Function/End Function with line-numbered statements\n- Include SIGNER() guards on state-changing functions\n- Use STORE()/LOAD() for persistent state\n- Include Initialize() or InitializePrivate()\n- Every function must RETURN\n\nRespond with the source inside \`\`\`basic ... \`\`\`\n\nThen run lint_dvm_basic on the result to validate.`,
      meta: { contractName }
    };
  },

  async get_simulator_chain_info(_args, ctx) {
    try {
      const timeoutSignal = AbortSignal.timeout(3_000);
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeoutSignal]) : timeoutSignal;
      const response = await fetch(simulatorRpcEndpoint(), {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal,
        body: JSON.stringify({ jsonrpc: '2.0', id: 'dero-hive-tool', method: 'DERO.GetInfo' })
      });
      const payload = await readLimitedBody(response, MAX_SIMULATOR_RPC_BYTES, signal);
      if (payload.truncated) return { content: 'Error: simulator RPC response exceeds 1 MB.', isError: true };
      const body = JSON.parse(payload.text) as { result?: Record<string, unknown>; error?: { message?: string } };
      if (!response.ok || body.error || !body.result) return { content: `Error: ${body.error?.message || `Simulator RPC HTTP ${response.status}`}`, isError: true };
      const result = body.result;
      const summary = {
        network: result.network, height: result.height, topoHeight: result.topoheight,
        txPoolSize: result.tx_pool_size, status: result.status, version: result.version
      };
      return { content: JSON.stringify(summary, null, 2), meta: { simulator: summary } };
    } catch (error) {
      return { content: `Error: local simulator unavailable: ${error instanceof Error ? error.message : String(error)}`, isError: true };
    }
  },

  async simulator_create_wallet() {
    const mgr = getSimulatorManager();
    if (!mgr) return { content: 'Simulator is not available.', isError: true };
    try {
      const w = await mgr.createFixtureWallet();
      return { content: `Created fixture wallet.\nAddress: ${w.address}`, meta: { walletAddress: w.address, scid: w.scid } };
    } catch (err) {
      return { content: `Simulator wallet creation failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  },

  async simulator_get_balance(args) {
    const mgr = getSimulatorManager();
    if (!mgr) return { content: 'Simulator is not available.', isError: true };
    const { address } = args;
    if (!address || typeof address !== 'string') return { content: 'address is required.', isError: true };
    try {
      const b = await mgr.getBalance(String(address), typeof args.scid === 'string' ? args.scid : undefined);
      return { content: `Balance for ${String(address)}: ${b.balance}`, meta: b };
    } catch (err) {
      return { content: `Balance lookup failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  },

  async simulator_get_contract_state(args) {
    const mgr = getSimulatorManager();
    if (!mgr) return { content: 'Simulator is not available.', isError: true };
    const { scid } = args;
    if (!scid || typeof scid !== 'string') return { content: 'scid is required.', isError: true };
    try {
      const keys = typeof args.keys === 'string' && args.keys.trim() ? args.keys.split(',').map((k: string) => k.trim()) : undefined;
      const state = await mgr.getContractState(String(scid), keys);
      return { content: JSON.stringify(state, null, 2), meta: { scid: String(scid) } };
    } catch (err) {
      return { content: `Contract state read failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  },

  async simulator_get_height() {
    const mgr = getSimulatorManager();
    if (!mgr) return { content: 'Simulator is not available.', isError: true };
    try {
      const height = await mgr.getHeight();
      return { content: `Simulator block height: ${height}`, meta: { height } };
    } catch (err) {
      return { content: `Height lookup failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  },

  async audit_dvm_contract(args) {
    const source = typeof (args as { source?: unknown }).source === 'string' ? (args as { source: string }).source : '';
    const contractName = typeof (args as { contractName?: unknown }).contractName === 'string' ? (args as { contractName: string }).contractName : 'Contract';
    if (!source.trim()) return { content: 'source is required for audit.', isError: true };

    const lintResult = lintDvmBasic(source);

    const checklist = [
      'ACCESS_CONTROL: Verify SIGNER() guards on all state-changing public functions. Check that Initialize/InitializePrivate is correctly scoped.',
      'FUND_SAFETY: Trace DERO and token transfers. Verify DEROVALUE() is checked before acceptance. Confirm amounts use proper bounds.',
      'STATE_INTEGRITY: Validate STORE/LOAD key consistency. Check for data races or interleaving issues across functions.',
      'REENTRANCY: Identify functions that modify state after external calls (SC_INVOKE, SEND_DERO_TO_ADDRESS). Verify checks-effects-interactions pattern.',
      'OVERFLOW: Check arithmetic operations (ADD, SUB, MUL, DIV) for overflow/underflow. Verify maximum values are guarded.',
      'INITIALIZATION: Confirm Initialize() runs once. Check that critical state keys are initialized before use.',
      'DENIAL_OF_SERVICE: Identify unbounded loops, excessive storage writes, or gas-heavy operations that could block the contract.',
      'PRIVACY: Note any plaintext storage of sensitive data on the public blockchain. Flag missing encryption patterns.',
      'VALIDATION: Check input parameter validation. Confirm addresses, amounts, and IDs are verified before use.',
      'UPGRADEABILITY: Check if the contract supports upgrades and whether the upgrade path is properly guarded.'
    ];

    return {
      content: `## DERO Security Audit: ${contractName}\n\n### Structural Lint\n${lintResult.findings.length} finding(s):\n${lintResult.findings.map(f => `- [${f.severity.toUpperCase()}] ${f.code}${f.line ? ` (line ${f.line})` : ''}: ${f.message}`).join('\n') || 'None'}\n\n### Audit Checklist\nReview each category against the source, reporting findings with:\n- **SEVERITY**: Critical / High / Medium / Low / Info\n- **LINES**: Affected line number(s)\n- **EXPLOIT**: Concrete failure scenario\n- **REPRODUCTION**: How to reproduce on simulator\n- **REMEDIATION**: Minimal code fix\n\n${checklist.map((c, i) => `**${i + 1}. ${c}**\n> Audit this category and report findings or "PASS".`).join('\n\n')}\n\n### Contract Source\n\`\`\`basic\n${source.slice(0, 6000)}${source.length > 6000 ? '\n... (truncated)' : ''}\n\`\`\`\n\nRun lint_dvm_basic on the source first, then review each checklist category systematically. Report ALL findings found, not just the most severe.`,
      meta: { contractName, lintFindings: lintResult.findings, checklistCategories: checklist.map(c => c.split(':')[0]) }
    };
  },

  async generate_tela_dapp(args, ctx: ToolContext) {
    const name = String((args as { name?: unknown }).name || '');
    const description = String((args as { description?: unknown }).description || '');
    if (!name.trim()) return { content: 'dApp name is required.', isError: true };

    const dir = `${ctx.cwd.replace(/[\\/]$/, '')}/tela/${name}`;
    const files: Record<string, string> = {
      'contract.bas': `' DERO TELA Contract: ${name}
' Generated by DERO Hive TELA Builder
Function Initialize() Uint64
1  STORE("owner", SIGNER())
2  STORE("name", "${name}")
3  RETURN 0
End Function

Function GetOwner() Uint64
10 RETURN LOAD("owner")
End Function
`,
      'index.html': `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${name} — DERO TELA dApp</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <div id="app">
    <header><h1>${name}</h1></header>
    <main><div id="output">Connecting to DERO network...</div></main>
    <footer>Powered by DERO Hive</footer>
  </div>
  <script src="mock-xswd.js?mock=1"></script>
  <script src="app.js"></script>
</body>
</html>
`,
      'styles.css': `* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: system-ui, -apple-system, sans-serif; background: #0a0a0f; color: #e0e0e0; min-height: 100vh; }
#app { max-width: 800px; margin: 0 auto; padding: 2rem; }
header h1 { font-size: 1.5rem; color: #7cffc4; margin-bottom: 1rem; }
main { background: #12121a; border-radius: 12px; padding: 2rem; border: 1px solid #1e1e2e; }
footer { margin-top: 2rem; padding-top: 1rem; border-top: 1px solid #1e1e2e; color: #555; font-size: 0.75rem; text-align: center; }
#output { padding: 1rem; background: #0a0a12; border-radius: 8px; font-family: monospace; font-size: 0.85rem; min-height: 4rem; }
.btn { background: #1e1e2e; border: 1px solid #333; color: #e0e0e0; padding: 0.5rem 1rem; border-radius: 6px; cursor: pointer; }
.btn:hover { background: #2a2a3e; }
`,
      'app.js': `// ${name} — DERO TELA dApp
// XSWD connection with read-only mock support
let dero = null;
const output = document.getElementById('output');

async function connectWallet() {
  try {
    if (typeof window.xswd !== 'undefined') {
      dero = window.xswd;
      output.textContent = 'Connected to DERO wallet via XSWD.';
      void checkNetwork();
    } else {
      output.textContent = 'No XSWD wallet detected. Using read-only mode.';
    }
  } catch (err) {
    output.textContent = 'Connection error: ' + err.message;
  }
}

async function checkNetwork() {
  if (!dero) return;
  try {
    const info = await dero.request({ method: 'DERO.GetInfo' });
    output.textContent = 'Network: ' + info.network + ' | Height: ' + info.height;
  } catch (err) {
    output.textContent = 'Network check failed: ' + err.message;
  }
}

document.addEventListener('DOMContentLoaded', function() {
  void connectWallet();
});
`,
      'mock-xswd.js': `// Mock XSWD bridge for local development
// Replace with real XSWD for wallet operations
(function() {
  if (new URLSearchParams(location.search).get('mock') !== '1') return;
  var mockRpc = {
    'DERO.GetInfo': function() { return { height: 12345, network: 'simulator', topoheight: 12345, version: 'mock', tx_pool_size: 0, status: 'OK' }; },
    'DERO.GetHeight': function() { return { height: 12345 }; },
    'DERO.GetEncryptedBalance': function() { return { balance: 1000000, unlocked_balance: 1000000 }; }
  };
  window.xswd = {
    request: async function(req) {
      var method = req.method || (req.params && req.params.method);
      var handler = mockRpc[method];
      if (handler) return handler();
      return { error: 'Mock: method ' + method + ' not available in read-only fixture' };
    },
    wallet: { connected: true, address: 'dero1mock0000000000000000000000000000000000000000000000000000000000', network: 'simulator' }
  };
})();
`,
      'tela.config.json': JSON.stringify({
        name,
        version: '1.0.0',
        description,
        contract: 'contract.bas',
        entry: 'index.html',
        documents: ['index.html', 'styles.css', 'app.js', 'mock-xswd.js'],
        permissions: ['read-only'],
        xswd: { mock: true, readOnly: true },
        deployment: { network: 'simulator', estimatedGas: 50000 }
      }, null, 2)
    };

    try {
      await mkdir(dir, { recursive: true });
      for (const [filename, content] of Object.entries(files)) {
        await writeFile(join(dir, filename), content, 'utf-8');
      }
      return {
        content: `TELA dApp "${name}" scaffolded at tela/${name}/ with ${Object.keys(files).length} files: contract.bas, index.html, styles.css, app.js, mock-xswd.js, tela.config.json.`,
        meta: { telaName: name, telaDir: `tela/${name}`, fileCount: Object.keys(files).length }
      };
    } catch (err) {
      return { content: `TELA dApp scaffolding failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  },

  async discover_contracts(args) {
    const query = typeof (args as { query?: unknown }).query === 'string' ? (args as { query: string }).query : '';
    const kind = (typeof (args as { kind?: unknown }).kind === 'string' ? (args as { kind: string }).kind : 'similar-contracts') as IndexQuery['kind'];

    return {
      content: `## Contract Discovery Request

**Query:** ${query || '(broad discovery)'}
**Kind:** ${kind}

Use the connected DERO MCP tools to discover contracts matching this query:

1. If a Gnomon instance is connected, use its indexed contract search
2. Otherwise, use \`dero_tela_list_apps\` for TELA dApps
3. Use \`dero_get_sc\` to inspect individual contracts by SCID
4. Use \`explain_smart_contract\` to get contract metadata

### Discovery Strategy
- **similar-contracts**: Find contracts with similar bytecode or function signatures
- **by-function**: Find all contracts implementing a specific function name
- **by-transaction**: Find contracts involved in recent transactions
- **tela-apps**: List all TELA dApps deployed on the connected network

Present results with: SCID, name, deploy height, key functions, and related contracts. If Gnomon is unavailable, explain that only daemon-level inspection is possible (GetSC by known SCID).`,
      meta: { kind, query }
    };
  },

  async generate_image(args, ctx) {
    const { prompt, aspect } = args as { prompt?: string; aspect?: 'square' | 'portrait' | 'landscape' };
    return runMediaGeneration('image', String(prompt || ''), ctx, { aspect });
  },

  async generate_audio(args, ctx) {
    const { text, voice } = args as { text?: string; voice?: string };
    return runMediaGeneration('audio', String(text || ''), ctx, { voice });
  },

  async generate_video(args, ctx) {
    const { prompt, duration_seconds } = args as { prompt?: string; duration_seconds?: number };
    return runMediaGeneration('video', String(prompt || ''), ctx, { durationSeconds: duration_seconds });
  }
};

const MEDIA_ASPECTS: Record<string, { width: number; height: number }> = {
  square: { width: 1024, height: 1024 },
  portrait: { width: 1024, height: 1792 },
  landscape: { width: 1792, height: 1024 }
};

const MEDIA_SETUP_HINT: Record<MediaKind, string> = {
  image: 'No image generator is configured. Open Settings → Media and add a provider (Pollinations needs no API key), or connect a model provider that offers image models, then ask again.',
  audio: 'No speech generator is configured. Open Settings → Media and add OpenAI or ElevenLabs speech, or connect an image/speech-capable model provider, then ask again.',
  video: 'No video generator is configured. Video needs a dedicated media provider such as Replicate or ComfyUI — add one in Settings → Media, then ask again.'
};

async function runMediaGeneration(
  kind: MediaKind,
  prompt: string,
  ctx: ToolContext,
  opts: { aspect?: 'square' | 'portrait' | 'landscape'; voice?: string; durationSeconds?: number }
): Promise<ToolResult> {
  if (!prompt.trim()) return { content: 'Error: a non-empty prompt/text is required.', isError: true };
  const mgr = getMediaManager();
  if (!mgr) return { content: 'Media generation is unavailable in this session.', isError: true };

  const pick = mgr.autoPick(kind);
  if (!pick) return { content: MEDIA_SETUP_HINT[kind], isError: true };

  const req: MediaGenerationRequest = { prompt: prompt.trim(), kind, ...pick };
  if (kind === 'image') {
    const a = MEDIA_ASPECTS[opts.aspect || 'square'] || MEDIA_ASPECTS.square;
    req.width = a.width;
    req.height = a.height;
  } else if (kind === 'video') {
    req.durationSeconds = Math.max(1, Math.min(60, Math.round(opts.durationSeconds ?? 5)));
  } else if (kind === 'audio' && opts.voice) {
    req.voice = opts.voice;
  }

  try {
    const art = await mgr.generate(req, { conversationId: ctx.conversationId, signal: ctx.signal });
    if (process.env.HIVE_CLI) {
      const copied = await mgr.copyArtifactToProject(art.id, ctx.cwd, 'hive');
      return {
        content: copied.ok && copied.path
          ? `Generated ${kind} with ${art.model} and saved it to: ${copied.path}`
          : `Generated ${kind} with ${art.model}. It is stored in the Hive media library as artifact ${art.id}.`,
        meta: {
          mediaArtifactId: art.id,
          mediaKind: art.kind,
          mediaMime: art.mimeType,
          mediaPrompt: art.prompt,
          ...(copied.path ? { mediaPath: copied.path } : {})
        }
      };
    }
    return {
      content: `Generated ${kind} and displayed it to the user (model: ${art.model}). Do not describe the pixels; the user can see it. Offer refinements if helpful.`,
      meta: { mediaArtifactId: art.id, mediaKind: art.kind, mediaMime: art.mimeType, mediaPrompt: art.prompt }
    };
  } catch (err) {
    return { content: `Media generation failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}

// ── Web tools (web_fetch / web_search) ────────────────────────────────
const WEB_FETCH_TIMEOUT_MS = 15_000;
const WEB_SEARCH_MAX_BODY_BYTES = 1_000_000;
const WEB_USER_AGENT = 'Mozilla/5.0 (compatible; DeroHive/1.0; +https://dero.io)';
const MAX_REDIRECTS = 5;
let webFetchTimeoutMs = WEB_FETCH_TIMEOUT_MS;

/** Test seam for exercising post-header body timeouts without a 15-second wait. */
export function __setWebFetchTimeoutForTest(timeoutMs: number | null): void {
  if (timeoutMs !== null && (!Number.isInteger(timeoutMs) || timeoutMs < 1)) throw new Error('timeoutMs must be a positive integer.');
  webFetchTimeoutMs = timeoutMs ?? WEB_FETCH_TIMEOUT_MS;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Reject URLs an agent should never be able to reach through web_fetch:
 * non-http(s) schemes, localhost, and any IP literal that is not ordinary public
 * unicast — loopback, private, link-local (incl. cloud metadata), CGNAT,
 * multicast, reserved, broadcast, unspecified, and the IPv4-mapped IPv6 forms of
 * all of those. IP classification is delegated to ipaddr.js so alternate textual
 * forms (e.g. the hex ::ffff:7f00:1 that Node emits for ::ffff:127.0.0.1) can't
 * slip through. DNS names pass this string guard and are resolved + re-checked at
 * fetch time (fetchWithRedirectGuard) — the string guard alone is not
 * DNS-rebinding proof. Each redirect hop is re-validated.
 */
export function isBlockedUrl(input: string): { blocked: boolean; reason?: string } {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return { blocked: true, reason: 'not a valid absolute URL' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { blocked: true, reason: `unsupported scheme "${u.protocol}"` };
  }
  // Strip IPv6 brackets and any trailing dot(s): "localhost." / "127.0.0.1." are
  // the same host as without the dot and must not slip past the checks.
  const host = u.hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '').toLowerCase();
  if (!host) return { blocked: true, reason: 'empty host' };
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return { blocked: true, reason: 'localhost is not allowed' };
  }
  if (ipaddr.isValid(host)) {
    return isBlockedAddress(host)
      ? { blocked: true, reason: `non-public address (${host}) is not allowed` }
      : { blocked: false };
  }
  // An IP-shaped host that does not parse is a malformed literal — fail safe.
  if (/^[0-9.]+$/.test(host) || host.includes(':')) {
    return { blocked: true, reason: `malformed IP literal (${host})` };
  }
  return { blocked: false }; // hostname — resolved and re-checked at fetch time
}

/**
 * True if an IP-literal string is anything other than ordinary public unicast.
 * IPv4-mapped IPv6 is decoded to its IPv4 form first, so ::ffff:127.0.0.1 (in any
 * textual form) classifies as loopback. Shared by isBlockedUrl and the fetch-time
 * DNS re-check so both call sites and their tests hang off one function.
 */
export function isBlockedAddress(ip: string): boolean {
  let addr: ReturnType<typeof ipaddr.parse>;
  try {
    addr = ipaddr.parse(ip);
  } catch {
    return true; // unparseable but reached as an IP candidate → fail safe
  }
  if (addr.kind() === 'ipv6') {
    const v6 = addr as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) return v6.toIPv4Address().range() !== 'unicast';
    return v6.range() !== 'unicast';
  }
  return (addr as ipaddr.IPv4).range() !== 'unicast';
}

/** Resolve a hostname to its IP addresses. Injectable so tests never hit the network. */
export type HostResolver = (host: string) => Promise<string[]>;
const realHostResolver: HostResolver = async (host) => (await lookup(host, { all: true })).map((r) => r.address);
let resolveHostAddresses: HostResolver = realHostResolver;

/** Test seam: override DNS resolution (pass null to restore the real resolver). */
export function __setHostResolverForTest(fn: HostResolver | null): void {
  resolveHostAddresses = fn ?? realHostResolver;
}

/** For a DNS hostname, resolve it and reject if any resolved address is non-public.
 *  Closes the DNS-rebinding gap the string guard cannot (e.g. lvh.me → 127.0.0.1).
 *  Unresolvable hosts are left for fetch to fail on naturally. */
async function assertHostResolvesPublic(host: string): Promise<void> {
  let addrs: string[];
  try {
    addrs = await resolveHostAddresses(host);
  } catch {
    return;
  }
  for (const a of addrs) {
    if (isBlockedAddress(a)) {
      throw new Error(`host ${host} resolves to a non-public address (${a})`);
    }
  }
}

function publicLookup(): LookupFunction {
  return (hostname, options, callback) => {
    resolveHostAddresses(hostname).then((addresses) => {
      if (!addresses.length) throw new Error(`host ${hostname} resolved to no addresses`);
      for (const address of addresses) {
        if (isBlockedAddress(address)) {
          throw new Error(`host ${hostname} resolves to a non-public address (${address})`);
        }
      }
      const records = addresses.map((address) => ({
        address,
        family: ipaddr.parse(address).kind() === 'ipv4' ? 4 : 6
      }));
      const requestedFamily = options.family === 4 || options.family === 6 ? options.family : undefined;
      const eligible = requestedFamily ? records.filter((record) => record.family === requestedFamily) : records;
      if (!eligible.length) throw new Error(`host ${hostname} has no IPv${requestedFamily} address`);
      if (options.all) callback(null, eligible);
      else callback(null, eligible[0].address, eligible[0].family);
    }).catch((error: unknown) => {
      const err = error instanceof Error ? error : new Error(String(error));
      callback(Object.assign(err, { code: 'EHOSTUNREACH' }), '');
    });
  };
}

interface GuardedFetch {
  response: Response;
  url: string;
  signal: AbortSignal;
  cleanup: () => Promise<void>;
}

/** Fetch following redirects manually. The dispatcher's lookup validates the
 * exact address used for each connection, closing the DNS rebinding window. */
async function fetchWithRedirectGuard(startUrl: string, signal: AbortSignal | undefined, timeoutMs: number): Promise<GuardedFetch> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Fetch timed out after ${timeoutMs}ms.`)), timeoutMs);
  timer.unref?.();
  const onAbort = (): void => controller.abort(signal?.reason);
  const dispatcher = new Agent({ connect: { lookup: publicLookup() } });
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
    try { await dispatcher.close(); } catch { /* best effort */ }
  };
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    let url = startUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const blocked = isBlockedUrl(url);
      if (blocked.blocked) throw new Error(`redirect blocked: ${blocked.reason}`);
      // DNS names pass the string guard; resolve and re-check to defeat rebinding.
      const host = new URL(url).hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '').toLowerCase();
      if (host && !ipaddr.isValid(host)) await assertHostResolvesPublic(host);
      const res = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'user-agent': WEB_USER_AGENT, accept: 'text/html,application/json;q=0.9,*/*;q=0.8' },
        dispatcher
      } as RequestInit & { dispatcher: Agent });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) return { response: res, url, signal: controller.signal, cleanup };
        await res.body?.cancel();
        url = new URL(loc, url).toString();
        continue;
      }
      return { response: res, url, signal: controller.signal, cleanup };
    }
    throw new Error(`too many redirects (>${MAX_REDIRECTS})`);
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function readLimitedBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal
): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { text: '', bytes: 0, truncated: false };
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  let rejectAbort!: (error: Error) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = (): void => rejectAbort(signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Fetch was cancelled.', 'AbortError'));
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    if (signal.aborted) onAbort();
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      if (!value?.byteLength) continue;
      const remaining = maxBytes + 1 - bytes;
      if (remaining <= 0) { truncated = true; break; }
      const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      chunks.push(chunk);
      bytes += chunk.byteLength;
      if (bytes > maxBytes) { truncated = true; break; }
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (truncated || signal.aborted) {
      try { await reader.cancel(); } catch { /* ignore */ }
    }
  }
  const raw = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).subarray(0, maxBytes);
  return { text: raw.toString('utf8'), bytes: raw.byteLength, truncated };
}

/** Reduce an HTML document to readable text: drop script/style/comments, turn block
 *  boundaries into newlines, strip tags, decode common entities, collapse whitespace. */
export function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style|noscript|template|svg)[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6]|ul|ol|table|blockquote)>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  s = s.replace(/[ \t\f\v]+/g, ' ');
  s = s.replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

function decodeEntities(s: string): string {
  const named: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", mdash: '—', ndash: '–', hellip: '…'
  };
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, code: string) => {
    if (code[0] === '#') {
      const cp = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    return named[code] ?? m;
  });
}

async function runWebSearch(query: string, count: number, signal: AbortSignal | undefined): Promise<WebSearchResult[]> {
  const apiKey = process.env.HIVE_SEARCH_API_KEY;
  const provider = (process.env.HIVE_SEARCH_PROVIDER || 'brave').toLowerCase();
  if (apiKey && provider === 'brave') return braveSearch(query, count, apiKey, signal);
  if (apiKey && provider === 'tavily') return tavilySearch(query, count, apiKey, signal);
  return duckDuckGoSearch(query, count, signal);
}

async function braveSearch(query: string, count: number, apiKey: string, signal: AbortSignal | undefined): Promise<WebSearchResult[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
  const { response, text } = await timedFetchText(url, { headers: { accept: 'application/json', 'x-subscription-token': apiKey } }, signal);
  if (!response.ok) throw new Error(`Brave search HTTP ${response.status}`);
  const body = JSON.parse(text) as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } };
  return (body.web?.results || []).slice(0, count).map((r) => ({
    title: r.title || r.url || '(untitled)',
    url: r.url || '',
    snippet: stripTags(r.description || '')
  }));
}

async function tavilySearch(query: string, count: number, apiKey: string, signal: AbortSignal | undefined): Promise<WebSearchResult[]> {
  const { response, text } = await timedFetchText('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey, query, max_results: count })
  }, signal);
  if (!response.ok) throw new Error(`Tavily search HTTP ${response.status}`);
  const body = JSON.parse(text) as { results?: Array<{ title?: string; url?: string; content?: string }> };
  return (body.results || []).slice(0, count).map((r) => ({
    title: r.title || r.url || '(untitled)',
    url: r.url || '',
    snippet: (r.content || '').slice(0, 300)
  }));
}

async function duckDuckGoSearch(query: string, count: number, signal: AbortSignal | undefined): Promise<WebSearchResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const { response, text } = await timedFetchText(url, { headers: { 'user-agent': WEB_USER_AGENT, accept: 'text/html' } }, signal);
  if (!response.ok) throw new Error(`DuckDuckGo HTTP ${response.status}`);
  return parseDuckDuckGoHtml(text).slice(0, count);
}

/** Parse DuckDuckGo's HTML results page into structured results. Exported for tests. */
export function parseDuckDuckGoHtml(html: string): WebSearchResult[] {
  const out: WebSearchResult[] = [];
  const linkRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippets: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snippetRe.exec(html))) snippets.push(stripTags(sm[1]));
  let lm: RegExpExecArray | null;
  let i = 0;
  while ((lm = linkRe.exec(html))) {
    out.push({ title: stripTags(lm[2]).trim(), url: decodeDuckDuckGoHref(lm[1]), snippet: (snippets[i] || '').trim() });
    i++;
  }
  return out;
}

function decodeDuckDuckGoHref(href: string): string {
  // DDG wraps result links as //duckduckgo.com/l/?uddg=<encoded>&...
  try {
    const u = new URL(href, 'https://duckduckgo.com');
    const target = u.searchParams.get('uddg');
    return target ? decodeURIComponent(target) : href;
  } catch {
    return href;
  }
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

async function timedFetchText(
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined
): Promise<{ response: Response; text: string }> {
  const controller = new AbortController();
  const timeoutMs = webFetchTimeoutMs;
  const timer = setTimeout(() => controller.abort(new Error(`Search timed out after ${timeoutMs}ms.`)), timeoutMs);
  const onAbort = (): void => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const body = await readLimitedBody(response, WEB_SEARCH_MAX_BODY_BYTES, controller.signal);
    if (body.truncated) throw new Error(`Search response exceeded ${WEB_SEARCH_MAX_BODY_BYTES} bytes.`);
    return { response, text: body.text };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}
