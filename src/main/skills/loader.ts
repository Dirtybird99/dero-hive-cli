import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { SkillImportPreview } from '@shared/types';
import { paths } from '../utils/paths';
import { logger } from '../utils/logger';

function getAppPath(): string {
  return process.env.HIVE_APP_ROOT || process.cwd();
}

export interface ParsedSkill {
  name: string;
  description: string;
  prompt: string;
  license?: string;
}

export interface SkillSeed extends ParsedSkill {
  id: string;
  slashCommand: string;
  category: string;
  builtin: boolean;
  sourceDir: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

// Agent Skills spec (agentskills.io): name is lowercase kebab-case, max 64 chars,
// and must match the directory name; description is required, max 1024 chars.
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const NAME_MAX = 64;
const DESCRIPTION_MAX = 1024;
const SKILL_FILE_MAX_BYTES = 256 * 1024;
const UNSUPPORTED_SKILL_PARTS = ['references', 'assets', 'scripts', 'hooks', 'agents', 'commands'] as const;

export function bundledSkillsDir(): string {
  return join(getAppPath(), 'resources', 'skills');
}

export function userSkillsDir(): string {
  return paths.skills;
}

export function parseSkillMarkdown(raw: string): ParsedSkill | null {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) return null;

  const [, fmBlock, body] = match;
  const meta: Record<string, string> = {};
  for (const line of fmBlock.split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    meta[m[1].toLowerCase()] = value;
  }

  const name = (meta.name || '').trim();
  const description = (meta.description || '').trim();
  if (!name || name.length > NAME_MAX || !NAME_RE.test(name)) return null;
  if (!description || description.length > DESCRIPTION_MAX) return null;

  return {
    name,
    description,
    license: meta.license,
    prompt: body.trim()
  };
}

export type SkillDirectoryInspection =
  | { ok: true; preview: SkillImportPreview; skillPath: string }
  | { ok: false; error: string };

/** Validate a selected Agent Skills folder without executing or copying it. */
export function inspectSkillDirectory(sourceDir: string): SkillDirectoryInspection {
  const dir = resolve(sourceDir);
  try {
    if (!statSync(dir).isDirectory()) return { ok: false, error: 'Select a skill folder.' };
  } catch {
    return { ok: false, error: 'The selected folder is unavailable.' };
  }

  const skillPath = join(dir, 'SKILL.md');
  if (!existsSync(skillPath)) return { ok: false, error: 'The selected folder does not contain SKILL.md.' };

  let raw: string;
  try {
    const file = statSync(skillPath);
    if (!file.isFile()) return { ok: false, error: 'SKILL.md is not a file.' };
    if (file.size > SKILL_FILE_MAX_BYTES) return { ok: false, error: 'SKILL.md is larger than 256 KB.' };
    raw = readFileSync(skillPath, 'utf8');
  } catch {
    return { ok: false, error: 'SKILL.md could not be read.' };
  }

  const parsed = parseSkillMarkdown(raw);
  if (!parsed) return { ok: false, error: 'SKILL.md needs valid name and description frontmatter.' };
  if (basename(dir) !== parsed.name) {
    return { ok: false, error: `Skill name "${parsed.name}" must match folder name "${basename(dir)}".` };
  }

  let entries: Set<string>;
  try {
    entries = new Set(readdirSync(dir).map((name) => name.toLowerCase()));
  } catch {
    return { ok: false, error: 'The selected folder could not be read.' };
  }
  const prompt = parsed.prompt.toLowerCase();
  const warnings = UNSUPPORTED_SKILL_PARTS.flatMap((part) => {
    if (entries.has(part)) return [`${part}/ is unsupported and will not be copied or executed.`];
    if (prompt.includes(`${part}/`) || prompt.includes(`${part}\\`)) {
      return [`SKILL.md references ${part}/, which Hive will not copy or execute.`];
    }
    return [];
  });

  return {
    ok: true,
    skillPath,
    preview: {
      sourceDir: dir,
      name: parsed.name,
      description: parsed.description,
      slashCommand: `/${parsed.name}`,
      prompt: parsed.prompt,
      warnings
    }
  };
}

export function loadSkillsFrom(
  root: string,
  opts: { builtin: boolean; category: string; idPrefix: string }
): SkillSeed[] {
  if (!existsSync(root)) return [];

  const out: SkillSeed[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    const skillPath = join(dir, 'SKILL.md');
    if (!existsSync(skillPath)) continue;

    let raw: string;
    try {
      raw = readFileSync(skillPath, 'utf8');
    } catch {
      continue;
    }

    const parsed = parseSkillMarkdown(raw);
    if (!parsed) {
      logger.warn('skills', `invalid SKILL.md skipped (needs name + description frontmatter): ${skillPath}`);
      continue;
    }
    if (parsed.name !== entry.name) {
      logger.warn('skills', `skill name "${parsed.name}" does not match directory "${entry.name}" — skipped: ${skillPath}`);
      continue;
    }

    out.push({
      ...parsed,
      id: `${opts.idPrefix}-${parsed.name}`,
      slashCommand: `/${parsed.name}`,
      category: opts.category,
      builtin: opts.builtin,
      sourceDir: dir
    });
  }

  return out;
}

export function loadBundledSkills(): SkillSeed[] {
  return loadSkillsFrom(bundledSkillsDir(), { builtin: true, category: 'DERO', idPrefix: 'bundled' });
}

export function loadUserSkills(): SkillSeed[] {
  return loadSkillsFrom(userSkillsDir(), { builtin: false, category: 'user', idPrefix: 'user' });
}
