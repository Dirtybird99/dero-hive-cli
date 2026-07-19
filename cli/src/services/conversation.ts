import { randomUUID } from 'node:crypto';
import { getDb } from '../../../src/main/db/client.js';
import type { Conversation, Message, SearchResult } from '../../../src/shared/types.js';
import { canonicalWorkspacePath } from '../../../src/shared/workspace.js';
import { deleteStoredAttachments, serializedAttachmentIds } from '../../../src/main/utils/attachments.js';

function attachmentIdsFromRows(rows: Array<{ content: string }>): string[] {
  return rows.flatMap((row) => serializedAttachmentIds(row.content));
}

export async function deleteUnreferencedAttachments(candidates: Iterable<string>): Promise<void> {
  const ids = new Set(candidates);
  if (!ids.size) return;
  const referenced = new Set(attachmentIdsFromRows(
    getDb().prepare("SELECT content FROM messages WHERE content LIKE '%attachment_ref%'").all() as Array<{ content: string }>
  ));
  await deleteStoredAttachments([...ids].filter((id) => !referenced.has(id)));
}

export function createConversation(options: {
  title?: string;
  providerId?: string;
  model?: string;
  systemPrompt?: string;
  projectId?: string;
  workspacePath: string;
  parentId?: string;
}): Conversation {
  const now = Date.now();
  const id = randomUUID();
  const title = options.title?.trim() || 'New chat';
  const providerId = options.providerId || '';
  const model = options.model || '';
  const workspacePath = canonicalWorkspacePath(options.workspacePath);
  getDb()
    .prepare(
      `INSERT INTO conversations (id, title, created_at, updated_at, provider_id, model, system_prompt, project_id, workspace_path, parent_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      title,
      now,
      now,
      providerId,
      model,
      options.systemPrompt || null,
      options.projectId || null,
      workspacePath,
      options.parentId || null
    );
  return {
    id,
    title,
    createdAt: now,
    updatedAt: now,
    providerId,
    model,
    systemPrompt: options.systemPrompt,
    projectId: options.projectId,
    workspacePath,
    parentId: options.parentId,
    messageCount: 0
  };
}

export function getConversation(id: string): Conversation | null {
  const row = getDb().prepare('SELECT * FROM conversations WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToConversation(row) : null;
}

export function listConversations(projectId?: string): Conversation[] {
  const query = projectId
    ? 'SELECT * FROM conversations WHERE project_id = ? ORDER BY updated_at DESC'
    : 'SELECT * FROM conversations ORDER BY updated_at DESC';
  const rows = (projectId
    ? getDb().prepare(query).all(projectId)
    : getDb().prepare(query).all()) as Array<Record<string, unknown>>;
  return rows.map(rowToConversation);
}

export function listConversationsForWorkspace(workspacePath: string): Conversation[] {
  const canonical = canonicalWorkspacePath(workspacePath);
  const rows = getDb().prepare(
    'SELECT * FROM conversations WHERE workspace_path = ? ORDER BY updated_at DESC'
  ).all(canonical) as Array<Record<string, unknown>>;
  return rows.map(rowToConversation);
}

export async function deleteConversation(id: string): Promise<void> {
  const db = getDb();
  const candidates = db.transaction(() => {
    const rows = db.prepare('SELECT content FROM messages WHERE conversation_id = ?').all(id) as Array<{ content: string }>;
    db.prepare('DELETE FROM messages_fts WHERE conversation_id = ?').run(id);
    db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id);
    db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
    return attachmentIdsFromRows(rows);
  }).immediate();
  await deleteUnreferencedAttachments(candidates);
}

export function updateConversationTitle(id: string, title: string): void {
  getDb().prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?').run(title, Date.now(), id);
}

export function updateConversation(
  id: string,
  data: Partial<Pick<Conversation, 'title' | 'providerId' | 'model' | 'systemPrompt' | 'projectId' | 'pinned' | 'archived'>>
): void {
  const columns: Record<string, string> = {
    title: 'title', providerId: 'provider_id', model: 'model', systemPrompt: 'system_prompt',
    projectId: 'project_id', pinned: 'pinned', archived: 'archived'
  };
  const fields: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(data)) {
    const column = columns[key];
    if (!column) continue;
    fields.push(`${column} = ?`);
    values.push(typeof value === 'boolean' ? (value ? 1 : 0) : value ?? null);
  }
  if (!fields.length) return;
  fields.push('updated_at = ?');
  values.push(Date.now(), id);
  getDb().prepare(`UPDATE conversations SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function forkConversation(id: string): Conversation | null {
  const db = getDb();
  return db.transaction(() => {
    const row = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    const conv = rowToConversation(row);
    if (!conv.workspacePath) throw new Error('Cannot fork a conversation without a workspace scope.');
    const newConv = createConversation({
      title: `${conv.title} (fork)`,
      providerId: conv.providerId,
      model: conv.model,
      systemPrompt: conv.systemPrompt,
      projectId: conv.projectId,
      workspacePath: conv.workspacePath,
      parentId: conv.id
    });

    const rows = db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY sort_order ASC, rowid ASC')
      .all(id) as Array<Record<string, unknown>>;
    for (const messageRow of rows) {
      const msg = rowToMessage(messageRow);
      msg.id = randomUUID();
      msg.createdAt = Date.now();
      persistMessage(newConv.id, msg);
    }
    return newConv;
  }).immediate();
}

export function getMessages(conversationId: string): Message[] {
  const rows = getDb()
    .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY sort_order ASC, rowid ASC')
    .all(conversationId) as Array<Record<string, unknown>>;
  return rows.map(rowToMessage);
}

export function persistMessage(conversationId: string, msg: Message): void {
  const db = getDb();
  // IMMEDIATE takes the writer slot before MAX is read, so another CLI process
  // cannot allocate the same per-conversation sort order.
  db.transaction(() => {
    const maxOrder = (
      db
        .prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM messages WHERE conversation_id = ?')
        .get(conversationId) as { m: number }
    ).m;
    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    db.prepare(
      `INSERT INTO messages (id, conversation_id, role, content, reasoning, tool_calls, tool_call_id, name, model, provider, usage, error, created_at, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .run(
        msg.id,
        conversationId,
        msg.role,
        content,
        msg.reasoning || null,
        msg.toolCalls ? JSON.stringify(msg.toolCalls) : null,
        msg.toolCallId || null,
        msg.name || null,
        msg.model || null,
        msg.provider || null,
        msg.usage ? JSON.stringify(msg.usage) : null,
        msg.error || null,
        msg.createdAt,
        maxOrder + 1
      );
    db.prepare('INSERT INTO messages_fts (rowid, content, conversation_id, message_id) VALUES ((SELECT rowid FROM messages WHERE id = ?), ?, ?, ?)')
      .run(msg.id, content, conversationId, msg.id);
    db.prepare('UPDATE conversations SET message_count = message_count + 1, updated_at = ? WHERE id = ?')
      .run(Date.now(), conversationId);
  }).immediate();
}

export function updateConversationPreview(conversationId: string, content: string): void {
  getDb()
    .prepare('UPDATE conversations SET preview = ?, updated_at = ? WHERE id = ?')
    .run(content.slice(0, 200), Date.now(), conversationId);
}

export function updateConversationTokens(conversationId: string, tokens: number): void {
  if (!Number.isFinite(tokens) || tokens <= 0) return;
  getDb().prepare('UPDATE conversations SET total_tokens = COALESCE(total_tokens, 0) + ? WHERE id = ?')
    .run(Math.floor(tokens), conversationId);
}

export function searchConversations(query: string): SearchResult[] {
  const terms = query.trim().split(/\s+/).filter(Boolean).map((term) => `"${term.replace(/"/g, '""')}"`);
  if (!terms.length) return [];
  const match = terms.map((term, index) => index === terms.length - 1 ? `${term}*` : term).join(' ');
  const rows = getDb()
    .prepare(
      `SELECT m.conversation_id, m.id AS message_id, m.role, snippet(messages_fts, 0, '<<', '>>', '...', 32) AS snippet
       FROM messages_fts
       JOIN messages m ON m.id = messages_fts.message_id
       WHERE messages_fts MATCH ?
       ORDER BY rank LIMIT 100`
    )
    .all(match) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    conversationId: row.conversation_id as string,
    messageId: row.message_id as string,
    role: row.role as Message['role'],
    snippet: row.snippet as string,
    score: 0
  }));
}

