import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { canonicalWorkspacePath } from '../../shared/workspace.js';

// Each scenario gets its own data dir under one temp root; paths.db re-reads
// HIVE_DATA_DIR on every access, so switching the env between closeDb/initDb
// cycles points the client at a fresh (or pre-seeded) database file.
const rootDir = mkdtempSync(join(tmpdir(), 'dero-hive-dbclient-'));
const freshDir = join(rootDir, 'fresh');
process.env.HIVE_DATA_DIR = freshDir;
process.env.HIVE_CLI = '1';

const { initDb, closeDb, getDb, getSetting, setSetting } = await import('./client.js');

const CURRENT_SCHEMA_VERSION = 14;

function tableNames(): Set<string> {
  const rows = getDb().prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

function indexNames(): Set<string> {
  const rows = getDb().prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

function columnNames(table: string): Set<string> {
  const rows = getDb().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

function schemaVersions(): number[] {
  return (getDb().prepare('SELECT version FROM schema_version ORDER BY version').all() as Array<{ version: number }>)
    .map((r) => r.version);
}

function runConcurrentInit(dataDir: string, worker: number): Promise<void> {
  const clientUrl = new URL('./client.ts', import.meta.url).href;
  const source = `
    const client = await import(${JSON.stringify(clientUrl)});
    await client.initDb();
    if (client.getDb().pragma('integrity_check', { simple: true }) !== 'ok') process.exit(2);
    client.closeDb();`;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], {
      cwd: process.cwd(),
      env: { ...process.env, HIVE_DATA_DIR: dataDir, HIVE_CLI: '1' },
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolvePromise();
      else reject(new Error(`concurrent init ${worker} exited ${code}: ${stderr}`));
    });
  });
}

