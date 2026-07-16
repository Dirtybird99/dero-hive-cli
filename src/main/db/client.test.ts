import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

// Each scenario gets its own data dir under one temp root; paths.db re-reads
// HIVE_DATA_DIR on every access, so switching the env between closeDb/initDb
// cycles points the client at a fresh (or pre-seeded) database file.
const rootDir = mkdtempSync(join(tmpdir(), 'dero-hive-dbclient-'));
const freshDir = join(rootDir, 'fresh');
process.env.HIVE_DATA_DIR = freshDir;
process.env.HIVE_CLI = '1';

const { initDb, closeDb, getDb, getSetting, setSetting } = await import('./client.js');

const CURRENT_SCHEMA_VERSION = 13;

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
  assert.equal(db.pragma('synchronous', { simple: true }), 1); // NORMAL

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

  // --- Fresh init: every migration is recorded (2..13), duplicate-column ones via INSERT OR IGNORE ---
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
  assert.equal(firstHandle.open, true); // quirk: the previous handle is left open (leaked), not closed
  firstHandle.close();
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
  assert.deepEqual(schemaVersions(), Array.from({ length: CURRENT_SCHEMA_VERSION }, (_, i) => i + 1)); // 1..13
  assert.ok(columnNames('conversations').has('project_id')); // v3
  assert.ok(columnNames('conversations').has('parent_id')); // v4
  assert.ok(columnNames('conversations').has('compaction_count')); // v5
  assert.ok(columnNames('conversations').has('last_compaction_at'));
  assert.ok(columnNames('conversations').has('tokens_saved_by_compaction'));
  assert.ok(columnNames('messages').has('bookmarked')); // v6
  assert.ok(columnNames('providers').has('models_fetched_at')); // v2
  assert.ok(columnNames('mcp_servers').has('transport')); // v7
  assert.ok(columnNames('mcp_servers').has('url'));
  assert.ok(columnNames('skills').has('source_dir')); // v8
  assert.ok(columnNames('projects').has('config')); // v9
  assert.ok(indexNames().has('idx_msg_bookmarked'));
  // Legacy data survives the whole migration chain.
  assert.equal(getSetting('legacy-key'), 'legacy-value');
  const legacyConv = getDb().prepare('SELECT title, project_id FROM conversations WHERE id = ?').get('c-legacy') as { title: string; project_id: string | null };
  assert.equal(legacyConv.title, 'Legacy chat');
  assert.equal(legacyConv.project_id, null); // new column backfills as NULL
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
  assert.deepEqual(schemaVersions(), [12, 13]); // only the pending migration ran
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
} finally {
  closeDb();
  rmSync(rootDir, { recursive: true, force: true });
}
