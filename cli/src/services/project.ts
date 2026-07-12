import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { getDb } from '../../../src/main/db/client.js';
import type { Project, ProjectConfig } from '../../../src/shared/types.js';

export function createProject(options: {
  name: string;
  path: string;
  icon?: string;
  color?: string;
  config?: ProjectConfig;
}): Project {
  const resolved = realpathSync(options.path);
  if (!existsSync(resolved)) {
    throw new Error(`Project path does not exist: ${resolved}`);
  }
  const now = Date.now();
  const id = randomUUID();
  const config = options.config ? JSON.stringify(options.config) : '{}';
  getDb()
    .prepare(
      `INSERT INTO projects (id, name, icon, color, path, config, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, options.name, options.icon || '📁', options.color || null, resolved, config, now, now);
  return {
    id,
    name: options.name,
    icon: options.icon || '📁',
    color: options.color,
    path: resolved,
    config: options.config,
    createdAt: now,
    updatedAt: now
  };
}

export function getProject(id: string): Project | null {
  const row = getDb().prepare('SELECT * FROM projects WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToProject(row) : null;
}

export function listProjects(): Project[] {
  const rows = getDb().prepare('SELECT * FROM projects ORDER BY updated_at DESC').all() as Array<Record<string, unknown>>;
  return rows.map(rowToProject);
}

export function deleteProject(id: string): void {
  getDb().prepare('DELETE FROM projects WHERE id = ?').run(id);
}

export function updateProject(id: string, updates: Partial<Omit<Project, 'id' | 'createdAt' | 'updatedAt'>>): Project | null {
  const existing = getProject(id);
  if (!existing) return null;
  const sets: string[] = [];
  const values: unknown[] = [];
  if (updates.name) { sets.push('name = ?'); values.push(updates.name); }
  if (updates.icon) { sets.push('icon = ?'); values.push(updates.icon); }
  if (updates.color) { sets.push('color = ?'); values.push(updates.color); }
  if (updates.path) { sets.push('path = ?'); values.push(updates.path); }
  if (updates.config) { sets.push('config = ?'); values.push(JSON.stringify(updates.config)); }
  sets.push('updated_at = ?'); values.push(Date.now());
  values.push(id);
  getDb().prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getProject(id);
}

export function getProjectByPath(path: string): Project | null {
  const row = getDb().prepare('SELECT * FROM projects WHERE path = ?').get(path) as Record<string, unknown> | undefined;
  return row ? rowToProject(row) : null;
}

function rowToProject(row: Record<string, unknown>): Project {
  const configRaw = row.config as string | null | undefined;
  let config: ProjectConfig | undefined;
  if (configRaw) {
    try { config = JSON.parse(configRaw) as ProjectConfig; } catch { /* ignore */ }
  }
  return {
    id: row.id as string,
    name: row.name as string,
    icon: (row.icon as string) || '📁',
    color: (row.color as string | null) || undefined,
    path: row.path as string,
    config,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number
  };
}
