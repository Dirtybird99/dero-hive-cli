import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'dero-hive-logger-'));
process.env.HIVE_DATA_DIR = dataDir;
// Hermetic env: level filtering and console routing read these on every call.
delete process.env.HIVE_DEBUG;
delete process.env.HIVE_TUI;
delete process.env.HIVE_CLI;

try {
  const { logger, redactSensitive } = await import('./logger.js');
  assert.doesNotMatch(redactSensitive('Authorization: Bearer top-secret-token'), /top-secret-token/u);
  assert.doesNotMatch(redactSensitive('Bearer sk-secret123'), /sk-secret123/u);
  assert.doesNotMatch(redactSensitive('API key provided: sk-secret123'), /sk-secret123/u);
  assert.doesNotMatch(redactSensitive('https://user:password@example.test/v1'), /user|password/u);
  assert.doesNotMatch(redactSensitive('https://standalone-token@example.test/v1'), /standalone-token/u);
  assert.doesNotMatch(redactSensitive('https://example.test/callback?code=login-code&token=access-token'), /login-code|access-token/u);
  assert.doesNotMatch(redactSensitive('{"apiKey":"provider-key","password":"password-value"}'), /provider-key|password-value/u);

  // --- redaction: case variations ---
  assert.equal(redactSensitive('AUTHORIZATION: BEARER UPPER-SECRET-1'), 'AUTHORIZATION: BEARER [REDACTED]');
  assert.equal(redactSensitive('bearer lower-secret-2'), 'bearer [REDACTED]');
  assert.equal(redactSensitive('PASSWORD=CAPS-PW-3'), 'PASSWORD=[REDACTED]');

  // --- redaction: key-name separators, header names, and quoting styles ---
  assert.equal(redactSensitive('Api-Key: dash-key-1'), 'Api-Key: [REDACTED]');
  assert.equal(redactSensitive('api key: space-key-2'), 'api key: [REDACTED]');
  assert.equal(redactSensitive('API_KEY=under-key-3'), 'API_KEY=[REDACTED]');
  assert.equal(redactSensitive('X-Api-Key: header-key-4'), 'X-Api-Key: [REDACTED]');
  assert.equal(redactSensitive('client_secret: cs-99'), 'client_secret: [REDACTED]');
  assert.equal(redactSensitive('secret="dq-secret-1"'), 'secret="[REDACTED]"');
  assert.equal(redactSensitive("id_token='sq-idt-1'"), "id_token='[REDACTED]'");
  assert.equal(redactSensitive('password is: hunter2'), 'password is: [REDACTED]');
  assert.equal(redactSensitive('token was: tok-was-2'), 'token was: [REDACTED]');

  // --- redaction: query-string keyword list ---
  assert.equal(redactSensitive('https://x.test/v1?apikey=ak-3'), 'https://x.test/v1?apikey=[REDACTED]');
  assert.equal(redactSensitive('https://x.test/v1?refresh_token=rt-9'), 'https://x.test/v1?refresh_token=[REDACTED]');
  // Non-sensitive params survive when the sensitive key is only in the
  // query-string keyword list (code= is not a key:value keyword).
  assert.equal(redactSensitive('https://x.test/v1?code=c-1&state=keepme'), 'https://x.test/v1?code=[REDACTED]&state=keepme');
  // When the first sensitive param is also a key:value keyword, that pass
  // swallows the rest of the query string (over-redaction, not a leak).
  assert.equal(
    redactSensitive('https://x.test/cb?access_token=at-1&refresh_token=rt-1&id_token=idt-1'),
    'https://x.test/cb?access_token=[REDACTED]'
  );
  assert.equal(
    redactSensitive('https://x.test/v1?api-key=ak-1&api_key=ak-2&apikey=ak-3'),
    'https://x.test/v1?api-key=[REDACTED]'
  );

  // --- redaction: nested JSON and provider-error stack traces ---
  assert.equal(
    redactSensitive('{"error":{"providers":[{"apiKey":"nested-key-1","token":"nested-tok-2"}]}}'),
    '{"error":{"providers":[{"apiKey":"[REDACTED]","token":"[REDACTED]"}]}}'
  );
  const providerError = redactSensitive(
    'Error: 401 Unauthorized {"headers":{"authorization":"Bearer err-tok-1"}}\n    at fetchProvider (src/main/providers/service.ts:42:11)'
  );
  assert.doesNotMatch(providerError, /err-tok-1/u);
  assert.match(providerError, /"authorization":"Bearer \[REDACTED\]"/u);
  assert.match(providerError, /at fetchProvider \(src\/main\/providers\/service\.ts:42:11\)/u, 'stack frames survive redaction');

  // Bearer values only match [A-Za-z0-9._~+/=-]; a tail outside that charset survives.
  assert.equal(redactSensitive('Bearer abc!@#rest'), 'Bearer [REDACTED]!@#rest');

  // --- FORMERLY KNOWN GAPS (now fixed) ---
  // These pinned secret shapes that leaked; they now assert redaction happens.
  // FIXED: Basic auth — the base64 credentials after "Basic" are redacted.
  assert.equal(redactSensitive('Authorization: Basic dXNlcjpwYXNzd29yZA=='), 'Authorization: Basic [REDACTED]');
  // FIXED: "is/was" phrasing no longer requires a ':' or '=' — prose is redacted.
  assert.equal(redactSensitive('password is hunter2'), 'password is [REDACTED]');
  assert.equal(redactSensitive('token was tok-was-1'), 'token was [REDACTED]');
  // FIXED: env-style names where the keyword is not adjacent to the separator.
  assert.equal(redactSensitive('AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG'), 'AWS_SECRET_ACCESS_KEY=[REDACTED]'); // gitleaks:allow -- intentional redaction fixture
  // ...but uppercase counters where TOKEN is not name-final are not env secrets.
  assert.equal(redactSensitive('MAX_TOKENS=4096'), 'MAX_TOKENS=4096');
  // FIXED: bare provider keys (well-known prefixes with a long-enough tail) are
  // redacted even with no keyword/Bearer/URL context; short tails survive so
  // ordinary hyphenated words are not swallowed.
  assert.equal(redactSensitive('provider rejected key sk-proj-abc123def456'), 'provider rejected key [REDACTED]');
  assert.equal(redactSensitive('push done ghp_abcdef123456789012 ok'), 'push done [REDACTED] ok');
  assert.equal(redactSensitive('short sk-tail1 survives'), 'short sk-tail1 survives');

  logger.debug('test', 'debug apiKey=debug-secret');
  assert.equal(existsSync(join(dataDir, 'logs', 'hive.log')), false, 'debug logs stay disabled unless HIVE_DEBUG is set');
  logger.info('test', 'request failed', { authorization: 'Bearer persisted-secret' });
  const log = readFileSync(join(dataDir, 'logs', 'hive.log'), 'utf8');
  assert.doesNotMatch(log, /persisted-secret/u);
  assert.match(log, /\[REDACTED\]/u);

  const logFile = join(dataDir, 'logs', 'hive.log');
  if (process.platform !== 'win32') {
    assert.equal(statSync(join(dataDir, 'logs')).mode & 0o777, 0o700);
    assert.equal(statSync(logFile).mode & 0o777, 0o600);
  }

  // --- level filtering: HIVE_DEBUG=1 enables the debug level ---
  process.env.HIVE_DEBUG = '1';
  try {
    logger.debug('dbg', 'debug enabled apiKey=dbg-secret-1', { refresh_token: 'dbg-refresh-2' });
    const dbgLog = readFileSync(logFile, 'utf8');
    assert.match(dbgLog, /\[DEBUG\] \[dbg\] debug enabled apiKey=\[REDACTED\] \{"refresh_token":"\[REDACTED\]"\}/u);
    assert.doesNotMatch(dbgLog, /dbg-secret-1|dbg-refresh-2/u);
  } finally {
    delete process.env.HIVE_DEBUG;
  }

  // --- warn/error levels, console routing, and HIVE_TUI/HIVE_CLI suppression ---
  const logged: string[] = [];
  const warned: string[] = [];
  const errored: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  try {
    console.log = (...a: unknown[]) => { logged.push(a.join(' ')); };
    console.warn = (...a: unknown[]) => { warned.push(a.join(' ')); };
    console.error = (...a: unknown[]) => { errored.push(a.join(' ')); };

    logger.warn('prov', 'rate limited', { authorization: 'Bearer warn-secret-1' });
    logger.error('prov', 'request rejected token=err-secret-2');
    assert.equal(warned.length, 1, 'warn routes to console.warn');
    assert.equal(errored.length, 1, 'error routes to console.error');
    assert.equal(logged.length, 0, 'warn/error never route to console.log');
    assert.match(warned[0], /\[WARN\] \[prov\] rate limited \{"authorization":"Bearer \[REDACTED\]"\}/u);
    assert.doesNotMatch(warned[0], /warn-secret-1/u);
    assert.match(errored[0], /\[ERROR\] \[prov\] request rejected token=\[REDACTED\]/u);
    assert.doesNotMatch(errored[0], /err-secret-2/u);

    process.env.HIVE_TUI = '1';
    logger.info('tui', 'tui mode api_key=tui-secret-3');
    delete process.env.HIVE_TUI;
    process.env.HIVE_CLI = '1';
    logger.warn('cli', 'cli mode password=cli-secret-4');
    delete process.env.HIVE_CLI;
    assert.equal(logged.length, 0, 'HIVE_TUI=1 suppresses console output');
    assert.equal(warned.length, 1, 'HIVE_CLI=1 suppresses console output');
  } finally {
    console.log = orig.log;
    console.warn = orig.warn;
    console.error = orig.error;
    delete process.env.HIVE_TUI;
    delete process.env.HIVE_CLI;
  }
  // ...but the file sink still receives the redacted lines while suppressed.
  const sinkLog = readFileSync(logFile, 'utf8');
  assert.match(sinkLog, /\[INFO\] \[tui\] tui mode api_key=\[REDACTED\]/u);
  assert.match(sinkLog, /\[WARN\] \[cli\] cli mode password=\[REDACTED\]/u);
  assert.doesNotMatch(sinkLog, /warn-secret-1|err-secret-2|tui-secret-3|cli-secret-4/u);

  // --- meta formatting: nested objects/arrays/URLs are redacted post-stringify ---
  logger.info('meta', 'provider config dump', {
    error: {
      providers: [{ apiKey: 'nested-meta-key-1' }],
      urls: ['https://metauser:metapass@h.test/v1?token=meta-qtok-2']
    }
  });
  let metaLog = readFileSync(logFile, 'utf8');
  assert.doesNotMatch(metaLog, /nested-meta-key-1|metauser|metapass|meta-qtok-2/u);
  assert.match(metaLog, /"apiKey":"\[REDACTED\]"/u);
  assert.match(metaLog, /https:\/\/\[REDACTED\]@h\.test/u);

  // Error instances serialize to '{}' via JSON.stringify: message and stack
  // (including any secret inside them) never reach the sinks.
  logger.error('meta', 'provider failure', new Error('token=err-meta-secret-5'));
  metaLog = readFileSync(logFile, 'utf8');
  assert.match(metaLog, /\[ERROR\] \[meta\] provider failure \{\}/u);
  assert.doesNotMatch(metaLog, /err-meta-secret-5/u);

  // Falsy meta (e.g. 0) is dropped entirely rather than serialized.
  logger.info('meta', 'zero-meta-marker', 0);
  metaLog = readFileSync(logFile, 'utf8');
  assert.match(metaLog, /zero-meta-marker\n/u);

  // Non-serializable meta never throws out of a log call: BigInt values are
  // stringified via a replacer and circular meta falls back to a placeholder.
  const circular: { self?: unknown } = {};
  circular.self = circular;
  assert.doesNotThrow(() => logger.info('meta', 'circular meta', circular));
  assert.doesNotThrow(() => logger.warn('meta', 'bigint meta', { count: 1n }));
  metaLog = readFileSync(logFile, 'utf8');
  assert.match(metaLog, /\[INFO\] \[meta\] circular meta \[unserializable meta\]/u);
  assert.match(metaLog, /\[WARN\] \[meta\] bigint meta \{"count":"1"\}/u);

  // --- file sink write failure: swallowed, never recreated once initialized ---
  rmSync(join(dataDir, 'logs'), { recursive: true, force: true });
  process.env.HIVE_TUI = '1';
  try {
    assert.doesNotThrow(() => logger.info('sink', 'after log dir removal'));
  } finally {
    delete process.env.HIVE_TUI;
  }
  assert.equal(existsSync(logFile), false, 'append failures are swallowed and the log dir is not recreated after init');

  console.log('logger redaction tests passed');
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