try {
  // --- Before init: getDb throws, closeDb is a safe no-op ---
  assert.throws(() => getDb(), /DB not initialized/);
  assert.doesNotThrow(() => closeDb());
  assert.throws(() => getDb(), /DB not initialized/); // closeDb before init does not fabricate a handle

  // --- Fresh init: pragmas ---
  await initDb();
  const db = getDb();
  assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  assert.equal(db.pragma('synchronous', { simple: true }), 2); // FULL durability
  assert.equal(db.pragma('busy_timeout', { simple: true }), 5_000);
  if (process.platform !== 'win32') {
    for (const file of [join(freshDir, 'hive.db'), join(freshDir, 'hive.db-wal'), join(freshDir, 'hive.db-shm')]) {
      if (existsSync(file)) assert.equal(statSync(file).mode & 0o777, 0o600, `${file} is private`);
    }
  }

  // WAL readers keep seeing the last committed snapshot while a writer is in
  // flight, then observe the row immediately after commit.
  const reader = new Database(join(freshDir, 'hive.db'), { readonly: true });
  db.transaction(() => {
    db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run('wal-visible', 'true', 1);
    const during = reader.prepare('SELECT COUNT(*) AS count FROM settings WHERE key = ?').get('wal-visible') as { count: number };
    assert.equal(during.count, 0);
  }).immediate();
  const after = reader.prepare('SELECT COUNT(*) AS count FROM settings WHERE key = ?').get('wal-visible') as { count: number };
  assert.equal(after.count, 1);
  reader.close();

  // --- Fresh init: real schema (tables + indices from sqlite_master) ---
  const tables = tableNames();
  for (const expected of [
    'schema_version', 'settings', 'conversations', 'messages', 'messages_fts',
    'providers', 'mcp_servers', 'skills', 'projects', 'knowledge_outbox',
    'knowledge_automations', 'permissions', 'prompts', 'artifacts',
    'swarm_runs', 'swarm_tasks', 'media_providers', 'media_artifacts'
  ]) {
    assert.ok(tables.has(expected), `expected table ${expected} to exist`);
  }
  const indices = indexNames();
  for (const expected of [
    'idx_conv_updated', 'idx_conv_archived', 'idx_msg_conv', 'idx_knowledge_outbox_project',
    'idx_artifact_conv', 'idx_swarm_runs_updated', 'idx_swarm_tasks_run',
    'idx_media_artifacts_project', 'idx_media_artifacts_conv', 'idx_media_artifacts_status',
    'idx_msg_bookmarked' // created by migration v6 even on fresh installs
  ]) {
    assert.ok(indices.has(expected), `expected index ${expected} to exist`);
  }
  assert.ok(columnNames('conversations').has('workspace_path'));

  // --- Fresh init: every migration is recorded (2..14) ---
  assert.deepEqual(schemaVersions(), Array.from({ length: CURRENT_SCHEMA_VERSION - 1 }, (_, i) => i + 2));

  // --- Settings helpers ---
  assert.equal(getSetting('missing'), undefined);
  assert.equal(getSetting('missing', 42), 42);
  setSetting('round-trip', { nested: [1, 2, 3] });
  assert.deepEqual(getSetting('round-trip'), { nested: [1, 2, 3] });
  // A value that is not valid JSON comes back as the raw string (parse-failure branch).
  getDb().prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run('raw-key', 'not json{{', 1);
  assert.equal(getSetting('raw-key'), 'not json{{');
  // JSON.stringify(undefined) === undefined, which better-sqlite3 refuses to bind.
  assert.throws(() => setSetting('undef-key', undefined));

  // --- Foreign keys are enforced and cascade ---
  assert.throws(
    () => getDb().prepare(
      'INSERT INTO messages (id, conversation_id, role, content, created_at, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('m-orphan', 'no-such-conversation', 'user', 'hi', 1, 1),
    /FOREIGN KEY constraint failed/
  );
  getDb().prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run('c-cascade', 'Cascade', 1, 1);
  getDb().prepare(
    'INSERT INTO messages (id, conversation_id, role, content, created_at, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
  ).run('m-cascade', 'c-cascade', 'user', 'hello', 1, 1);
  getDb().prepare('DELETE FROM conversations WHERE id = ?').run('c-cascade');
  const orphans = getDb().prepare('SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?').get('c-cascade') as { count: number };
  assert.equal(orphans.count, 0);

  // --- initDb is idempotent: calling it again keeps all data, no duplicate migrations ---
  setSetting('persist-check', { n: 1 });
  getDb().prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run('c-keep', 'Keep me', 2, 2);
  const firstHandle = getDb();
  await initDb();
  assert.notEqual(getDb(), firstHandle); // a new handle replaces the global one
  assert.equal(firstHandle.open, false); // replacement never leaks the prior WAL handle
  assert.deepEqual(getSetting('persist-check'), { n: 1 });
  const kept = getDb().prepare('SELECT title FROM conversations WHERE id = ?').get('c-keep') as { title: string } | undefined;
  assert.equal(kept?.title, 'Keep me');
  assert.deepEqual(schemaVersions(), Array.from({ length: CURRENT_SCHEMA_VERSION - 1 }, (_, i) => i + 2)); // no duplicate rows

  // --- closeDb, then re-init against the same file: data survives, double-close is safe ---
  closeDb();
  assert.throws(() => getDb(), /DB not initialized/);
  assert.doesNotThrow(() => closeDb()); // second close is a no-op
  await initDb();
  assert.deepEqual(getSetting('persist-check'), { n: 1 });
  closeDb();

  // WAL negotiation can report SQLITE_BUSY without honoring busy_timeout.
  // Prove init retries that exact transient error instead of masking others.
  const retryDir = join(rootDir, 'wal-retry');
  process.env.HIVE_DATA_DIR = retryDir;
  const databasePrototype = Database.prototype as unknown as { pragma: (...args: unknown[]) => unknown };
  const originalPragma = databasePrototype.pragma;
  let walAttempts = 0;
  let injectedCode: string | undefined = 'SQLITE_BUSY';
  databasePrototype.pragma = function pragmaWithOneBusy(this: unknown, ...args: unknown[]): unknown {
    if (args[0] === 'journal_mode = WAL') {
      walAttempts += 1;
      if (injectedCode) {
        const code = injectedCode;
        injectedCode = undefined;
        throw Object.assign(new Error('injected SQLite failure'), { code });
      }
    }
    return originalPragma.apply(this, args);
  };
  try {
    await initDb();
    assert.equal(walAttempts, 2);
    closeDb();
    process.env.HIVE_DATA_DIR = join(rootDir, 'wal-non-busy');
    injectedCode = 'SQLITE_IOERR';
    await assert.rejects(initDb(), (error: unknown) => (error as { code?: string }).code === 'SQLITE_IOERR');
  } finally {
    databasePrototype.pragma = originalPragma;
    closeDb();
  }

  // Fresh startup is safe when several CLI processes negotiate WAL and run
  // the idempotent migration chain at the same time.
  const concurrentInitDir = join(rootDir, 'concurrent-init');
  mkdirSync(concurrentInitDir, { recursive: true });
  await Promise.all(Array.from({ length: 4 }, (_, worker) => runConcurrentInit(concurrentInitDir, worker)));
  process.env.HIVE_DATA_DIR = concurrentInitDir;
  await initDb();
  assert.equal(getDb().pragma('integrity_check', { simple: true }), 'ok');
  assert.deepEqual(schemaVersions(), Array.from({ length: CURRENT_SCHEMA_VERSION - 1 }, (_, i) => i + 2));
  closeDb();

  // A previously interrupted multi-column migration completes every missing
  // effect instead of being marked done after encountering one duplicate.
  const partialV5Dir = join(rootDir, 'partial-v5');
  mkdirSync(partialV5Dir, { recursive: true });
  const partialV5 = new Database(join(partialV5Dir, 'hive.db'));
  partialV5.exec(`
    CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      provider_id TEXT, model TEXT, system_prompt TEXT, pinned INTEGER DEFAULT 0, archived INTEGER DEFAULT 0,
      project_id TEXT, parent_id TEXT, total_tokens INTEGER DEFAULT 0, message_count INTEGER DEFAULT 0,
      preview TEXT, compaction_count INTEGER DEFAULT 0
    );
  `);
  partialV5.prepare('INSERT INTO schema_version (version, applied_at) VALUES (5, 1000)').run();
  partialV5.close();
  process.env.HIVE_DATA_DIR = partialV5Dir;
  await initDb();
  assert.ok(columnNames('conversations').has('compaction_count'));
  assert.ok(columnNames('conversations').has('last_compaction_at'));
  assert.ok(columnNames('conversations').has('tokens_saved_by_compaction'));
  assert.deepEqual(schemaVersions(), Array.from({ length: CURRENT_SCHEMA_VERSION - 4 }, (_, index) => index + 5));
  closeDb();

  // --- Legacy v1 database: migrations bring the schema to the current version without data loss ---
  const legacy1Dir = join(rootDir, 'legacy-v1');
  mkdirSync(legacy1Dir, { recursive: true });
  const seed1 = new Database(join(legacy1Dir, 'hive.db'));
  seed1.exec(`
    CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      provider_id TEXT, model TEXT, system_prompt TEXT, pinned INTEGER DEFAULT 0, archived INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0, message_count INTEGER DEFAULT 0, preview TEXT
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
      reasoning TEXT, tool_calls TEXT, tool_call_id TEXT, name TEXT, model TEXT, provider TEXT,
      usage TEXT, error TEXT, created_at INTEGER NOT NULL, sort_order INTEGER NOT NULL
    );
    CREATE TABLE providers (
      id TEXT PRIMARY KEY, preset_id TEXT, name TEXT NOT NULL, base_url TEXT NOT NULL,
      api_key_ref TEXT, enabled INTEGER DEFAULT 1, models TEXT, custom_headers TEXT, updated_at INTEGER NOT NULL
    );
    CREATE TABLE mcp_servers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER DEFAULT 1, command TEXT NOT NULL,
      args TEXT, env TEXT, cwd TEXT, timeout_ms INTEGER, trust INTEGER DEFAULT 0, updated_at INTEGER NOT NULL
    );
    CREATE TABLE skills (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, slash_command TEXT NOT NULL,
      prompt TEXT NOT NULL, enabled INTEGER DEFAULT 1, builtin INTEGER DEFAULT 0, category TEXT, updated_at INTEGER NOT NULL
    );
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT, color TEXT, path TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `);
  seed1.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(1, 1000);
  seed1.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run('legacy-key', JSON.stringify('legacy-value'), 1000);
  seed1.prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run('c-legacy', 'Legacy chat', 1000, 1000);
  seed1.prepare(
    'INSERT INTO messages (id, conversation_id, role, content, created_at, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
  ).run('m-legacy', 'c-legacy', 'user', 'legacy message', 1000, 1);
  seed1.prepare('INSERT INTO providers (id, name, base_url, updated_at) VALUES (?, ?, ?, ?)').run('p-legacy', 'Legacy provider', 'http://localhost', 1000);
  seed1.close();

  process.env.HIVE_DATA_DIR = legacy1Dir;
  await initDb();
  assert.deepEqual(schemaVersions(), Array.from({ length: CURRENT_SCHEMA_VERSION }, (_, i) => i + 1)); // 1..14
  assert.ok(columnNames('conversations').has('project_id')); // v3
  assert.ok(columnNames('conversations').has('parent_id')); // v4
  assert.ok(columnNames('conversations').has('compaction_count')); // v5
  assert.ok(columnNames('conversations').has('last_compaction_at'));
  assert.ok(columnNames('conversations').has('tokens_saved_by_compaction'));
  assert.ok(columnNames('conversations').has('workspace_path')); // v14
  assert.ok(columnNames('messages').has('bookmarked')); // v6
  assert.ok(columnNames('providers').has('models_fetched_at')); // v2
  assert.ok(columnNames('mcp_servers').has('transport')); // v7
  assert.ok(columnNames('mcp_servers').has('url'));
  assert.ok(columnNames('skills').has('source_dir')); // v8
  assert.ok(columnNames('projects').has('config')); // v9
  assert.ok(indexNames().has('idx_msg_bookmarked'));
  // Legacy data survives the whole migration chain.
  assert.equal(getSetting('legacy-key'), 'legacy-value');
  const legacyConv = getDb().prepare('SELECT title, project_id, workspace_path FROM conversations WHERE id = ?').get('c-legacy') as { title: string; project_id: string | null; workspace_path: string | null };
  assert.equal(legacyConv.title, 'Legacy chat');
  assert.equal(legacyConv.project_id, null); // new column backfills as NULL
  assert.equal(legacyConv.workspace_path, null); // unknown legacy scope is never guessed
  const legacyMsg = getDb().prepare('SELECT content, bookmarked FROM messages WHERE id = ?').get('m-legacy') as { content: string; bookmarked: number };
  assert.equal(legacyMsg.content, 'legacy message');
  assert.equal(legacyMsg.bookmarked, 0); // ALTER ... DEFAULT 0 backfill
  const legacyProvider = getDb().prepare('SELECT name FROM providers WHERE id = ?').get('p-legacy') as { name: string };
  assert.equal(legacyProvider.name, 'Legacy provider');
  closeDb();

  // --- Legacy v12 database: migration 13 rebuilds media_artifacts to allow 'audio', preserving rows ---
  const legacy12Dir = join(rootDir, 'legacy-v12');
  mkdirSync(legacy12Dir, { recursive: true });
  const seed12 = new Database(join(legacy12Dir, 'hive.db'));
  seed12.exec(`
    CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
    CREATE TABLE media_providers (
      id TEXT PRIMARY KEY, preset_id TEXT NOT NULL, name TEXT NOT NULL, base_url TEXT, api_key_ref TEXT,
      enabled INTEGER NOT NULL DEFAULT 1, default_image_model TEXT, default_video_model TEXT,
      image_models TEXT, video_models TEXT, custom_headers TEXT, default_options TEXT, updated_at INTEGER NOT NULL
    );
    CREATE TABLE media_artifacts (
      id TEXT PRIMARY KEY, conversation_id TEXT, message_id TEXT, project_id TEXT,
      kind TEXT NOT NULL CHECK(kind IN ('image', 'video')),
      provider_id TEXT NOT NULL, model TEXT NOT NULL, prompt TEXT NOT NULL, negative_prompt TEXT,
      width INTEGER, height INTEGER, duration_seconds REAL, seed INTEGER,
      relative_path TEXT NOT NULL, mime_type TEXT NOT NULL, bytes INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued', error TEXT, options TEXT,
      created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER
    );
  `);
  seed12.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(12, 2000);
  seed12.prepare(
    'INSERT INTO media_providers (id, preset_id, name, updated_at) VALUES (?, ?, ?, ?)'
  ).run('mp-legacy', 'preset-x', 'Legacy media provider', 2000);
  seed12.prepare(`
    INSERT INTO media_artifacts (id, kind, provider_id, model, prompt, relative_path, mime_type, bytes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('ma-legacy', 'image', 'mp-legacy', 'img-model', 'a cat', 'img/cat.png', 'image/png', 123, 2000);
  seed12.close();

  process.env.HIVE_DATA_DIR = legacy12Dir;
  await initDb();
  assert.deepEqual(schemaVersions(), [12, 13, 14]); // only the pending migrations ran
  assert.ok(columnNames('media_providers').has('default_audio_model'));
  assert.ok(columnNames('media_providers').has('audio_models'));
  const rebuiltSql = (getDb().prepare(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'media_artifacts'`
  ).get() as { sql: string }).sql;
  assert.ok(rebuiltSql.includes("'audio'")); // CHECK now admits audio
  const legacyArtifact = getDb().prepare('SELECT kind, prompt, status FROM media_artifacts WHERE id = ?')
    .get('ma-legacy') as { kind: string; prompt: string; status: string };
  assert.deepEqual(legacyArtifact, { kind: 'image', prompt: 'a cat', status: 'queued' }); // rows copied through the rebuild
  assert.doesNotThrow(() => getDb().prepare(`
    INSERT INTO media_artifacts (id, kind, provider_id, model, prompt, relative_path, mime_type, bytes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('ma-audio', 'audio', 'mp-legacy', 'tts-model', 'say hi', 'audio/hi.mp3', 'audio/mpeg', 456, 3000));
  assert.throws(() => getDb().prepare(`
    INSERT INTO media_artifacts (id, kind, provider_id, model, prompt, relative_path, mime_type, bytes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('ma-bad', 'document', 'mp-legacy', 'x', 'x', 'x', 'x', 1, 3000), /CHECK constraint failed/);
  assert.ok(indexNames().has('idx_media_artifacts_status')); // indices recreated after the rebuild
  const legacyMediaProvider = getDb().prepare('SELECT name, default_audio_model FROM media_providers WHERE id = ?')
    .get('mp-legacy') as { name: string; default_audio_model: string | null };
  assert.equal(legacyMediaProvider.name, 'Legacy media provider');
  assert.equal(legacyMediaProvider.default_audio_model, null); // new column backfills as NULL
  closeDb();

  // --- Legacy v13: project-bound conversations gain canonical scope; truly
  // unscoped history stays NULL so callers cannot guess and cross workspaces. ---
  const legacy13Dir = join(rootDir, 'legacy-v13');
  const legacyWorkspace = join(rootDir, 'legacy-workspace');
  mkdirSync(legacy13Dir, { recursive: true });
  mkdirSync(legacyWorkspace, { recursive: true });
  const seed13 = new Database(join(legacy13Dir, 'hive.db'));
  seed13.exec(`
    CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT DEFAULT '📁', color TEXT, path TEXT NOT NULL,
      config TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      provider_id TEXT, model TEXT, system_prompt TEXT, pinned INTEGER DEFAULT 0, archived INTEGER DEFAULT 0,
      project_id TEXT REFERENCES projects(id), parent_id TEXT, total_tokens INTEGER DEFAULT 0,
      message_count INTEGER DEFAULT 0, preview TEXT, compaction_count INTEGER DEFAULT 0,
      last_compaction_at INTEGER, tokens_saved_by_compaction INTEGER DEFAULT 0
    );
  `);
  seed13.prepare('INSERT INTO schema_version (version, applied_at) VALUES (13, 3000)').run();
  seed13.prepare(`
    INSERT INTO projects (id, name, path, created_at, updated_at) VALUES ('legacy-project', 'Legacy', ?, 1, 1)
  `).run(legacyWorkspace);
  seed13.prepare(`
    INSERT INTO conversations (id, title, created_at, updated_at, project_id)
    VALUES ('legacy-scoped', 'Scoped', 1, 1, 'legacy-project'), ('legacy-unscoped', 'Unscoped', 1, 1, NULL)
  `).run();
  seed13.close();
  process.env.HIVE_DATA_DIR = legacy13Dir;
  await initDb();
  assert.deepEqual(schemaVersions(), [13, 14]);
  const migratedScopes = getDb().prepare(
    'SELECT id, workspace_path FROM conversations ORDER BY id'
  ).all() as Array<{ id: string; workspace_path: string | null }>;
  assert.deepEqual(migratedScopes, [
    { id: 'legacy-scoped', workspace_path: canonicalWorkspacePath(legacyWorkspace) },
    { id: 'legacy-unscoped', workspace_path: null }
  ]);
} finally {
  closeDb();
  rmSync(rootDir, { recursive: true, force: true });
}
