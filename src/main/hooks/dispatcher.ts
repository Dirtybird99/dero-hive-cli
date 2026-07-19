import { spawn, type ChildProcess } from 'node:child_process';
import { getSetting } from '../db/client';
import { logger } from '../utils/logger';
import type { HookContext, HookDefinition, HookEvent } from './types';

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_HOOK_OUTPUT_BYTES = 256 * 1024;
const TREE_KILL_TIMEOUT_MS = 5_000;

export interface PreToolUseOutcome {
  block: boolean;
  feedback?: string;
}

interface HookRunOutcome {
  decision?: 'allow' | 'deny';
  feedback?: string;
  errored: boolean;
}

function loadHooks(): HookDefinition[] {
  const all = getSetting<HookDefinition[]>('hooks');
  return Array.isArray(all) ? all : [];
}

function matchesTool(pattern: string | undefined, toolName: string): boolean {
  if (!pattern) return true;
  if (pattern.length > 2 && pattern.startsWith('/') && pattern.endsWith('/')) {
    try {
      return new RegExp(pattern.slice(1, -1)).test(toolName);
    } catch {
      return false;
    }
  }
  return toolName.includes(pattern);
}

function filterHooks(hooks: HookDefinition[], event: HookEvent, toolName: string): HookDefinition[] {
  return hooks.filter(
    (h) => h && h.event === event && typeof h.command === 'string' && h.command.trim().length > 0 && matchesTool(h.toolPattern, toolName)
  );
}

/** Run one hook command, feeding it the JSON payload on stdin and interpreting the
 *  result: a JSON `{decision, feedback}` on stdout wins; otherwise exit 0 = allow,
 *  non-zero = deny. Timeouts and spawn failures resolve as `errored`. */
function runHookCommand(hook: HookDefinition, payload: string): Promise<HookRunOutcome> {
  const timeoutMs = hook.timeoutMs && hook.timeoutMs > 0 ? hook.timeoutMs : DEFAULT_TIMEOUT_MS;
  return new Promise<HookRunOutcome>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(hook.command, {
        shell: true,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (err) {
      resolve({ errored: true, feedback: err instanceof Error ? err.message : String(err) });
      return;
    }

    let settled = false;
    let stopping = false;
    let outputBytes = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    const finish = (outcome: HookRunOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };

    const stop = async (feedback: string): Promise<void> => {
      if (stopping || settled) return;
      stopping = true;
      let terminationError: string | undefined;
      try { await killTree(child); }
      catch (error) { terminationError = error instanceof Error ? error.message : String(error); }
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.stdin?.destroy();
      child.unref();
      finish({ errored: true, feedback: terminationError ? `${feedback}; ${terminationError}` : feedback });
    };

    const capture = (target: Buffer[], chunk: Buffer): void => {
      if (stopping || settled) return;
      const remaining = MAX_HOOK_OUTPUT_BYTES - outputBytes;
      if (remaining > 0) {
        const kept = chunk.subarray(0, remaining);
        target.push(kept);
        outputBytes += kept.byteLength;
      }
      if (chunk.byteLength > remaining) {
        void stop(`hook output exceeded ${MAX_HOOK_OUTPUT_BYTES} bytes`);
      }
    };

    const timer = setTimeout(() => {
      void stop(`hook timed out after ${timeoutMs}ms`);
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => capture(stdout, chunk));
    child.stderr?.on('data', (chunk: Buffer) => capture(stderr, chunk));
    child.stdin?.on('error', () => { /* ignore EPIPE if the hook exits before reading */ });
    child.on('error', (err) => {
      if (!stopping) finish({ errored: true, feedback: err.message });
    });
    child.on('close', (code) => {
      if (stopping) return;
      let decision: 'allow' | 'deny' | undefined;
      let feedback: string | undefined;
      const parsed = tryParseJson(Buffer.concat(stdout).toString('utf8'));
      if (parsed && typeof parsed === 'object') {
        const d = (parsed as { decision?: unknown }).decision;
        if (d === 'allow' || d === 'deny') decision = d;
        const f = (parsed as { feedback?: unknown }).feedback;
        if (typeof f === 'string') feedback = f;
      }
      if (!decision) decision = code === 0 ? 'allow' : 'deny';
      const errorText = Buffer.concat(stderr).toString('utf8').trim();
      finish({ decision, feedback: feedback ?? (errorText || undefined), errored: false });
    });

    try {
      child.stdin?.write(payload);
      child.stdin?.end();
    } catch {
      /* ignore — close/error handlers settle the promise */
    }
  });
}

/** Terminate the process group on POSIX or await taskkill /T on Windows. */
function killTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid) return Promise.reject(new Error('hook process PID is unavailable'));
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, 'SIGKILL');
      return Promise.resolve();
    } catch (error) {
      try { child.kill('SIGKILL'); } catch { /* best-effort direct fallback */ }
      return Promise.reject(new Error(`failed to terminate hook process group ${pid}`, { cause: error }));
    }
  }

  return new Promise((resolve, reject) => {
    let killer: ChildProcess;
    try {
      killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true
      });
    } catch (error) {
      try { child.kill('SIGKILL'); } catch { /* best-effort direct fallback */ }
      reject(new Error(`failed to start taskkill for hook process tree ${pid}`, { cause: error }));
      return;
    }

    let done = false;
    const finish = (error?: Error): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      try { killer.kill('SIGKILL'); } catch { /* already gone */ }
      try { child.kill('SIGKILL'); } catch { /* best-effort direct fallback */ }
      finish(new Error(`taskkill did not settle within ${TREE_KILL_TIMEOUT_MS}ms for hook process tree ${pid}`));
    }, TREE_KILL_TIMEOUT_MS);
    killer.once('error', (error) => {
      try { child.kill('SIGKILL'); } catch { /* best-effort direct fallback */ }
      finish(new Error(`taskkill failed for hook process tree ${pid}: ${error.message}`, { cause: error }));
    });
    killer.once('close', (code, signal) => {
      if (code === 0) finish();
      else {
        try { child.kill('SIGKILL'); } catch { /* best-effort direct fallback */ }
        finish(new Error(`taskkill failed for hook process tree ${pid} (exit ${code ?? 'unknown'}${signal ? `, signal ${signal}` : ''})`));
      }
    });
  });
}

