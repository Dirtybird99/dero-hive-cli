import { mkdir, unlink, copyFile } from 'node:fs/promises';
import { existsSync, renameSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { paths } from '../utils/paths';
import { getDb } from '../db/client';
import { logger } from '../utils/logger';
import { getSecret, setSecret, deleteSecret } from '../utils/secrets';
import type { MediaProviderConfig, MediaArtifactRecord, MediaJobRecord, MediaGenerationRequest, MediaJobStatusEvent, MediaProviderPreset, MediaModelOption, MediaKind } from '@shared/types';
import { MEDIA_PROVIDER_PRESETS, findMediaPreset } from '@shared/media';
import { adapterFor, type MediaAdapter } from './adapters';
import { getProviderConfig } from '../providers/registry';

export type MediaEventHandler = (evt: MediaJobStatusEvent) => void;

const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024; // 50 MB hard cap per job

export class MediaManager {
  private listeners = new Set<MediaEventHandler>();
  /** Cancellation flags keyed by job id. */
  private readonly cancellations = new Map<string, AbortController>();

  constructor(onEvent?: MediaEventHandler) {
    if (onEvent) this.listeners.add(onEvent);
  }

  onEvent(handler: MediaEventHandler): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  // ── Provider CRUD ─────────────────────────────────────────────────────────

  listProviders(): MediaProviderConfig[] {
    const rows = getDb().prepare('SELECT * FROM media_providers ORDER BY name').all() as Array<Record<string, unknown>>;
    return rows.map(rowToProviderConfig);
  }

  presets(): MediaProviderPreset[] {
    return MEDIA_PROVIDER_PRESETS;
  }

  /** Pick a provider that can generate the given kind, for tool-driven
   *  generation where the caller didn't specify one. Prefers a dedicated media
   *  provider, then falls back to a model provider with an auto-classified
   *  media model. Returns null when nothing is configured for the kind. */
  autoPick(kind: MediaKind): { providerId?: string; modelProviderId?: string; model?: string } | null {
    const media = this.listProviders().find((p) => p.enabled && presetSupportsKind(p.presetId, kind));
    if (media) {
      const defaultModel = kind === 'video' ? media.defaultVideoModel : kind === 'audio' ? media.defaultAudioModel : media.defaultImageModel;
      return { providerId: media.id, model: defaultModel };
    }
    const rows = getDb().prepare('SELECT id, preset_id, base_url, models FROM providers WHERE enabled = 1').all() as Array<{ id: string; preset_id: string; base_url: string; models: string }>;
    // MiniMax subscriptions include native image/speech/music/video generation.
    const minimax = rows.find((r) => isMinimaxProvider(r.preset_id, r.base_url));
    if (minimax) return { modelProviderId: minimax.id, model: MINIMAX_DEFAULT_MEDIA_MODEL[kind] };
    // Other chat providers can't produce video through OpenAI-compatible endpoints.
    if (kind === 'video') return null;
    for (const row of rows) {
      const models = parseJSON<Array<{ id: string; mediaKinds?: MediaKind[] }>>(row.models, []);
      const hit = models.find((m) => Array.isArray(m.mediaKinds) && m.mediaKinds.includes(kind));
      if (hit) return { modelProviderId: row.id, model: hit.id };
    }
    return null;
  }

  saveProvider(cfg: MediaProviderConfig & { apiKey?: string }): MediaProviderConfig {
    if (!cfg.id) cfg.id = `media-${randomUUID().slice(0, 8)}`;
    const final: MediaProviderConfig = { ...cfg, updatedAt: Date.now() };
    const apiKeyRef = cfg.apiKey && cfg.apiKey.length > 0 ? `media:${final.id}` : null;
    if (apiKeyRef) {
      setSecret(apiKeyRef, cfg.apiKey!);
    }
    getDb().prepare(`
      INSERT INTO media_providers (id, preset_id, name, base_url, api_key_ref, enabled, default_image_model, default_video_model, default_audio_model, image_models, video_models, audio_models, custom_headers, default_options, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        preset_id = excluded.preset_id,
        name = excluded.name,
        base_url = excluded.base_url,
        api_key_ref = COALESCE(excluded.api_key_ref, media_providers.api_key_ref),
        enabled = excluded.enabled,
        default_image_model = excluded.default_image_model,
        default_video_model = excluded.default_video_model,
        default_audio_model = excluded.default_audio_model,
        image_models = excluded.image_models,
        video_models = excluded.video_models,
        audio_models = excluded.audio_models,
        custom_headers = excluded.custom_headers,
        default_options = excluded.default_options,
        updated_at = excluded.updated_at
    `).run(
      final.id, final.presetId, final.name, final.baseUrl,
      apiKeyRef, final.enabled ? 1 : 0,
      final.defaultImageModel || null, final.defaultVideoModel || null, final.defaultAudioModel || null,
      final.imageModels ? JSON.stringify(final.imageModels) : null,
      final.videoModels ? JSON.stringify(final.videoModels) : null,
      final.audioModels ? JSON.stringify(final.audioModels) : null,
      JSON.stringify(final.customHeaders || {}),
      final.defaultOptions ? JSON.stringify(final.defaultOptions) : null,
      final.updatedAt
    );
    logger.info('media', `saved provider ${final.name}`);
    return { ...final, hasApiKey: !!apiKeyRef || !!getSecret(`media:${final.id}`) };
  }

  deleteProvider(id: string): void {
    getDb().prepare('DELETE FROM media_providers WHERE id = ?').run(id);
    deleteSecret(`media:${id}`);
  }

  async testProvider(id: string): Promise<{ ok: boolean; error?: string; hint?: string }> {
    const cfg = this.listProviders().find((p) => p.id === id);
    if (!cfg) return { ok: false, error: 'Provider not configured' };
    const apiKey = getSecret(`media:${id}`) || '';
    const adapter = adapterFor(cfg, apiKey, 'image');
    if (!adapter) return { ok: false, error: `No adapter available for preset "${cfg.presetId}"` };
    try { return await adapter.test(); } catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  }

  // ── Artifact listing ─────────────────────────────────────────────────────

  listArtifacts(projectId?: string): MediaArtifactRecord[] {
    if (projectId) {
      const rows = getDb().prepare('SELECT * FROM media_artifacts WHERE project_id = ? ORDER BY created_at DESC LIMIT 200')
        .all(projectId) as Array<Record<string, unknown>>;
      return rows.map(rowToArtifact);
    }
    const rows = getDb().prepare('SELECT * FROM media_artifacts ORDER BY created_at DESC LIMIT 200')
      .all() as Array<Record<string, unknown>>;
    return rows.map(rowToArtifact);
  }

  deleteArtifact(id: string): { ok: boolean; error?: string } {
    const row = getDb().prepare('SELECT * FROM media_artifacts WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return { ok: false, error: 'Artifact not found' };
    const dirInfo = projectRootFor(row.project_id as string | null);
    if (dirInfo) {
      const abs = join(dirInfo, row.relative_path as string);
      void unlink(abs).catch(() => undefined);
    } else {
      void unlink(join(paths.media, row.relative_path as string)).catch(() => undefined);
    }
    getDb().prepare('DELETE FROM media_artifacts WHERE id = ?').run(id);
    return { ok: true };
  }

  /** Returns an absolute filesystem path for an artifact, or null if unknown. */
  absolutePathFor(rec: MediaArtifactRecord): string | null {
    const dirInfo = projectRootFor(rec.projectId);
    if (!dirInfo) return join(paths.media, rec.relativePath);
    return join(dirInfo, rec.relativePath);
  }

  /**
   * One-time repair for artifacts saved by an earlier build that wrote files
   * with no extension and stored a broken `<month>/<id>.<id>` relative path.
   * The real file was named by the bare job id; here we rename it to
   * `<id>.<ext>` (extension from its mime type / kind) and fix the stored path
   * so Open, Reveal-in-folder, and the hive-media:// preview all resolve.
   */
  repairArtifactPaths(): void {
    let rows: Array<Record<string, unknown>>;
    try {
      rows = getDb().prepare("SELECT * FROM media_artifacts WHERE status = 'succeeded'").all() as Array<Record<string, unknown>>;
    } catch { return; }
    let fixed = 0;
    for (const row of rows) {
      const rec = rowToArtifact(row);
      const abs = this.absolutePathFor(rec);
      if (!abs) continue;
      const base = projectRootFor(rec.projectId) || paths.media;
      const month = rec.relativePath.includes('/')
        ? rec.relativePath.split('/')[0]
        : new Date(rec.createdAt).toISOString().slice(0, 7);

      // Detect broken <id>.<id> pattern: basename without extension equals the id
      const relName = rec.relativePath.includes('/') ? rec.relativePath.split('/')[1] : rec.relativePath;
      const dotIdx = relName.lastIndexOf('.');
      const nameWithoutExt = dotIdx > 0 ? relName.slice(0, dotIdx) : relName;
      const isBroken = nameWithoutExt === rec.id && dotIdx > 0;

      if (!isBroken && existsSync(abs)) continue; // already valid — nothing to repair

      const ext = extForArtifact(rec.mimeType, rec.kind);
      const newRel = `${month}/${rec.id}.${ext}`;
      const newAbs = join(base, newRel);

      // Try to resolve from a legacy bare-id file first, then the broken <id>.<id> file
      const orphan = join(base, month, rec.id); // legacy: bare id, no extension
      const brokenPath = join(base, month, relName); // exists at <id>.<id>
      const src = existsSync(orphan) ? orphan : existsSync(brokenPath) ? brokenPath : null;
      if (!src || src === newAbs) continue;
      try {
        renameSync(src, newAbs);
        getDb().prepare('UPDATE media_artifacts SET relative_path = ? WHERE id = ?').run(newRel, rec.id);
        fixed += 1;
      } catch (err) {
        logger.warn('media', `artifact path repair failed for ${rec.id}: ${String(err)}`);
      }
    }
    if (fixed > 0) logger.info('media', `Repaired ${fixed} media artifact path(s) from a legacy naming bug.`);
  }

  /** Look up an artifact's absolute path + mime type by id (used by the
   *  hive-media:// protocol handler to stream files to the renderer). */
  artifactFileById(id: string): { path: string; mimeType: string } | null {
    const row = getDb().prepare('SELECT * FROM media_artifacts WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    const rec = rowToArtifact(row);
    const abs = this.absolutePathFor(rec);
    return abs ? { path: abs, mimeType: rec.mimeType } : null;
  }

  // ── Generation ───────────────────────────────────────────────────────────

  /** Resolve a request to a concrete adapter. Two paths: a chat *model
   *  provider* (uses its base URL + key against the OpenAI-compatible image /
   *  speech endpoints) or a dedicated *media provider* (Replicate, ComfyUI…). */
  private resolveGeneration(req: MediaGenerationRequest): {
    kind: MediaKind; model: string; adapter: MediaAdapter; cfg: MediaProviderConfig; apiKey: string; providerRefId: string;
  } {
    // Model (chat) provider path.
    if (req.modelProviderId) {
      const mp = getProviderConfig(req.modelProviderId);
      if (!mp) throw new Error('Selected model provider not found.');
      const kind = req.kind || 'image';
      const isMinimax = isMinimaxProvider(mp.presetId, mp.baseUrl);
      // MiniMax generates all four kinds through its native endpoints; other
      // chat providers only cover image + speech via the OpenAI-compatible shape.
      if (!isMinimax && kind === 'video') {
        throw new Error('Video generation is not available through this chat provider. Use a dedicated media provider (Replicate, ComfyUI…) in Settings → Media.');
      }
      const apiKey = getSecret(`provider:${mp.id}`) || '';
      const presetId = isMinimax ? 'minimax-media' : kind === 'audio' ? 'openai-tts' : 'openai-compatible';
      const cfg: MediaProviderConfig = {
        id: `model:${mp.id}`,
        presetId,
        name: mp.name,
        baseUrl: mp.baseUrl,
        hasApiKey: !!apiKey,
        enabled: true,
        customHeaders: mp.customHeaders,
        updatedAt: Date.now()
      };
      const adapter = adapterFor(cfg, apiKey, kind);
      if (!adapter) throw new Error(`No ${kind} adapter available for provider "${mp.name}".`);
      return { kind, model: req.model || '', adapter, cfg, apiKey, providerRefId: cfg.id };
    }

    // Dedicated media provider path.
    const providers = this.listProviders();
    const provider = providers.find((p) => p.enabled && p.id === req.providerId) ||
      providers.find((p) => p.enabled);
    if (!provider) throw new Error('No media provider configured. Add one in Settings → Media, or connect a model provider that offers media models.');
    const preset = findMediaPreset(provider.presetId);
    const kind = inferKind(req, preset);
    const defaultModelForKind =
      kind === 'video' ? provider.defaultVideoModel :
      kind === 'audio' ? provider.defaultAudioModel :
      provider.defaultImageModel;
    const model = req.model || defaultModelForKind || preset?.defaultModel || '';
    const apiKey = getSecret(`media:${provider.id}`) || '';
    const adapter = adapterFor(provider, apiKey, kind);
    if (!adapter) throw new Error(`No adapter for preset "${provider.presetId}" (${kind})`);
    return { kind, model, adapter, cfg: provider, apiKey, providerRefId: provider.id };
  }

  async generate(req: MediaGenerationRequest, opts: { conversationId?: string; messageId?: string; jobId?: string } = {}): Promise<MediaArtifactRecord> {
    const id = opts.jobId || randomUUID();
    const { kind, model, adapter, cfg, apiKey, providerRefId } = this.resolveGeneration(req);
    const cancel = new AbortController();
    this.cancellations.set(id, cancel);

    // Project-scoped path: <project>/media/<yyyy-mm>/<jobId>.<ext>
    // Fallback: <userData>/media/<yyyy-mm>/<jobId>.<ext>
    const projectId = req.projectId;
    const baseDir = projectRootFor(projectId) || paths.media;
    const month = new Date().toISOString().slice(0, 7);
    const dir = join(baseDir, month);
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    const filenameHint = `${id}.bin`;
    const record: Partial<MediaJobRecord> = {
      id,
      conversationId: opts.conversationId,
      messageId: opts.messageId,
      projectId: projectId ?? undefined,
      kind,
      providerId: providerRefId,
      model,
      prompt: req.prompt,
      negativePrompt: req.negativePrompt,
      width: req.width,
      height: req.height,
      durationSeconds: req.durationSeconds,
      seed: req.seed,
      relativePath: `${month}/${filenameHint}`,
      mimeType: 'application/octet-stream',
      bytes: 0,
      status: 'queued',
      options: req.options,
      createdAt: Date.now(),
      startedAt: Date.now()
    };
    insertArtifactRecord(record);
    this.emit({ job: this.toPublic(record) });

    try {
      const mergedOptions = { ...(cfg.defaultOptions || {}), ...(req.options || {}) };
      const res = await adapter.generate(
        { ...req, model, options: mergedOptions },
        // Let the adapter name the file so it carries the correct extension for
        // the generated media type; we store that exact basename below.
        { outputDir: dirname(join(baseDir, record.relativePath!)), apiKey, cfg }
      );
      if (res.bytes > MAX_ARTIFACT_BYTES) {
        // Remove the file we just wrote, then surface a friendly error.
        try { const { unlink: ul } = await import('node:fs/promises'); await ul(res.absolutePath); } catch { /* ignore */ }
        throw new Error(`Generated artifact exceeds ${Math.round(MAX_ARTIFACT_BYTES / 1024 / 1024)} MB limit`);
      }
      const rel = `${month}/${basename(res.absolutePath)}`;
      const updated: Partial<MediaJobRecord> = {
        ...record,
        relativePath: rel,
        mimeType: res.mimeType,
        bytes: res.bytes,
        status: 'succeeded',
        width: res.width,
        height: res.height,
        durationSeconds: res.durationSeconds,
        seed: res.seed,
        finishedAt: Date.now(),
        error: undefined
      };
      getDb().prepare(`UPDATE media_artifacts SET relative_path = ?, mime_type = ?, bytes = ?, status = ?, width = ?, height = ?, duration_seconds = ?, seed = ?, finished_at = ?, error = NULL WHERE id = ?`)
        .run(rel, res.mimeType, res.bytes, 'succeeded', res.width ?? null, res.height ?? null, res.durationSeconds ?? null, res.seed ?? null, Date.now(), id);
      this.cancellations.delete(id);
      const pub = this.toPublic(updated);
      this.emit({ job: pub });
      return pub;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      getDb().prepare('UPDATE media_artifacts SET status = ?, error = ?, finished_at = ? WHERE id = ?')
        .run('failed', msg, Date.now(), id);
      this.cancellations.delete(id);
      const pub = this.toPublic({ ...record, status: 'failed', error: msg, finishedAt: Date.now() });
      this.emit({ job: pub });
      throw err;
    }
  }

  cancel(id: string): boolean {
    const c = this.cancellations.get(id);
    if (!c) return false;
    c.abort();
    getDb().prepare('UPDATE media_artifacts SET status = ?, error = ?, finished_at = ? WHERE id = ?')
      .run('cancelled', 'Cancelled by user', Date.now(), id);
    return true;
  }

  // ── File operations for the renderer ─────────────────────────────────────

  /** Copy an artifact into the current project (so it's easy to share). */
  async copyArtifactToProject(artifactId: string, projectPath: string, subfolder = ''): Promise<{ ok: boolean; error?: string; path?: string }> {
    const row = getDb().prepare('SELECT * FROM media_artifacts WHERE id = ?').get(artifactId) as Record<string, unknown> | undefined;
    if (!row) return { ok: false, error: 'Artifact not found' };
    const src = join(paths.media, row.relative_path as string);
    const target = join(projectPath, 'media', subfolder || '', `${artifactId}${extOf(row.relative_path as string)}`);
    if (!existsSync(src)) return { ok: false, error: 'Source file missing' };
    const dir = dirname(target);
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    await copyFile(src, target);
    return { ok: true, path: target };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private toPublic(rec: Partial<MediaJobRecord>): MediaJobRecord {
    return {
      id: rec.id!, conversationId: rec.conversationId, messageId: rec.messageId,
      projectId: rec.projectId ?? undefined, kind: rec.kind!, providerId: rec.providerId!,
      model: rec.model!, prompt: rec.prompt!, negativePrompt: rec.negativePrompt,
      width: rec.width, height: rec.height, durationSeconds: rec.durationSeconds, seed: rec.seed,
      relativePath: rec.relativePath!, mimeType: rec.mimeType!, bytes: rec.bytes!,
      status: rec.status!, error: rec.error, options: rec.options,
      createdAt: rec.createdAt!, startedAt: rec.startedAt, finishedAt: rec.finishedAt
    };
  }

  private emit(evt: MediaJobStatusEvent): void {
    for (const listener of this.listeners) {
      try { listener(evt); } catch { /* ignore listener errors */ }
    }
  }
}

function projectRootFor(projectId?: string | null): string | null {
  if (!projectId) return null;
  const row = getDb().prepare('SELECT path FROM projects WHERE id = ?').get(projectId) as { path?: string } | undefined;
  return row?.path || null;
}

/** Best-effort file extension for a stored artifact, from its mime type first
 *  and falling back to a sensible default per media kind. */
function extForArtifact(mime: string | undefined, kind: MediaKind): string {
  const m = (mime || '').toLowerCase();
  if (m.includes('png')) return 'png';
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  if (m.includes('webp')) return 'webp';
  if (m.includes('gif')) return 'gif';
  if (m.includes('svg')) return 'svg';
  if (m.includes('mp4')) return 'mp4';
  if (m.includes('webm')) return 'webm';
  if (m.includes('quicktime') || m.includes('mov')) return 'mov';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('wav')) return 'wav';
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('flac')) return 'flac';
  if (m.includes('m4a') || m.includes('aac')) return 'm4a';
  return kind === 'video' ? 'mp4' : kind === 'audio' ? 'mp3' : 'png';
}

export function isMinimaxProvider(presetId?: string, baseUrl?: string): boolean {
  return presetId === 'minimax' || /minimax/i.test(baseUrl || '');
}

// Default MiniMax media model per kind for tool-driven / auto-picked generation.
const MINIMAX_DEFAULT_MEDIA_MODEL: Record<MediaKind, string> = {
  image: 'image-01',
  audio: 'speech-02-hd',
  video: 'MiniMax-Hailuo-02'
};

function presetSupportsKind(presetId: string, kind: MediaKind): boolean {
  const preset = findMediaPreset(presetId);
  if (!preset) return false;
  if (preset.models.some((m) => m.kind === kind)) return true;
  if (preset.kind === kind) return true;
  return preset.kind === 'both' && kind !== 'audio';
}

function inferKind(req: MediaGenerationRequest, preset?: MediaProviderPreset): MediaKind {
  if (req.kind) return req.kind;
  if (preset?.kind === 'audio') return 'audio';
  if (req.durationSeconds && req.durationSeconds > 0) return 'video';
  if (preset?.kind === 'video') return 'video';
  return 'image';
}

function extOf(rel: string): string {
  const i = rel.lastIndexOf('.');
  return i >= 0 ? rel.slice(i) : '';
}

function rowToProviderConfig(row: Record<string, unknown>): MediaProviderConfig {
  return {
    id: row.id as string,
    presetId: row.preset_id as string,
    name: row.name as string,
    baseUrl: (row.base_url as string) || '',
    hasApiKey: !!getSecret(`media:${row.id}`),
    enabled: row.enabled === 1,
    defaultImageModel: (row.default_image_model as string) || undefined,
    defaultVideoModel: (row.default_video_model as string) || undefined,
    defaultAudioModel: (row.default_audio_model as string) || undefined,
    imageModels: parseModels(row.image_models as string),
    videoModels: parseModels(row.video_models as string),
    audioModels: parseModels(row.audio_models as string),
    customHeaders: parseJSON(row.custom_headers as string, {}),
    defaultOptions: parseJSON(row.default_options as string, undefined),
    updatedAt: row.updated_at as number
  };
}

function parseModels(s: string | null): MediaModelOption[] | undefined {
  if (!s) return undefined;
  const arr = parseJSON<MediaModelOption[]>(s, []);
  return Array.isArray(arr) ? arr : undefined;
}

function parseJSON<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

function rowToArtifact(row: Record<string, unknown>): MediaArtifactRecord {
  return {
    id: row.id as string,
    conversationId: (row.conversation_id as string) || undefined,
    messageId: (row.message_id as string) || undefined,
    projectId: (row.project_id as string) || undefined,
    kind: row.kind as 'image' | 'video',
    providerId: row.provider_id as string,
    model: row.model as string,
    prompt: row.prompt as string,
    negativePrompt: (row.negative_prompt as string) || undefined,
    width: (row.width as number) || undefined,
    height: (row.height as number) || undefined,
    durationSeconds: (row.duration_seconds as number) || undefined,
    seed: (row.seed as number) || undefined,
    relativePath: row.relative_path as string,
    mimeType: row.mime_type as string,
    bytes: row.bytes as number,
    status: row.status as MediaArtifactRecord['status'],
    error: (row.error as string) || undefined,
    options: parseJSON(row.options as string, undefined),
    createdAt: row.created_at as number
  };
}

function insertArtifactRecord(rec: Partial<MediaJobRecord>): void {
  getDb().prepare(`INSERT OR REPLACE INTO media_artifacts (
    id, conversation_id, message_id, project_id, kind, provider_id, model,
    prompt, negative_prompt, width, height, duration_seconds, seed,
    relative_path, mime_type, bytes, status, error, options,
    created_at, started_at, finished_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    rec.id,
    rec.conversationId || null,
    rec.messageId || null,
    rec.projectId || null,
    rec.kind,
    rec.providerId,
    rec.model,
    rec.prompt,
    rec.negativePrompt || null,
    rec.width || null,
    rec.height || null,
    rec.durationSeconds || null,
    rec.seed || null,
    rec.relativePath,
    rec.mimeType,
    rec.bytes,
    rec.status,
    rec.error || null,
    rec.options ? JSON.stringify(rec.options) : null,
    rec.createdAt,
    rec.startedAt || null,
    rec.finishedAt || null
  );
}
