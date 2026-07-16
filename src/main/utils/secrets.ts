import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { paths } from './paths';
import { logger } from './logger';

// Two at-rest backends:
//   v1  — a key derived from public machine identifiers. Obfuscation only: any
//         local process that can read the store can re-derive the key. Legacy
//         values (written before the "v1:" prefix existed) decrypt the same way.
//   v2  — AES-256-GCM under a random master key held in the OS keychain (via
//         @napi-rs/keyring). This is the sealed path; it is used once initSecrets
//         has resolved a keychain and is otherwise transparently skipped.
// The backend is resolved once by initSecrets(); until then (and whenever the
// keychain is unavailable or disabled) writes use v1 so the module always works.
const V1_PREFIX = 'v1:';
const V2_PREFIX = 'v2:';
const KEYCHAIN_SERVICE = 'dero-hive';
const KEYCHAIN_ACCOUNT = 'secrets-master-key-v2';

type Backend = { kind: 'machine' } | { kind: 'keychain'; key: Buffer };
let backend: Backend = { kind: 'machine' };
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

function encryptWith(value: string, key: Buffer, prefix: string): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf-8'), cipher.final()]);
  return prefix + [iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join(':');
}

function encryptValue(value: string): string {
  if (backend.kind === 'keychain') return encryptWith(value, backend.key, V2_PREFIX);
  return encryptWith(value, getMachineKey(), V1_PREFIX);
}

function decryptValue(raw: string): string | undefined {
  let key: Buffer;
  let body: string;
  if (raw.startsWith(V2_PREFIX)) {
    // v2 values are only decryptable while the keychain backend is active.
    if (backend.kind !== 'keychain') return undefined;
    key = backend.key;
    body = raw.slice(V2_PREFIX.length);
  } else {
    // v1 and legacy (prefixless) values both use the machine-derived key.
    key = getMachineKey();
    body = raw.startsWith(V1_PREFIX) ? raw.slice(V1_PREFIX.length) : raw;
  }
  try {
    const [ivB64, tagB64, encryptedB64] = body.split(':');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedB64, 'base64')),
      decipher.final()
    ]).toString('utf-8');
  } catch {
    return undefined;
  }
}

async function loadOrCreateKeychainMasterKey(): Promise<Buffer | null> {
  try {
    const { Entry } = await import('@napi-rs/keyring');
    const entry = new Entry(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
    let hex: string | null = null;
    try {
      hex = entry.getPassword();
    } catch {
      hex = null; // no existing entry
    }
    if (hex && /^[0-9a-f]{64}$/i.test(hex)) return Buffer.from(hex, 'hex');
    const fresh = randomBytes(32);
    entry.setPassword(fresh.toString('hex'));
    return fresh;
  } catch (err) {
    logger.warn('secrets', `OS keychain unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export async function initSecrets(): Promise<void> {
  if (process.env.HIVE_KEYCHAIN_DISABLED === '1') {
    backend = { kind: 'machine' };
    logger.warn('secrets', 'keychain disabled (HIVE_KEYCHAIN_DISABLED); using a machine-derived key, not OS-keychain sealed');
    return;
  }
  const key = await loadOrCreateKeychainMasterKey();
  if (key) {
    backend = { kind: 'keychain', key };
    logger.info('secrets', 'using OS keychain-sealed encryption (v2)');
  } else {
    backend = { kind: 'machine' };
    logger.warn('secrets', 'using a machine-derived key; secrets are obfuscated, not OS-keychain sealed');
  }
}

export function setSecret(key: string, value: string): void {
  const store = loadStore();
  store[key] = encryptValue(value);
  saveStore(store);
}

export function getSecret(key: string): string | undefined {
  const store = loadStore();
  const raw = store[key];
  if (!raw) return undefined;
  const value = decryptValue(raw);
  if (value === undefined) {
    logger.error('secrets', `failed to decrypt ${key}`);
    return undefined;
  }
  // Lazy migration: once the keychain backend is active, upgrade any v1/legacy
  // value to a v2 (sealed) envelope the next time it is read.
  if (backend.kind === 'keychain' && !raw.startsWith(V2_PREFIX)) {
    try {
      store[key] = encryptValue(value);
      saveStore(store);
    } catch (err) {
      logger.warn('secrets', `v1→v2 migration failed for ${key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return value;
}

export function deleteSecret(key: string): void {
  const store = loadStore();
  delete store[key];
  saveStore(store);
}

/**
 * Test-only seam: force the encryption backend without touching the real OS
 * keychain. Pass a 32-byte key for the sealed (v2) path, or null for machine (v1).
 */
export function __setKeychainKeyForTest(key: Buffer | null): void {
  backend = key ? { kind: 'keychain', key } : { kind: 'machine' };
}
