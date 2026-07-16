import { spawn } from 'node:child_process';
import { getSetting } from '../db/client';
import { logger } from '../utils/logger';
import type { HookContext, HookDefinition, HookEvent } from './types';

const DEFAULT_TIMEOUT_MS = 5_000;

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
    let settled = false;
    let timedOut = false;
    let stdout = '';
    let stderr = '';

    const finish = (outcome: HookRunOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };

    let child;
    try {
      child = spawn(hook.command, { shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      return finish({ errored: true, feedback: err instanceof Error ? err.message : String(err) });
    }

    const timer = setTimeout(() => {
      timedOut = true;
      // Resolve immediately rather than waiting for 'close': with shell:true a
      // grandchild process can hold the stdio pipes open past kill(), so 'close'
      // may not fire for a long time. Best-effort terminate + detach the streams
      // so a runaway hook can never hang the caller.
      finish({ errored: true, feedback: `hook timed out after ${timeoutMs}ms` });
      killTree(child);
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.stdin?.destroy();
      child.unref();
    }, timeoutMs);

    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.stdin?.on('error', () => { /* ignore EPIPE if the hook exits before reading */ });
    child.on('error', (err) => finish({ errored: true, feedback: err.message }));
    child.on('close', (code) => {
      if (timedOut) return finish({ errored: true, feedback: `hook timed out after ${timeoutMs}ms` });
      let decision: 'allow' | 'deny' | undefined;
      let feedback: string | undefined;
      const parsed = tryParseJson(stdout);
      if (parsed && typeof parsed === 'object') {
        const d = (parsed as { decision?: unknown }).decision;
        if (d === 'allow' || d === 'deny') decision = d;
        const f = (parsed as { feedback?: unknown }).feedback;
        if (typeof f === 'string') feedback = f;
      }
      if (!decision) decision = code === 0 ? 'allow' : 'deny';
      finish({ decision, feedback: feedback ?? (stderr.trim() || undefined), errored: false });
    });

    try {
      child.stdin?.write(payload);
      child.stdin?.end();
    } catch {
      /* ignore — close/error handlers settle the promise */
    }
  });
}

/** Best-effort terminate a shell child and its descendants. `shell: true` means
 *  a plain kill() only reaps the shell, not the command it spawned, so on Windows
 *  we use `taskkill /T` to take down the whole tree. */
function killTree(child: ReturnType<typeof spawn>): void {
  if (!child.pid) {
    try { child.kill(); } catch { /* already gone */ }
    return;
  }
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
    } catch {
      try { child.kill(); } catch { /* already gone */ }
    }
  } else {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
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
