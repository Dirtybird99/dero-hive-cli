import { join } from 'node:path';
import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
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
        if (!existsSync(paths.logs)) mkdirSync(paths.logs, { recursive: true });
      }
    }
    initialized = true;
  } catch {
    // Logging is best-effort; never crash the app over it
  }
}

function safeAppend(line: string): void {
  try { ensureLogDir(); appendFileSync(join(paths.logs, 'hive.log'), line + '\n'); }
  catch { /* swallow */ }
}

export function redactSensitive(value: string): string {
  return value
    .replace(/(https?:\/\/)[^/\s@]+@/giu, '$1[REDACTED]@')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/giu, '$1[REDACTED]')
    .replace(/([?&](?:code|token|api[_-]?key|access_token|refresh_token|id_token)=)[^&\s]+/giu, '$1[REDACTED]')
    .replace(/((?:authorization|api[_ -]?key|access_token|refresh_token|id_token|password|client_secret|secret|token)(?:\s+(?:provided|is|was))?["']?\s*[:=]\s*["']?(?:Bearer\s+)?)[^"',\s}]+/giu, '$1[REDACTED]');
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
    const line = redactSensitive(format('debug', scope, msg) + (meta ? ` ${JSON.stringify(meta)}` : ''));
    if (canWriteConsole()) console.log(line);
    safeAppend(line);
  },
  info(scope: string, msg: string, meta?: unknown): void {
    const line = redactSensitive(format('info', scope, msg) + (meta ? ` ${JSON.stringify(meta)}` : ''));
    if (canWriteConsole()) console.log(line);
    safeAppend(line);
  },
  warn(scope: string, msg: string, meta?: unknown): void {
    const line = redactSensitive(format('warn', scope, msg) + (meta ? ` ${JSON.stringify(meta)}` : ''));
    if (canWriteConsole()) console.warn(line);
    safeAppend(line);
  },
  error(scope: string, msg: string, meta?: unknown): void {
    const line = redactSensitive(format('error', scope, msg) + (meta ? ` ${JSON.stringify(meta)}` : ''));
    if (canWriteConsole()) console.error(line);
    safeAppend(line);
  }
};
