import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';

function getUserDataPath(): string {
  const dataDir = process.env.HIVE_DATA_DIR || join(homedir(), '.hive');
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
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
  get mcpConfigs() { return join(getUserDataPath(), 'mcp.json'); },
  get whisperBundled() { return join(resourcesRoot, 'whisper'); },
  get whisperUser() { return join(getUserDataPath(), 'whisper'); }
};

export function getDefaultWorkspace(): string {
  const dir = process.env.HIVE_WORKSPACE || join(getUserDataPath(), 'workspace');
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  } catch { /* ignore */ }
  return dir;
}

export function ensureDirs(): void {
  for (const dir of [paths.logs, paths.cache, paths.skills, paths.attachments, paths.artifacts, paths.media]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}
