import { join } from 'node:path';
import { appendFileSync, chmodSync, mkdirSync, existsSync } from 'node:fs';
import { paths } from './paths';
import { ensureDirs } from './paths';

type Level = 'debug' | 'info' | 'warn' | 'error';

let initialized = false;
function ensureLogDir(): void {
  if (initialized) return;
  try {
    if (!existsSync(paths.logs)) {
      // Use the full ensureDirs helper; falls back to mkdirSync on failure
      try { ensureDirs(); }
      catch {
        if (!existsSync(paths.logs)) mkdirSync(paths.logs, { recursive: true, mode: 0o700 });
      }
    }
    initialized = true;
  } catch {
    // Logging is best-effort; never crash the app over it
  }
}

function safeAppend(line: string): void {
  try {
    ensureLogDir();
    const logPath = join(paths.logs, 'hive.log');
    appendFileSync(logPath, line + '\n', { mode: 0o600 });
    if (process.platform !== 'win32') chmodSync(logPath, 0o600);
  }
  catch { /* swallow */ }
}

export function redactSensitive(value: string): string {
  return value
    .replace(/(https?:\/\/)[^/\s@]+@/giu, '$1[REDACTED]@')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/giu, '$1[REDACTED]')
    // Bare provider keys (sk-..., sk-proj-..., ghp_..., xoxb-...) with no other
    // context. Case-sensitive on purpose; the minimum tail length keeps ordinary
    // hyphenated words (e.g. sk-tail1) from being swallowed.
    .replace(/\b(?:sk|ghp|gho|ghu|ghs|ghr|github_pat|glpat|xox[abprs]|xapp)[-_][A-Za-z0-9_-]{12,}/gu, '[REDACTED]')
    .replace(/([?&](?:code|token|api[_-]?key|access_token|refresh_token|id_token)=)[^&\s]+/giu, '$1[REDACTED]')
    // Env-style secret names (AWS_SECRET_ACCESS_KEY=...). Uppercase-only on
    // purpose; TOKEN must end the name so counters like MAX_TOKENS=4096 survive.
    .replace(/((?:[A-Z0-9_]*(?:SECRET|PASSWORD|PASSWD|CREDENTIALS?|API_?KEY|ACCESS_KEY|PRIVATE_KEY)[A-Z0-9_]*|[A-Z0-9_]*TOKEN)\s*[:=]\s*)[^"',\s}]+/gu, '$1[REDACTED]')
    .replace(/((?:authorization|api[_ -]?key|access_token|refresh_token|id_token|password|client_secret|secret|token)(?:(?:\s+(?:provided|is|was))?["']?\s*[:=]\s*["']?|\s+(?:provided|is|was)\s+)(?:(?:Bearer|Basic)\s+)?)[^"',\s}]+/giu, '$1[REDACTED]');
}

function safeStringify(meta: unknown): string {
  // Log calls must never throw: BigInt meta is stringified via the replacer,
  // and anything JSON.stringify still rejects (e.g. circular refs) falls back.
  try {
    return JSON.stringify(meta, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) ?? '[unserializable meta]';
  } catch {
    return '[unserializable meta]';
  }
}

function format(level: Level, scope: string, msg: string): string {
  const ts = new Date().toISOString();
  return redactSensitive(`[${ts}] [${level.toUpperCase()}] [${scope}] ${msg}`);
}

function canWriteConsole(): boolean {
  return process.env.HIVE_TUI !== '1' && process.env.HIVE_CLI !== '1';
}

export const logger = {
  debug(scope: string, msg: string, meta?: unknown): void {
    if (!process.env.HIVE_DEBUG) return;
    const line = redactSensitive(format('debug', scope, msg) + (meta ? ` ${safeStringify(meta)}` : ''));
    if (canWriteConsole()) console.log(line);
    safeAppend(line);
  },
  info(scope: string, msg: string, meta?: unknown): void {
    const line = redactSensitive(format('info', scope, msg) + (meta ? ` ${safeStringify(meta)}` : ''));
    if (canWriteConsole()) console.log(line);
    safeAppend(line);
  },
  warn(scope: string, msg: string, meta?: unknown): void {
    const line = redactSensitive(format('warn', scope, msg) + (meta ? ` ${safeStringify(meta)}` : ''));
    if (canWriteConsole()) console.warn(line);
    safeAppend(line);
  },
  error(scope: string, msg: string, meta?: unknown): void {
    const line = redactSensitive(format('error', scope, msg) + (meta ? ` ${safeStringify(meta)}` : ''));
    if (canWriteConsole()) console.error(line);
    safeAppend(line);
  }
};
