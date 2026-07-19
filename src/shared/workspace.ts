import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export function canonicalWorkspacePath(value: string, basePath = process.cwd()): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Workspace path is required.');
  const canonical = realpathSync.native(resolve(basePath, value));
  if (!statSync(canonical).isDirectory()) throw new Error(`Workspace is not a directory: ${value}`);
  return canonical;
}

export function sameWorkspacePath(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  try { return canonicalWorkspacePath(left) === canonicalWorkspacePath(right); }
  catch { return false; }
}