function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/**
 * Evaluate preToolUse hooks against an explicit hook list (DB-independent, for testing).
 * Returns `{ block: true }` if any hook denies, or if a `blocking` hook errors/times out.
 * Non-blocking hook failures are ignored (fail-open).
 */
export async function evaluatePreToolUse(
  hooks: HookDefinition[],
  toolName: string,
  args: Record<string, unknown>,
  ctx?: HookContext
): Promise<PreToolUseOutcome> {
  for (const hook of filterHooks(hooks, 'preToolUse', toolName)) {
    const payload = JSON.stringify({ event: 'preToolUse', toolName, args, cwd: ctx?.cwd, conversationId: ctx?.conversationId });
    const outcome = await runHookCommand(hook, payload);
    if (outcome.errored) {
      logger.warn('hooks', `preToolUse hook failed for ${toolName}: ${outcome.feedback ?? 'unknown error'}`);
      if (hook.blocking) return { block: true, feedback: outcome.feedback || 'hook failed (blocking)' };
      continue;
    }
    if (outcome.decision === 'deny') return { block: true, feedback: outcome.feedback };
  }
  return { block: false };
}

/**
 * Run postToolUse hooks against an explicit hook list (DB-independent, for testing).
 * Observational: hook failures are logged but never affect the returned result.
 */
export async function evaluatePostToolUse(
  hooks: HookDefinition[],
  toolName: string,
  args: Record<string, unknown>,
  result: { content: string; isError?: boolean },
  ctx?: HookContext
): Promise<void> {
  for (const hook of filterHooks(hooks, 'postToolUse', toolName)) {
    const payload = JSON.stringify({
      event: 'postToolUse',
      toolName,
      args,
      result: { content: result.content, isError: Boolean(result.isError) },
      cwd: ctx?.cwd,
      conversationId: ctx?.conversationId
    });
    const outcome = await runHookCommand(hook, payload);
    if (outcome.errored) logger.warn('hooks', `postToolUse hook failed for ${toolName}: ${outcome.feedback ?? 'unknown error'}`);
  }
}

/** preToolUse dispatch using the configured `hooks` setting. */
export function runPreToolUse(toolName: string, args: Record<string, unknown>, ctx?: HookContext): Promise<PreToolUseOutcome> {
  const hooks = loadHooks();
  if (hooks.length === 0) return Promise.resolve({ block: false });
  return evaluatePreToolUse(hooks, toolName, args, ctx);
}

/** postToolUse dispatch using the configured `hooks` setting. */
export function runPostToolUse(
  toolName: string,
  args: Record<string, unknown>,
  result: { content: string; isError?: boolean },
  ctx?: HookContext
): Promise<void> {
  const hooks = loadHooks();
  if (hooks.length === 0) return Promise.resolve();
  return evaluatePostToolUse(hooks, toolName, args, result, ctx);
}
