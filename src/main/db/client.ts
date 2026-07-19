import Database from 'better-sqlite3';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { paths } from '../utils/paths';
import { logger } from '../utils/logger';
import { canonicalWorkspacePath } from '../../shared/workspace';

const DB_GLOBAL_KEY = '__hive_db_instance__';
const DB_BUSY_TIMEOUT_MS = 5_000;

function getGlobalDb(): Database.Database | null {
  const g = globalThis as typeof globalThis & { [DB_GLOBAL_KEY]?: Database.Database | null };
  return g[DB_GLOBAL_KEY] ?? null;
}

function setGlobalDb(value: Database.Database | null): void {
  const g = globalThis as typeof globalThis & { [DB_GLOBAL_KEY]?: Database.Database | null };
  if (value) g[DB_GLOBAL_KEY] = value;
  else delete g[DB_GLOBAL_KEY];
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  provider_id TEXT,
  model TEXT,
  system_prompt TEXT,
  pinned INTEGER DEFAULT 0,
  archived INTEGER DEFAULT 0,
  project_id TEXT REFERENCES projects(id),
  workspace_path TEXT,
  parent_id TEXT,
  total_tokens INTEGER DEFAULT 0,
  message_count INTEGER DEFAULT 0,
  preview TEXT,
  compaction_count INTEGER DEFAULT 0,
  last_compaction_at INTEGER,
  tokens_saved_by_compaction INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_conv_updated ON conversations(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_conv_archived ON conversations(archived, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  reasoning TEXT,
  tool_calls TEXT,
  tool_call_id TEXT,
  name TEXT,
  model TEXT,
  provider TEXT,
  usage TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  sort_order INTEGER NOT NULL,
  bookmarked INTEGER DEFAULT 0,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, sort_order);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  conversation_id UNINDEXED,
  message_id UNINDEXED,
  tokenize = 'porter unicode61'
);

CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  preset_id TEXT,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key_ref TEXT,
  enabled INTEGER DEFAULT 1,
  models TEXT,
  custom_headers TEXT,
  models_fetched_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  transport TEXT NOT NULL DEFAULT 'stdio',
  command TEXT NOT NULL,
  url TEXT,
  args TEXT,
  env TEXT,
  cwd TEXT,
  timeout_ms INTEGER,
  trust INTEGER DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  slash_command TEXT NOT NULL,
  prompt TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  builtin INTEGER DEFAULT 0,
  category TEXT,
  source_dir TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon TEXT DEFAULT '📁',
  color TEXT,
  path TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_outbox (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  server_id TEXT NOT NULL,
  folder TEXT NOT NULL,
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_knowledge_outbox_project ON knowledge_outbox(project_id, created_at);

CREATE TABLE IF NOT EXISTS knowledge_automations (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('morning-digest', 'weekly-synthesis')),
  enabled INTEGER NOT NULL DEFAULT 0,
  local_hour INTEGER NOT NULL,
  local_minute INTEGER NOT NULL,
  weekly_weekday INTEGER,
  provider_id TEXT NOT NULL,
  model TEXT NOT NULL,
  last_run_key TEXT,
  last_run_at INTEGER,
  last_error TEXT,
  PRIMARY KEY(project_id, kind)
);

CREATE TABLE IF NOT EXISTS permissions (
  id TEXT PRIMARY KEY,
  tool_name TEXT NOT NULL,
  pattern TEXT,
  action TEXT NOT NULL,
  scope TEXT,
  project_path TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS prompts (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  category TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  type TEXT NOT NULL,
  language TEXT,
  title TEXT,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_artifact_conv ON artifacts(conversation_id);

CREATE TABLE IF NOT EXISTS swarm_runs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  project_id TEXT,
  prompt TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  model TEXT NOT NULL,
  worker_count INTEGER NOT NULL,
  repo_root TEXT,
  base_branch TEXT,
  base_head TEXT,
  integration_branch TEXT,
  integration_path TEXT,
  integration_head TEXT,
  result TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_swarm_runs_updated ON swarm_runs(updated_at DESC);

CREATE TABLE IF NOT EXISTS swarm_tasks (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES swarm_runs(id) ON DELETE CASCADE,
  phase TEXT NOT NULL,
  task_index INTEGER NOT NULL,
  status TEXT NOT NULL,
  output TEXT,
  error TEXT,
  worktree_path TEXT,
  branch_name TEXT,
  started_at INTEGER,
  completed_at INTEGER,
  UNIQUE(run_id, phase, task_index)
);
CREATE INDEX IF NOT EXISTS idx_swarm_tasks_run ON swarm_tasks(run_id, phase, task_index);

CREATE TABLE IF NOT EXISTS media_providers (
  id TEXT PRIMARY KEY,
  preset_id TEXT NOT NULL,
  name TEXT NOT NULL,
  base_url TEXT,
  api_key_ref TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  default_image_model TEXT,
  default_video_model TEXT,
  default_audio_model TEXT,
  image_models TEXT,
  video_models TEXT,
  audio_models TEXT,
  custom_headers TEXT,
  default_options TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS media_artifacts (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  message_id TEXT,
  project_id TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('image', 'video', 'audio')),
  provider_id TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt TEXT NOT NULL,
  negative_prompt TEXT,
  width INTEGER,
  height INTEGER,
  duration_seconds REAL,
  seed INTEGER,
  relative_path TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  error TEXT,
  options TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_media_artifacts_project ON media_artifacts(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_artifacts_conv ON media_artifacts(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_artifacts_status ON media_artifacts(status, created_at DESC);
`;

const CURRENT_SCHEMA_VERSION = 14;

export async function initDb(): Promise<void> {
  const dir = dirname(paths.db);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const previous = getGlobalDb();
  if (previous?.open) previous.close();
  setGlobalDb(null);

  const descriptor = openSync(paths.db, 'a', 0o600);
  closeSync(descriptor);
  if (process.platform !== 'win32') chmodSync(paths.db, 0o600);
  const db = new Database(paths.db);
  try {
    // Acquire writer locks patiently across CLI processes. Set this before WAL
    // mode because journal negotiation itself can briefly contend at startup.
    db.pragma(`busy_timeout = ${DB_BUSY_TIMEOUT_MS}`);
    const journalMode = db.pragma('journal_mode = WAL', { simple: true });
    if (journalMode !== 'wal') throw new Error(`SQLite WAL mode unavailable (got ${String(journalMode)})`);
    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = FULL');
    db.transaction(() => db.exec(SCHEMA)).immediate();
    runMigrations(db);
    if (process.platform !== 'win32') {
      for (const file of [paths.db, `${paths.db}-wal`, `${paths.db}-shm`]) {
        if (existsSync(file)) chmodSync(file, 0o600);
      }
    }
    setGlobalDb(db);
    logger.info('db', `initialized at ${paths.db} (schema v${CURRENT_SCHEMA_VERSION})`);
  } catch (error) {
    if (db.open) db.close();
    throw error;
  }
}

interface Migration {
  version: number;
  description: string;
  up: (database: Database.Database) => void;
}

const MIGRATIONS: Migration[] = [
  {
    version: 2,
    description: 'Add providers.models_fetched_at',
    up: (database) => {
      const columns = new Set(
        (database.prepare('PRAGMA table_info(providers)').all() as Array<{ name: string }>).map((column) => column.name)
      );
      if (!columns.has('models_fetched_at')) database.exec('ALTER TABLE providers ADD COLUMN models_fetched_at INTEGER');
    }
  },
  {
    version: 3,
    description: 'Rename project_path to project_id and add projects table',
    up: (database) => {
      const columns = new Set(
        (database.prepare('PRAGMA table_info(conversations)').all() as Array<{ name: string }>).map((column) => column.name)
      );
      if (!columns.has('project_id')) database.exec('ALTER TABLE conversations ADD COLUMN project_id TEXT REFERENCES projects(id)');
      database.exec(`CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        icon TEXT DEFAULT '📁',
        color TEXT,
        path TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
    }
  },
  {
    version: 4,
    description: 'Add parent_id to conversations for fork lineage',
    up: (database) => {
      const columns = new Set(
        (database.prepare('PRAGMA table_info(conversations)').all() as Array<{ name: string }>).map((column) => column.name)
      );
      if (!columns.has('parent_id')) database.exec('ALTER TABLE conversations ADD COLUMN parent_id TEXT');
    }
  },
  {
    version: 5,
    description: 'Add compaction telemetry fields to conversations',
    up: (database) => {
      const columns = new Set(
        (database.prepare('PRAGMA table_info(conversations)').all() as Array<{ name: string }>).map((column) => column.name)
      );
      if (!columns.has('compaction_count')) database.exec('ALTER TABLE conversations ADD COLUMN compaction_count INTEGER DEFAULT 0');
      if (!columns.has('last_compaction_at')) database.exec('ALTER TABLE conversations ADD COLUMN last_compaction_at INTEGER');
      if (!columns.has('tokens_saved_by_compaction')) database.exec('ALTER TABLE conversations ADD COLUMN tokens_saved_by_compaction INTEGER DEFAULT 0');
    }
  },
  {
    version: 6,
    description: 'Add messages.bookmarked for message bookmarks',
    up: (database) => {
      // Fresh installs already have the column from the base schema, and a
      // thrown "duplicate column" would abort the transaction before the index
      // statement — so check first instead of relying on the error handler.
      const cols = database.prepare(`PRAGMA table_info(messages)`).all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'bookmarked')) {
        database.exec(`ALTER TABLE messages ADD COLUMN bookmarked INTEGER DEFAULT 0`);
      }
      database.exec(`CREATE INDEX IF NOT EXISTS idx_msg_bookmarked ON messages(bookmarked) WHERE bookmarked = 1`);
    }
  },
  {
    version: 7,
    description: 'Add HTTP transport fields to MCP servers',
    up: (database) => {
      const columns = new Set(
        (database.prepare('PRAGMA table_info(mcp_servers)').all() as Array<{ name: string }>).map((column) => column.name)
      );
      if (!columns.has('transport')) database.exec(`ALTER TABLE mcp_servers ADD COLUMN transport TEXT NOT NULL DEFAULT 'stdio'`);
      if (!columns.has('url')) database.exec(`ALTER TABLE mcp_servers ADD COLUMN url TEXT`);
    }
  },
  {
    version: 8,
    description: 'Add skills.source_dir for file-synced skills',
    up: (database) => {
      const columns = new Set(
        (database.prepare('PRAGMA table_info(skills)').all() as Array<{ name: string }>).map((column) => column.name)
      );
      if (!columns.has('source_dir')) database.exec(`ALTER TABLE skills ADD COLUMN source_dir TEXT`);
    }
  },
  {
    version: 9,
    description: 'Add project config and knowledge capture outbox',
    up: (database) => {
      const columns = new Set(
        (database.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>).map((column) => column.name)
      );
      if (!columns.has('config')) database.exec(`ALTER TABLE projects ADD COLUMN config TEXT NOT NULL DEFAULT '{}'`);
      database.exec(`
        CREATE TABLE IF NOT EXISTS knowledge_outbox (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          server_id TEXT NOT NULL,
          folder TEXT NOT NULL,
          path TEXT NOT NULL,
          content TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_knowledge_outbox_project ON knowledge_outbox(project_id, created_at);
      `);
    }
  },
  {
    version: 10,
    description: 'Add project knowledge vault automations',
    up: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS knowledge_automations (
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK(kind IN ('morning-digest', 'weekly-synthesis')),
          enabled INTEGER NOT NULL DEFAULT 0,
          local_hour INTEGER NOT NULL,
          local_minute INTEGER NOT NULL,
          weekly_weekday INTEGER,
          provider_id TEXT NOT NULL,
          model TEXT NOT NULL,
          last_run_key TEXT,
          last_run_at INTEGER,
          last_error TEXT,
          PRIMARY KEY(project_id, kind)
        );
      `);
    }
  },
  {
    version: 11,
    description: 'Add native swarm runs and tasks',
    up: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS swarm_runs (
          id TEXT PRIMARY KEY,
          conversation_id TEXT,
          project_id TEXT,
          prompt TEXT NOT NULL,
          mode TEXT NOT NULL,
          status TEXT NOT NULL,
          provider_id TEXT NOT NULL,
          model TEXT NOT NULL,
          worker_count INTEGER NOT NULL,
          repo_root TEXT,
          base_branch TEXT,
          base_head TEXT,
          integration_branch TEXT,
          integration_path TEXT,
          integration_head TEXT,
          result TEXT,
          error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_swarm_runs_updated ON swarm_runs(updated_at DESC);
        CREATE TABLE IF NOT EXISTS swarm_tasks (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES swarm_runs(id) ON DELETE CASCADE,
          phase TEXT NOT NULL,
          task_index INTEGER NOT NULL,
          status TEXT NOT NULL,
          output TEXT,
          error TEXT,
          worktree_path TEXT,
          branch_name TEXT,
          started_at INTEGER,
          completed_at INTEGER,
          UNIQUE(run_id, phase, task_index)
        );
        CREATE INDEX IF NOT EXISTS idx_swarm_tasks_run ON swarm_tasks(run_id, phase, task_index);
      `);
    }
  },
  {
    version: 12,
    description: 'Add media generation tables (providers + artifacts)',
    up: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS media_providers (
          id TEXT PRIMARY KEY,
          preset_id TEXT NOT NULL,
          name TEXT NOT NULL,
          base_url TEXT,
          api_key_ref TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          default_image_model TEXT,
          default_video_model TEXT,
          image_models TEXT,
          video_models TEXT,
          custom_headers TEXT,
          default_options TEXT,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS media_artifacts (
          id TEXT PRIMARY KEY,
          conversation_id TEXT,
          message_id TEXT,
          project_id TEXT,
          kind TEXT NOT NULL CHECK(kind IN ('image', 'video')),
          provider_id TEXT NOT NULL,
          model TEXT NOT NULL,
          prompt TEXT NOT NULL,
          negative_prompt TEXT,
          width INTEGER,
          height INTEGER,
          duration_seconds REAL,
          seed INTEGER,
          relative_path TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          bytes INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'queued',
          error TEXT,
          options TEXT,
          created_at INTEGER NOT NULL,
          started_at INTEGER,
          finished_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_media_artifacts_project ON media_artifacts(project_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_media_artifacts_conv ON media_artifacts(conversation_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_media_artifacts_status ON media_artifacts(status, created_at DESC);
      `);
    }
  },
  {
    version: 13,
    description: 'Add audio media support (provider columns + relax artifact kind CHECK)',
    up: (database) => {
      // 1. Add audio columns to media_providers if missing.
      const providerCols = new Set(
        (database.prepare(`PRAGMA table_info(media_providers)`).all() as Array<{ name: string }>).map((c) => c.name)
      );
      if (!providerCols.has('default_audio_model')) database.exec(`ALTER TABLE media_providers ADD COLUMN default_audio_model TEXT`);
      if (!providerCols.has('audio_models')) database.exec(`ALTER TABLE media_providers ADD COLUMN audio_models TEXT`);

      // 2. Relax the media_artifacts kind CHECK to allow 'audio'. SQLite cannot
      // alter a CHECK in place, so rebuild the table only if the old constraint
      // is still present, preserving any existing rows.
      const artifactSql = (database.prepare(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'media_artifacts'`
      ).get() as { sql?: string } | undefined)?.sql || '';
      if (artifactSql.includes("kind IN ('image', 'video')") && !artifactSql.includes('audio')) {
        database.exec(`
          ALTER TABLE media_artifacts RENAME TO media_artifacts_old;
          CREATE TABLE media_artifacts (
            id TEXT PRIMARY KEY,
            conversation_id TEXT,
            message_id TEXT,
            project_id TEXT,
            kind TEXT NOT NULL CHECK(kind IN ('image', 'video', 'audio')),
            provider_id TEXT NOT NULL,
            model TEXT NOT NULL,
            prompt TEXT NOT NULL,
            negative_prompt TEXT,
            width INTEGER,
            height INTEGER,
            duration_seconds REAL,
            seed INTEGER,
            relative_path TEXT NOT NULL,
            mime_type TEXT NOT NULL,
            bytes INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'queued',
            error TEXT,
            options TEXT,
            created_at INTEGER NOT NULL,
            started_at INTEGER,
            finished_at INTEGER
          );
          INSERT INTO media_artifacts SELECT * FROM media_artifacts_old;
          DROP TABLE media_artifacts_old;
          CREATE INDEX IF NOT EXISTS idx_media_artifacts_project ON media_artifacts(project_id, created_at DESC);
          CREATE INDEX IF NOT EXISTS idx_media_artifacts_conv ON media_artifacts(conversation_id, created_at DESC);
          CREATE INDEX IF NOT EXISTS idx_media_artifacts_status ON media_artifacts(status, created_at DESC);
        `);
      }
    }
  },
  {
    version: 14,
    description: 'Bind conversations to canonical workspace paths',
    up: (database) => {
      const columns = new Set(
        (database.prepare('PRAGMA table_info(conversations)').all() as Array<{ name: string }>).map((column) => column.name)
      );
      // Older builds could record v5 after its first duplicate column and
      // leave the other two effects missing. v14 is the first safe repair
      // point for databases that already carry that incorrect version row.
      if (!columns.has('compaction_count')) database.exec('ALTER TABLE conversations ADD COLUMN compaction_count INTEGER DEFAULT 0');
      if (!columns.has('last_compaction_at')) database.exec('ALTER TABLE conversations ADD COLUMN last_compaction_at INTEGER');
      if (!columns.has('tokens_saved_by_compaction')) database.exec('ALTER TABLE conversations ADD COLUMN tokens_saved_by_compaction INTEGER DEFAULT 0');
      if (!columns.has('workspace_path')) database.exec('ALTER TABLE conversations ADD COLUMN workspace_path TEXT');
      const rows = database.prepare(`
        SELECT conversations.id, projects.path
        FROM conversations
        JOIN projects ON projects.id = conversations.project_id
        WHERE conversations.workspace_path IS NULL
      `).all() as Array<{ id: string; path: string }>;
      const update = database.prepare('UPDATE conversations SET workspace_path = ? WHERE id = ?');
      for (const row of rows) {
        try { update.run(canonicalWorkspacePath(row.path), row.id); }
        catch { /* unavailable legacy projects remain unscoped and fail closed */ }
      }
    }
  }
];

