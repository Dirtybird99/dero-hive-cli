import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { paths } from './paths';
import { logger } from './logger';

// Headless storage uses a key derived from public machine identifiers. This
// deters casual inspection but is not an operating-system credential store.
const PREFIX = 'v1:';
let machineKey: Buffer | null = null;

function getMachineKey(): Buffer {
  if (machineKey) return machineKey;
  const seed = [
    process.platform,
    process.arch,
    process.env.USERNAME || process.env.USER || 'anon',
    process.env.COMPUTERNAME || 'unknown',
    paths.userData
  ].join('|');
  machineKey = scryptSync(seed, Buffer.from('hive-secrets-v1', 'utf-8'), 32);
  return machineKey;
}

interface SecretStore {
  [key: string]: string;
}

function loadStore(): SecretStore {
  if (!existsSync(paths.secrets)) return {};
  try {
    return JSON.parse(readFileSync(paths.secrets, 'utf-8'));
  } catch {
    return {};
  }
}

function saveStore(store: SecretStore): void {
  writeFileSync(paths.secrets, JSON.stringify(store, null, 2), { mode: 0o600 });
}

function encryptValue(value: string): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', getMachineKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf-8'), cipher.final()]);
  return PREFIX + [iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join(':');
}

function decryptValue(raw: string): string | undefined {
  if (raw.startsWith('v2:')) return undefined;
  try {
    const [ivB64, tagB64, encryptedB64] = (raw.startsWith(PREFIX) ? raw.slice(PREFIX.length) : raw).split(':');
    const decipher = createDecipheriv('aes-256-gcm', getMachineKey(), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedB64, 'base64')),
      decipher.final()
    ]).toString('utf-8');
  } catch {
    return undefined;
  }
}

export async function initSecrets(): Promise<void> {
  logger.warn('secrets', 'using a machine-derived key; secrets are obfuscated, not OS-keychain sealed');
}

export function setSecret(key: string, value: string): void {
  const store = loadStore();
  store[key] = encryptValue(value);
  saveStore(store);
}

export function getSecret(key: string): string | undefined {
  const raw = loadStore()[key];
  if (!raw) return undefined;
  const value = decryptValue(raw);
  if (value === undefined) logger.error('secrets', `failed to decrypt ${key}`);
  return value;
}

export function deleteSecret(key: string): void {
  const store = loadStore();
  delete store[key];
  saveStore(store);
}
