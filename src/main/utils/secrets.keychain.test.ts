import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

// Hermetic: point the store at a temp dir and drive the backend through the
// test seam, so this suite never touches the real OS keychain.
const dataDir = mkdtempSync(join(tmpdir(), 'dero-hive-secrets-kc-'));
process.env.HIVE_DATA_DIR = dataDir;
process.env.HIVE_CLI = '1';

const secretsFile = join(dataDir, 'secrets.json');
const readStore = (): Record<string, string> => JSON.parse(readFileSync(secretsFile, 'utf-8'));
const V2 = /^v2:[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]*={0,2}$/u;

try {
  const { setSecret, getSecret, __setKeychainKeyForTest } = await import('./secrets.js');
  const masterKey = randomBytes(32);

  // --- v2 round-trip under the sealed (keychain) backend ---
  __setKeychainKeyForTest(masterKey);
  setSecret('kc', 'sealed-secret-1');
  assert.equal(getSecret('kc'), 'sealed-secret-1');
  assert.match(readStore()['kc'], V2, 'sealed value is written with the v2 envelope');
  // The sealed ciphertext must not leak the plaintext to disk.
  assert.equal(readFileSync(secretsFile, 'utf-8').includes('sealed-secret-1'), false);

  // A v2 value is unreadable without the exact keychain key.
  __setKeychainKeyForTest(null); // machine backend has no v2 key
  assert.equal(getSecret('kc'), undefined, 'v2 value cannot be read without the keychain key');
  __setKeychainKeyForTest(randomBytes(32)); // wrong key
  assert.equal(getSecret('kc'), undefined, 'v2 value cannot be read with the wrong key');

  // --- lazy v1 → v2 migration ---
  __setKeychainKeyForTest(null); // machine backend writes v1
  setSecret('mig', 'migrate-me');
  assert.match(readStore()['mig'], /^v1:/u, 'written as v1 under the machine backend');

  __setKeychainKeyForTest(masterKey); // keychain now active
  assert.equal(getSecret('mig'), 'migrate-me', 'v1 value still decrypts once keychain is active');
  assert.match(readStore()['mig'], V2, 'reading under the keychain upgrades the value to v2');

  // Re-reads are stable and stay v2.
  assert.equal(getSecret('mig'), 'migrate-me');
  assert.match(readStore()['mig'], V2);

  console.log('secrets keychain (v2) tests passed');
} finally {
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.HIVE_CLI;
}