function runMigrations(database: Database.Database): void {
  for (const migration of MIGRATIONS) {
    try {
      const applied = database.transaction(() => {
        // Recheck after acquiring the writer lock. Another process may have
        // completed this migration while this connection was waiting.
        const versionRow = database.prepare('SELECT MAX(version) AS version FROM schema_version').get() as { version: number | null } | undefined;
        if ((versionRow?.version ?? 0) >= migration.version) return false;
        migration.up(database);
        database.prepare('INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (?, ?)').run(migration.version, Date.now());
        return true;
      }).immediate();
      if (applied) logger.info('db', `migration v${migration.version} applied: ${migration.description}`);
    } catch (err) {
      logger.error('db', `migration v${migration.version} failed: ${migration.description}`, err);
      throw err;
    }
  }
}

export function getDb(): Database.Database {
  const db = getGlobalDb();
  if (!db) throw new Error('DB not initialized');
  return db;
}

export function closeDb(): void {
  const db = getGlobalDb();
  if (db) {
    db.close();
    setGlobalDb(null);
  }
}

// Settings helpers
export function getSetting<T = unknown>(key: string, fallback?: T): T | undefined {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  if (!row) return fallback;
  try { return JSON.parse(row.value) as T; } catch { return row.value as unknown as T; }
}

export function setSetting(key: string, value: unknown): void {
  const v = JSON.stringify(value);
  const now = Date.now();
  getDb().prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, v, now);
}
