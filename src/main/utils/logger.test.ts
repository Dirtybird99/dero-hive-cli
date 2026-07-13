import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'dero-hive-logger-'));
process.env.HIVE_DATA_DIR = dataDir;

try {
  const { logger, redactSensitive } = await import('./logger.js');
  assert.doesNotMatch(redactSensitive('Authorization: Bearer top-secret-token'), /top-secret-token/u);
  assert.doesNotMatch(redactSensitive('Bearer sk-secret123'), /sk-secret123/u);
  assert.doesNotMatch(redactSensitive('API key provided: sk-secret123'), /sk-secret123/u);
  assert.doesNotMatch(redactSensitive('https://user:password@example.test/v1'), /user|password/u);
  assert.doesNotMatch(redactSensitive('https://standalone-token@example.test/v1'), /standalone-token/u);
  assert.doesNotMatch(redactSensitive('https://example.test/callback?code=login-code&token=access-token'), /login-code|access-token/u);
  assert.doesNotMatch(redactSensitive('{"apiKey":"provider-key","password":"password-value"}'), /provider-key|password-value/u);

  logger.debug('test', 'debug apiKey=debug-secret');
  assert.equal(existsSync(join(dataDir, 'logs', 'hive.log')), false, 'debug logs stay disabled unless HIVE_DEBUG is set');
  logger.info('test', 'request failed', { authorization: 'Bearer persisted-secret' });
  const log = readFileSync(join(dataDir, 'logs', 'hive.log'), 'utf8');
  assert.doesNotMatch(log, /persisted-secret/u);
  assert.match(log, /\[REDACTED\]/u);
  console.log('logger redaction tests passed');
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