export async function removeLastExchange(conversationId: string): Promise<number> {
  const db = getDb();
  const mutation = db.transaction(() => {
    const rows = db.prepare(
      'SELECT id, role, sort_order, content FROM messages WHERE conversation_id = ? ORDER BY sort_order ASC, rowid ASC'
    ).all(conversationId) as Array<{ id: string; role: string; sort_order: number; content: string }>;
    let start = -1;
    for (let index = rows.length - 1; index >= 0; index--) {
      if (rows[index].role === 'user') { start = index; break; }
    }
    if (start < 0) return { removedCount: 0, candidates: [] as string[] };
    const removed = rows.slice(start);
    const ids = removed.map((row) => row.id);
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM messages_fts WHERE message_id IN (${placeholders})`).run(...ids);
    db.prepare(`DELETE FROM messages WHERE id IN (${placeholders})`).run(...ids);
    db.prepare(`UPDATE conversations SET message_count = (
      SELECT COUNT(*) FROM messages WHERE conversation_id = ?
    ), updated_at = ? WHERE id = ?`).run(conversationId, Date.now(), conversationId);
    return { removedCount: removed.length, candidates: attachmentIdsFromRows(removed) };
  }).immediate();
  await deleteUnreferencedAttachments(mutation.candidates);
  return mutation.removedCount;
}

export interface ContextEstimate {
  messages: number;
  characters: number;
  estimatedTokens: number;
}

export function estimateContext(conversationId: string): ContextEstimate {
  const messages = getMessages(conversationId);
  const characters = messages.reduce((total, message) => total
    + (typeof message.content === 'string' ? message.content.length : JSON.stringify(message.content).length)
    + (message.reasoning?.length || 0), 0);
  return { messages: messages.length, characters, estimatedTokens: Math.ceil(characters / 3.7) };
}

export interface CompactResult {
  removedCount: number;
  beforeTokens: number;
  afterTokens: number;
  tokensSaved: number;
}

export async function compactConversation(conversationId: string, keepRecentMessages = 8, instructions?: string): Promise<CompactResult> {
  const db = getDb();
  const mutation = db.transaction(() => ({
    candidates: attachmentIdsFromRows(db.prepare(
      "SELECT content FROM messages WHERE conversation_id = ? AND content LIKE '%attachment_ref%'"
    ).all(conversationId) as Array<{ content: string }>),
    result: compactConversationLocked(db, conversationId, keepRecentMessages, instructions)
  })).immediate();
  if (mutation.result.removedCount) await deleteUnreferencedAttachments(mutation.candidates);
  return mutation.result;
}

function compactConversationLocked(
  db: ReturnType<typeof getDb>,
  conversationId: string,
  keepRecentMessages: number,
  instructions?: string
): CompactResult {
  const rows = db.prepare(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY sort_order ASC, rowid ASC'
  ).all(conversationId) as Array<Record<string, unknown>>;
  const systemRows = rows.filter((row) => row.role === 'system' && row.name !== 'context_compaction');
  const normalRows = rows.filter((row) => row.role !== 'system' || row.name === 'context_compaction');
  if (normalRows.length <= keepRecentMessages) {
    const current = estimateContext(conversationId).estimatedTokens;
    return { removedCount: 0, beforeTokens: current, afterTokens: current, tokensSaved: 0 };
  }

  const recent = normalRows.slice(-keepRecentMessages);
  const older = normalRows.slice(0, -keepRecentMessages);
  const beforeTokens = Math.ceil(rows.reduce((total, row) =>
    total + String(row.content || '').length + String(row.reasoning || '').length, 0) / 3.7);
  const requests: string[] = [];
  const progress: string[] = [];
  const files = new Set<string>();
  const failures: string[] = [];
  const priorContext: string[] = [];
  for (const row of older) {
    const content = String(row.content || '').replace(/\s+/g, ' ').trim();
    if (!content) continue;
    if (row.role === 'system' && row.name === 'context_compaction') priorContext.push(content.slice(0, 4_000));
    if (row.role === 'user') requests.push(`- ${content.slice(0, 240)}`);
    if (row.role === 'assistant') progress.push(`- ${content.slice(0, 280)}`);
    if (row.role === 'tool') {
      const match = content.match(/(?:[A-Z]:[\\/]|\.\.?[\\/]|\/)[^\s'"<>|]+/);
      if (match) files.add(match[0]);
      if (/error|failed|fatal|exception/i.test(content)) failures.push(`- ${content.slice(0, 220)}`);
    }
  }
  const sections = [
    '<context_compaction>',
    `Compacted ${older.length} older messages.`,
    ...(instructions?.trim() ? ['', '## User guidance for this compaction', instructions.trim().slice(0, 1_000)] : []),
    ...(priorContext.length ? ['', '## Previous compacted context', priorContext.slice(-2).join('\n')] : []),
    ...(requests.length ? ['', '## User requests', requests.slice(0, 14).join('\n')] : []),
    ...(progress.length ? ['', '## Progress and decisions', progress.slice(0, 12).join('\n')] : []),
    ...(files.size ? ['', '## Files referenced', [...files].slice(0, 20).map((file) => `- ${file}`).join('\n')] : []),
    ...(failures.length ? ['', '## Errors observed', failures.slice(0, 6).join('\n')] : []),
    '</context_compaction>'
  ];
  const summary = sections.join('\n').slice(0, 16_000);
  const summaryId = randomUUID();
  const afterTokens = Math.ceil((summary.length + recent.reduce((total, row) =>
    total + String(row.content || '').slice(0, 12_000).length + String(row.reasoning || '').length, 0)) / 3.7);
  const tokensSaved = Math.max(0, beforeTokens - afterTokens);
  const insert = db.prepare(`INSERT INTO messages
    (id, conversation_id, role, content, reasoning, tool_calls, tool_call_id, name, model, provider, usage, error, created_at, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertFts = db.prepare(`INSERT INTO messages_fts (rowid, content, conversation_id, message_id)
    VALUES ((SELECT rowid FROM messages WHERE id = ?), ?, ?, ?)`);

  db.transaction(() => {
    db.prepare('DELETE FROM messages_fts WHERE conversation_id = ?').run(conversationId);
    db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(conversationId);
    let order = 0;
    for (const row of systemRows) {
      insert.run(row.id, conversationId, row.role, row.content, row.reasoning || null, row.tool_calls || null,
        row.tool_call_id || null, row.name || null, row.model || null, row.provider || null,
        row.usage || null, row.error || null, row.created_at, order++);
      insertFts.run(row.id, String(row.content || ''), conversationId, row.id);
    }
    insert.run(summaryId, conversationId, 'system', summary, null, null, null, 'context_compaction', null, null, null, null, Date.now(), order++);
    insertFts.run(summaryId, summary, conversationId, summaryId);
    for (const row of recent) {
      const id = randomUUID();
      const rawContent = String(row.content || '');
      let content = rawContent.slice(0, 12_000);
      try {
        if (Array.isArray(JSON.parse(rawContent))) content = rawContent;
      } catch { /* plain text stays bounded */ }
      insert.run(id, conversationId, row.role, content, row.reasoning || null, row.tool_calls || null,
        row.tool_call_id || null, row.name || null, row.model || null, row.provider || null,
        row.usage || null, row.error || null, row.created_at || Date.now(), order++);
      insertFts.run(id, content, conversationId, id);
    }
    db.prepare(`UPDATE conversations SET message_count = ?, total_tokens = ?,
      compaction_count = COALESCE(compaction_count, 0) + 1, last_compaction_at = ?,
      tokens_saved_by_compaction = COALESCE(tokens_saved_by_compaction, 0) + ?, updated_at = ? WHERE id = ?`)
      .run(systemRows.length + recent.length + 1, afterTokens, Date.now(), tokensSaved, Date.now(), conversationId);
  })();
  return { removedCount: older.length, beforeTokens, afterTokens, tokensSaved };
}

function rowToConversation(row: Record<string, unknown>): Conversation {
  return {
    id: row.id as string,
    title: row.title as string,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    providerId: (row.provider_id as string | null) || '',
    model: (row.model as string | null) || '',
    systemPrompt: (row.system_prompt as string | null) || undefined,
    pinned: !!row.pinned,
    archived: !!row.archived,
    projectId: (row.project_id as string | null) || undefined,
    workspacePath: (row.workspace_path as string | null) || undefined,
    parentId: (row.parent_id as string | null) || undefined,
    totalTokens: (row.total_tokens as number) || undefined,
    messageCount: (row.message_count as number) || 0,
    preview: (row.preview as string | null) || undefined,
    compactionCount: (row.compaction_count as number) || undefined,
    lastCompactionAt: (row.last_compaction_at as number) || undefined,
    tokensSavedByCompaction: (row.tokens_saved_by_compaction as number) || undefined
  };
}

function rowToMessage(row: Record<string, unknown>): Message {
  const content = row.content as string;
  let parsed: string | Message['content'] = content;
  try {
    const j = JSON.parse(content);
    if (Array.isArray(j)) parsed = j;
  } catch { /* keep as string */ }

  let toolCalls: Message['toolCalls'];
  if (row.tool_calls) {
    try { toolCalls = JSON.parse(row.tool_calls as string); } catch { /* ignore */ }
  }
  let usage: Message['usage'];
  if (row.usage) {
    try { usage = JSON.parse(row.usage as string); } catch { /* ignore */ }
  }

  return {
    id: row.id as string,
    role: row.role as Message['role'],
    content: parsed,
    reasoning: (row.reasoning as string | null) || undefined,
    toolCalls,
    toolCallId: (row.tool_call_id as string | null) || undefined,
    name: (row.name as string | null) || undefined,
    model: (row.model as string | null) || undefined,
    provider: (row.provider as string | null) || undefined,
    usage,
    error: (row.error as string | null) || undefined,
    createdAt: row.created_at as number
  };
}
