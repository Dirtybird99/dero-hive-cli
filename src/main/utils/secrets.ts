import { closeSync, existsSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
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
const MASTER_KEY_LOCK_FILE = '.dero-hive-secrets-master-key-v2.lock';
const LOCK_WAIT_MS = 10_000;
const INCOMPLETE_LOCK_STALE_MS = 30_000;

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

function loadStore(forMutation = false): SecretStore {
  if (!existsSync(paths.secrets)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(paths.secrets, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || Object.values(parsed).some((value) => typeof value !== 'string')) {
      throw new Error('secret store must be an object of encrypted strings');
    }
    return parsed as SecretStore;
  } catch (error) {
    if (forMutation) throw new Error('Secret store is corrupt; refusing to overwrite it.', { cause: error });
    logger.error('secrets', 'secret store is corrupt; reads fail closed');
    return {};
  }
}

function saveStore(store: SecretStore): void {
  const temporary = `${paths.secrets}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(store, null, 2), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, paths.secrets);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function lockOwnerIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function reapStaleLock(path: string): void {
  try {
    const raw = readFileSync(path, 'utf8');
    const owner = JSON.parse(raw) as { pid?: number };
    if (lockOwnerIsAlive(owner.pid ?? 0)) return;
    if (readFileSync(path, 'utf8') === raw) rmSync(path, { force: true });
  } catch {
    try {
      if (Date.now() - statSync(path).mtimeMs >= INCOMPLETE_LOCK_STALE_MS) rmSync(path, { force: true });
    } catch { /* another process changed the lock */ }
  }
}

function withFileLock<T>(path: string, operation: () => T): T {
  const deadline = Date.now() + LOCK_WAIT_MS;
  const token = JSON.stringify({ pid: process.pid, nonce: randomBytes(12).toString('hex') });
  while (true) {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(path, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      reapStaleLock(path);
      if (Date.now() >= deadline) {
        throw new Error('Secret store is busy; timed out waiting for another Hive process.', { cause: error });
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      continue;
    }
    try {
      writeFileSync(descriptor, token, 'utf8');
    } catch (error) {
      rmSync(path, { force: true });
      throw error;
    } finally {
      closeSync(descriptor);
    }
    try {
      return operation();
    } finally {
      try {
        if (readFileSync(path, 'utf8') === token) rmSync(path, { force: true });
      } catch { /* lock already disappeared */ }
    }
  }
}

function withStoreLock<T>(operation: () => T): T {
  return withFileLock(`${paths.secrets}.lock`, operation);
}

function masterKeyLockPath(): string {
  return join(homedir(), MASTER_KEY_LOCK_FILE);
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

function loadOrCreateMasterKey(
  getPassword: () => string | null,
  setPassword: (value: string) => void,
  lockPath: string
): Buffer {
  return withFileLock(lockPath, () => {
    let hex: string | null;
    try { hex = getPassword(); } catch { hex = null; }
    if (!hex || !/^[0-9a-f]{64}$/i.test(hex)) {
      setPassword(randomBytes(32).toString('hex'));
      hex = getPassword();
    }
    if (!hex || !/^[0-9a-f]{64}$/i.test(hex)) throw new Error('OS keychain did not retain a valid master key.');
    return Buffer.from(hex, 'hex');
  });
}

async function loadOrCreateKeychainMasterKey(): Promise<Buffer | null> {
  try {
    const { Entry } = await import('@napi-rs/keyring');
    const entry = new Entry(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
    return loadOrCreateMasterKey(
      () => entry.getPassword(),
      (value) => entry.setPassword(value),
      masterKeyLockPath()
    );
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
  withStoreLock(() => {
    const store = loadStore(true);
    store[key] = encryptValue(value);
    saveStore(store);
  });
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
      withStoreLock(() => {
        const current = loadStore(true);
        if (current[key] !== raw) return;
        current[key] = encryptValue(value);
        saveStore(current);
      });
    } catch (err) {
      logger.warn('secrets', `v1→v2 migration failed for ${key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return value;
}

export function deleteSecret(key: string): void {
  if (!existsSync(paths.secrets)) return;
  withStoreLock(() => {
    const store = loadStore(true);
    if (!(key in store)) return;
    delete store[key];
    saveStore(store);
  });
}

/**
 * Test-only seam: force the encryption backend without touching the real OS
 * keychain. Pass a 32-byte key for the sealed (v2) path, or null for machine (v1).
 */
export function __setKeychainKeyForTest(key: Buffer | null): void {
  backend = key ? { kind: 'keychain', key } : { kind: 'machine' };
}

/** Test-only seam for exercising first-run key creation across processes. */
export function __loadOrCreateMasterKeyForTest(
  getPassword: () => string | null,
  setPassword: (value: string) => void
): Buffer {
  return loadOrCreateMasterKey(getPassword, setPassword, masterKeyLockPath());
}

export function __masterKeyLockPathForTest(): string {
  return masterKeyLockPath();
}
