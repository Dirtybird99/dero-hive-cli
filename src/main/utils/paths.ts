import { join } from 'node:path';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';

const PRIVATE_DIR_MODE = 0o700;

function ensurePrivateDir(dir: string, tightenExisting: boolean): void {
  const existed = existsSync(dir);
  if (!existed) mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  if (process.platform !== 'win32' && (!existed || tightenExisting)) chmodSync(dir, PRIVATE_DIR_MODE);
}

export function ensurePrivateDataDir(dir: string): void {
  ensurePrivateDir(dir, true);
}

function getUserDataPath(): string {
  const explicitDataDir = process.env.HIVE_DATA_DIR;
  const dataDir = explicitDataDir || join(homedir(), '.hive');
  // Existing custom roots may be shared intentionally, so only tighten a root
  // Hive created or the app-owned default. App-owned children stay private.
  ensurePrivateDir(dataDir, !explicitDataDir);
  return dataDir;
}

export const resourcesRoot = process.env.HIVE_RESOURCES || join(process.cwd(), 'resources');

export const paths = {
  get userData() { return getUserDataPath(); },
  get logs() { return join(getUserDataPath(), 'logs'); },
  get db() { return join(getUserDataPath(), 'hive.db'); },
  get cache() { return join(getUserDataPath(), 'cache'); },
  get secrets() { return join(getUserDataPath(), 'secrets.json'); },
  get skills() { return join(getUserDataPath(), 'skills'); },
  get attachments() { return join(getUserDataPath(), 'attachments'); },
  get artifacts() { return join(getUserDataPath(), 'artifacts'); },
  get media() { return join(getUserDataPath(), 'media'); },
  get cli() { return join(getUserDataPath(), 'cli'); },
  get simulator() { return join(getUserDataPath(), 'simulator'); },
  get simulatorData() { return join(getUserDataPath(), 'simulator-data'); },
  get mcpConfigs() { return join(getUserDataPath(), 'mcp.json'); },
  get whisperBundled() { return join(resourcesRoot, 'whisper'); },
  get whisperUser() { return join(getUserDataPath(), 'whisper'); }
};

export function getDefaultWorkspace(): string {
  const explicitWorkspace = process.env.HIVE_WORKSPACE;
  const dir = explicitWorkspace || join(getUserDataPath(), 'workspace');
  try {
    ensurePrivateDir(dir, !explicitWorkspace);
  } catch { /* ignore */ }
  return dir;
}

export function ensureDirs(): void {
  for (const dir of [paths.logs, paths.cache, paths.skills, paths.attachments, paths.artifacts, paths.media, paths.cli, paths.simulator, paths.simulatorData]) {
    ensurePrivateDataDir(dir);
  }
}
