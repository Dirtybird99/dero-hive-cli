import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MediaGenerationRequest, MediaProviderConfig, MediaKind } from '@shared/types';

// ───────────────────────────────────────────────────────────────────────────
// Adapter interface
// ───────────────────────────────────────────────────────────────────────────

export interface MediaJobResult {
  /** Absolute path of the saved file (image or video). */
  absolutePath: string;
  relativePath: string;
  mimeType: string;
  bytes: number;
  width?: number;
  height?: number;
  durationSeconds?: number;
  seed?: number;
}

export interface MediaAdapterContext {
  /** Directory where the artifact file should be written. */
  outputDir: string;
  /** Optional base filename. When omitted, the adapter picks a name that
   *  includes the correct extension for the generated media type. */
  filename?: string;
  /** Resolved API key (empty string if the provider does not need one). */
  apiKey: string;
  /** Provider config (already merged with presets). */
  cfg: MediaProviderConfig;
}

export interface MediaAdapter {
  readonly id: string;
  readonly kind: MediaKind;
  test(): Promise<{ ok: boolean; error?: string; hint?: string }>;
  generate(req: MediaGenerationRequest, ctx: MediaAdapterContext): Promise<MediaJobResult>;
}

// ───────────────────────────────────────────────────────────────────────────
// Shared helpers
// ───────────────────────────────────────────────────────────────────────────

function guessMimeFromExt(ext: string): string {
  const e = ext.toLowerCase().replace('.', '');
  switch (e) {
    case 'png': return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'webp': return 'image/webp';
    case 'gif': return 'image/gif';
    case 'mp4': return 'video/mp4';
    case 'webm': return 'video/webm';
    case 'mov': return 'video/quicktime';
    case 'mp3': return 'audio/mpeg';
    case 'wav': return 'audio/wav';
    case 'ogg': return 'audio/ogg';
    case 'flac': return 'audio/flac';
    case 'm4a': return 'audio/mp4';
    default: return 'application/octet-stream';
  }
}

function audioExtFromMime(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('wav')) return 'wav';
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('flac')) return 'flac';
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'm4a';
  return 'mp3';
}

function makeFilename(kind: MediaKind, ext: string): string {
  const safeExt = ext.startsWith('.') ? ext : '.' + ext;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const id = randomUUID().slice(0, 8);
  return `${kind}-${stamp}-${id}${safeExt}`;
}

async function writeBuffer(absPath: string, buf: Buffer): Promise<number> {
  await writeFile(absPath, buf);
  return buf.length;
}

function resolveAspectOrDefault(req: MediaGenerationRequest): { width: number; height: number } {
  const w = Number.isFinite(req.width) && req.width && req.width > 0 ? Math.floor(req.width) : 1024;
  const h = Number.isFinite(req.height) && req.height && req.height > 0 ? Math.floor(req.height) : 1024;
  return { width: w, height: h };
}

function readJsonSafe(text: string): Record<string, unknown> | null {
  try { return JSON.parse(text) as Record<string, unknown>; } catch { return null; }
}

// ───────────────────────────────────────────────────────────────────────────
// OpenAI Images
// ───────────────────────────────────────────────────────────────────────────

const OPENAI_DEFAULT_BASE = 'https://api.openai.com/v1';

export class OpenAIImageAdapter implements MediaAdapter {
  readonly id = 'openai-images';
  readonly kind = 'image' as const;

  constructor(private readonly cfg: MediaProviderConfig, private readonly apiKey: string) {}

  private baseUrl(): string {
    return (this.cfg.baseUrl || OPENAI_DEFAULT_BASE).replace(/\/$/, '');
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
      ...(this.cfg.customHeaders || {})
    };
  }

  async test(): Promise<{ ok: boolean; error?: string; hint?: string }> {
    if (!this.apiKey) return { ok: false, error: 'API key required' };
    try {
      const r = await fetch(`${this.baseUrl()}/models`, { headers: this.headers() });
      if (r.ok) return { ok: true };
      if (r.status === 401 || r.status === 403) return { ok: false, error: `Auth failed (${r.status})`, hint: 'Check the OpenAI API key.' };
      return { ok: false, error: `HTTP ${r.status}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async generate(req: MediaGenerationRequest, ctx: MediaAdapterContext): Promise<MediaJobResult> {
    if (!this.apiKey) throw new Error('OpenAI API key not set');
    const model = req.model || 'dall-e-3';
    const { width, height } = resolveAspectOrDefault(req);
    const body: Record<string, unknown> = {
      model,
      prompt: req.prompt,
      n: 1,
      size: pickOpenAISize(model, width, height)
    };
    if (model === 'dall-e-3' && typeof req.seed === 'number') body.seed = Math.floor(req.seed);

    const resp = await fetch(`${this.baseUrl()}/images/generations`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body)
    });
    if (!resp.ok) {
      const t = await resp.text();
      throw new Error(`OpenAI image error: ${resp.status} ${t.slice(0, 400)}`);
    }
    const json = readJsonSafe(await resp.text()) as { data?: Array<{ b64_json?: string; url?: string }> } | null;
    const first = json?.data?.[0];
    if (!first) throw new Error('OpenAI returned no image');

    let buffer: Buffer;
    let mime: string;
    let ext: string;
    if (first.b64_json) {
      buffer = Buffer.from(first.b64_json, 'base64');
      mime = 'image/png';
      ext = 'png';
    } else if (first.url) {
      const r = await fetch(first.url);
      if (!r.ok) throw new Error(`OpenAI image URL fetch failed: ${r.status}`);
      const arr = new Uint8Array(await r.arrayBuffer());
      buffer = Buffer.from(arr);
      mime = r.headers.get('content-type') || 'image/png';
      ext = mimeToExt(mime);
    } else {
      throw new Error('OpenAI response had neither b64_json nor url');
    }

    const filename = makeFilename('image', ext);
    const abs = join(ctx.outputDir, ctx.filename || filename);
    const relative = ctx.filename || filename;
    const bytes = await writeBuffer(abs, buffer);
    return { absolutePath: abs, relativePath: relative, mimeType: mime, bytes, width, height, seed: req.seed };
  }
}

function mimeToExt(mime: string, kind: MediaKind = 'image'): string {
  const m = mime.toLowerCase();
  if (m.startsWith('audio/')) return audioExtFromMime(m);
  if (m.includes('jpeg')) return 'jpg';
  if (m.includes('png')) return 'png';
  if (m.includes('webp')) return 'webp';
  if (m.includes('gif')) return 'gif';
  if (m.includes('mp4')) return 'mp4';
  if (m.includes('webm')) return 'webm';
  if (m.includes('quicktime')) return 'mov';
  // Unknown mime: fall back per artifact kind rather than always assuming png.
  return kind === 'video' ? 'mp4' : kind === 'audio' ? 'mp3' : 'png';
}

function pickOpenAISize(model: string, width: number, height: number): string {
  if (model === 'dall-e-2') {
    if (width === height) return '1024x1024';
    if (width === 512 && height === 512) return '512x512';
    if (width === 256 && height === 256) return '256x256';
    return '1024x1024';
  }
  // DALL-E 3 / gpt-image-1
  if (width === height) return '1024x1024';
  if (width > height) return '1792x1024';
  return '1024x1792';
}

// ───────────────────────────────────────────────────────────────────────────
// Stability AI
// ───────────────────────────────────────────────────────────────────────────

const STABILITY_DEFAULT_BASE = 'https://api.stability.ai';

export class StabilityAdapter implements MediaAdapter {
  readonly id = 'stability';
  readonly kind = 'image' as const;

  constructor(private readonly cfg: MediaProviderConfig, private readonly apiKey: string) {}

  private baseUrl(): string { return (this.cfg.baseUrl || STABILITY_DEFAULT_BASE).replace(/\/$/, ''); }
  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'image/*',
      ...(this.cfg.customHeaders || {})
    };
  }

  async test(): Promise<{ ok: boolean; error?: string; hint?: string }> {
    if (!this.apiKey) return { ok: false, error: 'API key required' };
    try {
      const r = await fetch(`${this.baseUrl()}/v1/user/accounts`, { headers: this.headers() });
      if (r.ok) return { ok: true };
      if (r.status === 401 || r.status === 403) return { ok: false, error: `Auth failed (${r.status})`, hint: 'Get a key at platform.stability.ai.' };
      return { ok: false, error: `HTTP ${r.status}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async generate(req: MediaGenerationRequest, ctx: MediaAdapterContext): Promise<MediaJobResult> {
    if (!this.apiKey) throw new Error('Stability API key not set');
    const model = req.model || this.cfg.defaultImageModel || 'stable-image-core';
    const { width, height } = resolveAspectOrDefault(req);
    const isCore = model === 'stable-image-core';
    const endpoint = isCore
      ? `${this.baseUrl()}/v2beta/stable-image/generate/core`
      : `${this.baseUrl()}/v2beta/stable-image/generate/${model}`;

    const form = new FormData();
    form.append('prompt', req.prompt);
    if (req.negativePrompt) form.append('negative_prompt', req.negativePrompt);
    form.append('output_format', 'png');
    if (typeof req.seed === 'number') form.append('seed', String(Math.floor(req.seed)));
    if (typeof req.cfgScale === 'number') form.append('cfg_scale', String(req.cfgScale));

    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: 'image/*',
        ...(this.cfg.customHeaders || {})
      },
      body: form
    });
    if (!resp.ok) {
      const t = await resp.text();
      throw new Error(`Stability error: ${resp.status} ${t.slice(0, 400)}`);
    }
    const arr = new Uint8Array(await resp.arrayBuffer());
    const buf = Buffer.from(arr);
    const filename = makeFilename('image', 'png');
    const abs = join(ctx.outputDir, ctx.filename || filename);
    const relative = ctx.filename || filename;
    const bytes = await writeBuffer(abs, buf);
    return { absolutePath: abs, relativePath: relative, mimeType: 'image/png', bytes, width, height, seed: req.seed };
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Pollinations.ai (no key, image only)
// ───────────────────────────────────────────────────────────────────────────

export class PollinationsAdapter implements MediaAdapter {
  readonly id = 'pollinations';
  readonly kind = 'image' as const;

  constructor(private readonly cfg: MediaProviderConfig) {}

  async test(): Promise<{ ok: boolean; error?: string; hint?: string }> {
    try {
      const url = `https://image.pollinations.ai/prompt/test?width=64&height=64&nologo=true`;
      const r = await fetch(url, { method: 'HEAD' });
      if (r.ok || r.status === 200 || r.status === 302) return { ok: true };
      return { ok: false, error: `HTTP ${r.status}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async generate(req: MediaGenerationRequest, ctx: MediaAdapterContext): Promise<MediaJobResult> {
    const model = req.model || 'flux';
    const { width, height } = resolveAspectOrDefault(req);
    const u = new URL('https://image.pollinations.ai/prompt/' + encodeURIComponent(req.prompt));
    u.searchParams.set('width', String(width));
    u.searchParams.set('height', String(height));
    u.searchParams.set('model', model);
    u.searchParams.set('nologo', 'true');
    if (typeof req.seed === 'number') u.searchParams.set('seed', String(Math.floor(req.seed)));
    u.searchParams.set('enhance', 'true');
    const resp = await fetch(u.toString());
    if (!resp.ok) throw new Error(`Pollinations error: ${resp.status}`);
    const arr = new Uint8Array(await resp.arrayBuffer());
    const buf = Buffer.from(arr);
    const mime = resp.headers.get('content-type') || 'image/jpeg';
    const ext = mimeToExt(mime);
    const filename = makeFilename('image', ext);
    const abs = join(ctx.outputDir, ctx.filename || filename);
    const relative = ctx.filename || filename;
    const bytes = await writeBuffer(abs, buf);
    return { absolutePath: abs, relativePath: relative, mimeType: mime, bytes, width, height, seed: req.seed };
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Replicate (image + video, with polling)
// ───────────────────────────────────────────────────────────────────────────

export class ReplicateAdapter implements MediaAdapter {
  readonly id = 'replicate';
  readonly kind: MediaKind;

  constructor(
    private readonly cfg: MediaProviderConfig,
    private readonly apiKey: string,
    kind: MediaKind
  ) {
    this.kind = kind;
  }

  private baseUrl(): string { return (this.cfg.baseUrl || 'https://api.replicate.com/v1').replace(/\/$/, ''); }
  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Token ${this.apiKey}`,
      'Content-Type': 'application/json',
      ...(this.cfg.customHeaders || {}),
      ...(extra || {})
    };
  }

  async test(): Promise<{ ok: boolean; error?: string; hint?: string }> {
    if (!this.apiKey) return { ok: false, error: 'Replicate API token required' };
    try {
      const r = await fetch(`${this.baseUrl()}/models?limit=1`, { headers: this.headers() });
      if (r.ok) return { ok: true };
      if (r.status === 401 || r.status === 403) return { ok: false, error: `Auth failed (${r.status})`, hint: 'Check your Replicate API token.' };
      return { ok: false, error: `HTTP ${r.status}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async generate(req: MediaGenerationRequest, ctx: MediaAdapterContext): Promise<MediaJobResult> {
    if (!this.apiKey) throw new Error('Replicate API token required');
    const model = req.model || (this.kind === 'video' ? 'minimax/video-01' : this.kind === 'audio' ? 'meta/musicgen' : 'black-forest-labs/flux-schnell');
    const { width, height } = resolveAspectOrDefault(req);

    const input: Record<string, unknown> = { prompt: req.prompt };
    if (this.kind === 'image') {
      if (model.includes('flux')) {
        input.aspect_ratio = aspectFromSize(width, height);
        input.output_format = 'png';
        if (typeof req.seed === 'number') input.seed = Math.floor(req.seed);
        if (req.steps) input.steps = req.steps;
        if (req.negativePrompt) input.go_fast = false;
      } else if (model.includes('sdxl') || model.includes('sd-')) {
        input.width = width;
        input.height = height;
        input.num_inference_steps = req.steps || 30;
        input.guidance_scale = req.cfgScale || 7.5;
        if (typeof req.seed === 'number') input.seed = Math.floor(req.seed);
        if (req.negativePrompt) input.negative_prompt = req.negativePrompt;
      }
    } else if (this.kind === 'audio') {
      // MusicGen: { prompt, duration }. MiniMax music: { prompt }. Keep the
      // common fields and let the model ignore anything it does not use.
      if (typeof req.durationSeconds === 'number' && req.durationSeconds > 0) {
        input.duration = Math.max(1, Math.min(30, Math.round(req.durationSeconds)));
      }
      if (typeof req.seed === 'number') input.seed = Math.floor(req.seed);
      input.output_format = 'mp3';
    } else {
      input.num_frames = Math.max(16, Math.min(120, Math.round((req.durationSeconds || 4) * 16)));
      if (req.referenceImageIds && req.referenceImageIds.length) input.image = req.referenceImageIds[0];
    }

    // Start prediction
    const startResp = await fetch(`${this.baseUrl()}/models/${model}/predictions`, {
      method: 'POST',
      headers: this.headers({ Prefer: 'wait' }),
      body: JSON.stringify({ input })
    });
    if (!startResp.ok) {
      const t = await startResp.text();
      throw new Error(`Replicate start failed: ${startResp.status} ${t.slice(0, 400)}`);
    }
    let prediction = readJsonSafe(await startResp.text()) as { id?: string; urls?: { get?: string }; status?: string; output?: unknown } | null;
    if (!prediction?.id) throw new Error('Replicate returned no prediction id');
    const getUrl = prediction.urls?.get || `${this.baseUrl()}/predictions/${prediction.id}`;

    // Poll until done (max ~5 min)
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
      if (prediction.status === 'succeeded' || prediction.status === 'failed' || prediction.status === 'canceled') break;
      await new Promise((r) => setTimeout(r, 1500));
      const poll = await fetch(getUrl, { headers: this.headers() });
      if (!poll.ok) throw new Error(`Replicate poll error: ${poll.status}`);
      prediction = readJsonSafe(await poll.text()) as typeof prediction;
    }
    if (prediction?.status !== 'succeeded') throw new Error(`Replicate prediction ${prediction?.status || 'unknown'}: ${(prediction as { error?: string })?.error || ''}`);
    const output = prediction?.output;
    const mediaUrl = extractReplicateOutput(output);
    if (!mediaUrl) throw new Error('Replicate returned no media');

    const dl = await fetch(mediaUrl);
    if (!dl.ok) throw new Error(`Replicate download failed: ${dl.status}`);
    const arr = new Uint8Array(await dl.arrayBuffer());
    const buf = Buffer.from(arr);
    const defaultMime = this.kind === 'video' ? 'video/mp4' : this.kind === 'audio' ? 'audio/mpeg' : 'image/png';
    const mime = dl.headers.get('content-type') || defaultMime;
    const ext = mimeToExt(mime, this.kind);
    const filename = makeFilename(this.kind, ext);
    const abs = join(ctx.outputDir, ctx.filename || filename);
    const relative = ctx.filename || filename;
    const bytes = await writeBuffer(abs, buf);
    return {
      absolutePath: abs,
      relativePath: relative,
      mimeType: mime,
      bytes,
      width: this.kind === 'image' ? width : undefined,
      height: this.kind === 'image' ? height : undefined,
      durationSeconds: this.kind === 'video' || this.kind === 'audio' ? req.durationSeconds : undefined,
      seed: req.seed
    };
  }
}

function aspectFromSize(w: number, h: number): string {
  const r = w / h;
  if (Math.abs(r - 1) < 0.05) return '1:1';
  if (Math.abs(r - 16 / 9) < 0.05) return '16:9';
  if (Math.abs(r - 9 / 16) < 0.05) return '9:16';
  if (Math.abs(r - 4 / 3) < 0.05) return '4:3';
  if (Math.abs(r - 3 / 4) < 0.05) return '3:4';
  if (Math.abs(r - 21 / 9) < 0.05) return '21:9';
  return `${w}:${h}`;
}

function extractReplicateOutput(output: unknown): string | null {
  if (!output) return null;
  if (typeof output === 'string') return output;
  if (Array.isArray(output) && output.length > 0) {
    const first = output[0];
    if (typeof first === 'string') return first;
    if (first && typeof first === 'object' && 'url' in first && typeof (first as { url: unknown }).url === 'string') {
      return (first as { url: string }).url;
    }
  }
  if (output && typeof output === 'object' && 'url' in output && typeof (output as { url: unknown }).url === 'string') {
    return (output as { url: string }).url;
  }
  return null;
}

// ───────────────────────────────────────────────────────────────────────────
// ComfyUI (local)
// ───────────────────────────────────────────────────────────────────────────

export class ComfyUIAdapter implements MediaAdapter {
  readonly id = 'comfyui';
  readonly kind: 'image' | 'video';

  constructor(
    private readonly cfg: MediaProviderConfig,
    kind: 'image' | 'video'
  ) {
    this.kind = kind;
  }

  private baseUrl(): string { return (this.cfg.baseUrl || 'http://127.0.0.1:8188').replace(/\/$/, ''); }

  async test(): Promise<{ ok: boolean; error?: string; hint?: string }> {
    try {
      const r = await fetch(`${this.baseUrl()}/system_stats`);
      if (r.ok) return { ok: true };
      return { ok: false, error: `HTTP ${r.status}`, hint: 'Start ComfyUI with --api and ensure the URL matches the listening interface.' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), hint: 'Is the ComfyUI server running? It defaults to http://127.0.0.1:8188.' };
    }
  }

  async generate(req: MediaGenerationRequest, ctx: MediaAdapterContext): Promise<MediaJobResult> {
    const { width, height } = resolveAspectOrDefault(req);
    const seed = typeof req.seed === 'number' ? Math.floor(req.seed) : Math.floor(Math.random() * 1_000_000_000);
    // Minimal positive-prompt text2img workflow. Real workflows will differ
    // per model; this is enough to verify the ComfyUI plumbing end-to-end.
    const workflow = req.options?.workflow ? JSON.parse(req.options.workflow) : buildDefaultWorkflow({
      positivePrompt: req.prompt,
      negativePrompt: req.negativePrompt || 'low quality, worst quality, blurry',
      width,
      height,
      seed,
      steps: req.steps || 20,
      cfg: req.cfgScale || 7
    });

    const queueResp = await fetch(`${this.baseUrl()}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(this.cfg.customHeaders || {}) },
      body: JSON.stringify({ prompt: workflow })
    });
    if (!queueResp.ok) throw new Error(`ComfyUI queue failed: ${queueResp.status} ${await queueResp.text()}`);
    const queued = readJsonSafe(await queueResp.text()) as { prompt_id?: string } | null;
    const promptId = queued?.prompt_id;
    if (!promptId) throw new Error('ComfyUI returned no prompt_id');

    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
      const hist = await fetch(`${this.baseUrl()}/history/${promptId}`);
      if (hist.ok) {
        const data = readJsonSafe(await hist.text()) as Record<string, { outputs?: Record<string, { images?: Array<{ filename: string; subfolder?: string; type?: string }>; gifs?: Array<{ filename: string; subfolder?: string }> }> }> | null;
        const entry = data?.[promptId];
        if (entry?.outputs) {
          const outs = Object.values(entry.outputs);
          for (const o of outs) {
            const candidates = [...(o.images || []), ...(o.gifs || []).map((g) => ({ ...g, type: 'output' as string, filename: g.filename }))];
            if (candidates.length === 0) continue;
            const media = candidates[0];
            const queryParams = new URLSearchParams({ filename: media.filename, subfolder: media.subfolder || '', type: media.type || 'output' }).toString();
            const dl = await fetch(`${this.baseUrl()}/view?${queryParams}`);
            if (!dl.ok) continue;
            const arr = new Uint8Array(await dl.arrayBuffer());
            const buf = Buffer.from(arr);
            const mime = dl.headers.get('content-type') || (this.kind === 'video' ? 'image/gif' : 'image/png');
            const ext = mimeToExt(mime, this.kind);
            const filename = makeFilename(this.kind, ext);
            const abs = join(ctx.outputDir, ctx.filename || filename);
            const relative = ctx.filename || filename;
            const bytes = await writeBuffer(abs, buf);
            return {
              absolutePath: abs, relativePath: relative, mimeType: mime, bytes,
              width, height, durationSeconds: this.kind === 'video' ? req.durationSeconds : undefined, seed
            };
          }
        }
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error('ComfyUI job timed out');
  }
}

interface DefaultWorkflowInput {
  positivePrompt: string;
  negativePrompt: string;
  width: number;
  height: number;
  seed: number;
  steps: number;
  cfg: number;
}

function buildDefaultWorkflow(i: DefaultWorkflowInput): Record<string, unknown> {
  return {
    '3': {
      inputs: { seed: i.seed, steps: i.steps, cfg: i.cfg, sampler_name: 'euler', scheduler: 'normal', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['8', 0] },
      class_type: 'KSampler'
    },
    '4': { inputs: { ckpt_name: 'sd_xl_base_1.0.safetensors' }, class_type: 'CheckpointLoaderSimple' },
    '6': { inputs: { text: i.positivePrompt, clip: ['4', 1] }, class_type: 'CLIPTextEncode' },
    '7': { inputs: { text: i.negativePrompt, clip: ['4', 1] }, class_type: 'CLIPTextEncode' },
    '8': { inputs: { width: i.width, height: i.height, batch_size: 1 }, class_type: 'EmptyLatentImage' },
    '9': { inputs: { samples: ['3', 0], vae: ['4', 2] }, class_type: 'VAEDecode' },
    '10': { inputs: { filename_prefix: 'HiveAIGen', images: ['9', 0] }, class_type: 'SaveImage' }
  };
}

// ───────────────────────────────────────────────────────────────────────────
// A1111 (local, image only)
// ───────────────────────────────────────────────────────────────────────────

export class A1111Adapter implements MediaAdapter {
  readonly id = 'a1111';
  readonly kind = 'image' as const;

  constructor(private readonly cfg: MediaProviderConfig) {}

  private baseUrl(): string { return (this.cfg.baseUrl || 'http://127.0.0.1:7860').replace(/\/$/, ''); }

  async test(): Promise<{ ok: boolean; error?: string; hint?: string }> {
    try {
      const r = await fetch(`${this.baseUrl()}/sd-api/v1/options`);
      if (r.ok) return { ok: true };
      return { ok: false, error: `HTTP ${r.status}`, hint: 'Start A1111 with --api and ensure the URL matches.' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async generate(req: MediaGenerationRequest, ctx: MediaAdapterContext): Promise<MediaJobResult> {
    const { width, height } = resolveAspectOrDefault(req);
    const body = {
      prompt: req.prompt,
      negative_prompt: req.negativePrompt || undefined,
      width,
      height,
      steps: req.steps || 28,
      cfg_scale: req.cfgScale || 7,
      seed: typeof req.seed === 'number' ? Math.floor(req.seed) : -1,
      sampler_name: 'Euler a',
      batch_size: 1,
      n_iter: 1
    };
    const resp = await fetch(`${this.baseUrl()}/sd-api/v1/txt2img`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(this.cfg.customHeaders || {}) },
      body: JSON.stringify(body)
    });
    if (!resp.ok) throw new Error(`A1111 error: ${resp.status}`);
    const json = readJsonSafe(await resp.text()) as { images?: string[]; info?: string } | null;
    const b64 = json?.images?.[0];
    if (!b64) throw new Error('A1111 returned no image');
    const buf = Buffer.from(b64, 'base64');
    const filename = makeFilename('image', 'png');
    const abs = join(ctx.outputDir, ctx.filename || filename);
    const relative = ctx.filename || filename;
    const bytes = await writeBuffer(abs, buf);
    let seedOut: number | undefined;
    try { seedOut = JSON.parse(json?.info || '{}')?.seed as number; } catch { /* ignore */ }
    return { absolutePath: abs, relativePath: relative, mimeType: 'image/png', bytes, width, height, seed: seedOut ?? req.seed };
  }
}

// ───────────────────────────────────────────────────────────────────────────
// OpenAI-compatible /v1/images/generations
// ───────────────────────────────────────────────────────────────────────────

export class OpenAICompatibleImageAdapter implements MediaAdapter {
  readonly id = 'openai-compatible';
  readonly kind = 'image' as const;

  constructor(private readonly cfg: MediaProviderConfig, private readonly apiKey: string) {}

  private baseUrl(): string { return (this.cfg.baseUrl || '').replace(/\/$/, ''); }
  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json', ...(this.cfg.customHeaders || {}) };
    if (this.apiKey) h['Authorization'] = `Bearer ${this.apiKey}`;
    return h;
  }

  async test(): Promise<{ ok: boolean; error?: string; hint?: string }> {
    if (!this.baseUrl()) return { ok: false, error: 'Base URL required' };
    try {
      const r = await fetch(`${this.baseUrl()}/models`, { headers: this.headers() });
      if (r.ok) return { ok: true };
      if (r.status === 401 || r.status === 403) return { ok: false, error: `Auth failed (${r.status})`, hint: 'Check the API key / Authorization header.' };
      return { ok: false, error: `HTTP ${r.status}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async generate(req: MediaGenerationRequest, ctx: MediaAdapterContext): Promise<MediaJobResult> {
    if (!this.baseUrl()) throw new Error('Base URL required');
    const { width, height } = resolveAspectOrDefault(req);
    const body: Record<string, unknown> = {
      model: req.model || this.cfg.defaultImageModel || 'flux-schnell',
      prompt: req.prompt,
      n: 1,
      size: `${width}x${height}`,
      response_format: 'b64_json'
    };
    if (typeof req.seed === 'number') body.seed = Math.floor(req.seed);
    if (req.negativePrompt) body.negative_prompt = req.negativePrompt;
    if (typeof req.steps === 'number') body.steps = req.steps;
    if (typeof req.cfgScale === 'number') body.cfg_scale = req.cfgScale;

    const resp = await fetch(`${this.baseUrl()}/images/generations`, {
      method: 'POST', headers: this.headers(), body: JSON.stringify(body)
    });
    if (!resp.ok) throw new Error(`Image API error: ${resp.status} ${(await resp.text()).slice(0, 400)}`);
    const json = readJsonSafe(await resp.text()) as { data?: Array<{ b64_json?: string; url?: string }> } | null;
    const first = json?.data?.[0];
    if (!first) throw new Error('Image API returned no data');
    let buf: Buffer;
    let mime: string;
    if (first.b64_json) {
      buf = Buffer.from(first.b64_json, 'base64');
      mime = 'image/png';
    } else if (first.url) {
      const r = await fetch(first.url);
      if (!r.ok) throw new Error(`Image URL fetch failed: ${r.status}`);
      buf = Buffer.from(new Uint8Array(await r.arrayBuffer()));
      mime = r.headers.get('content-type') || 'image/png';
    } else {
      throw new Error('Image API returned no usable data');
    }
    const ext = mimeToExt(mime);
    const filename = makeFilename('image', ext);
    const abs = join(ctx.outputDir, ctx.filename || filename);
    const relative = ctx.filename || filename;
    const bytes = await writeBuffer(abs, buf);
    return { absolutePath: abs, relativePath: relative, mimeType: mime, bytes, width, height, seed: req.seed };
  }
}

// ───────────────────────────────────────────────────────────────────────────
// OpenAI text-to-speech (/v1/audio/speech)
// ───────────────────────────────────────────────────────────────────────────

export class OpenAITTSAdapter implements MediaAdapter {
  readonly id = 'openai-tts';
  readonly kind = 'audio' as const;

  constructor(private readonly cfg: MediaProviderConfig, private readonly apiKey: string) {}

  private baseUrl(): string { return (this.cfg.baseUrl || OPENAI_DEFAULT_BASE).replace(/\/$/, ''); }
  private headers(): Record<string, string> {
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}`, ...(this.cfg.customHeaders || {}) };
  }

  async test(): Promise<{ ok: boolean; error?: string; hint?: string }> {
    if (!this.apiKey) return { ok: false, error: 'API key required' };
    try {
      const r = await fetch(`${this.baseUrl()}/models`, { headers: this.headers() });
      if (r.ok) return { ok: true };
      if (r.status === 401 || r.status === 403) return { ok: false, error: `Auth failed (${r.status})`, hint: 'Check the OpenAI API key.' };
      return { ok: false, error: `HTTP ${r.status}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async generate(req: MediaGenerationRequest, ctx: MediaAdapterContext): Promise<MediaJobResult> {
    if (!this.apiKey) throw new Error('OpenAI API key not set');
    const model = req.model || this.cfg.defaultAudioModel || 'gpt-4o-mini-tts';
    const voice = req.voice || 'alloy';
    const format = (req.format || 'mp3').toLowerCase();
    const resp = await fetch(`${this.baseUrl()}/audio/speech`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ model, input: req.prompt, voice, response_format: format })
    });
    if (!resp.ok) throw new Error(`OpenAI speech error: ${resp.status} ${(await resp.text()).slice(0, 400)}`);
    const buf = Buffer.from(new Uint8Array(await resp.arrayBuffer()));
    const mime = resp.headers.get('content-type') || guessMimeFromExt(format);
    const ext = audioExtFromMime(mime) || format;
    const filename = makeFilename('audio', ext);
    const abs = join(ctx.outputDir, ctx.filename || filename);
    const relative = ctx.filename || filename;
    const bytes = await writeBuffer(abs, buf);
    return { absolutePath: abs, relativePath: relative, mimeType: mime, bytes };
  }
}

// ───────────────────────────────────────────────────────────────────────────
// ElevenLabs text-to-speech
// ───────────────────────────────────────────────────────────────────────────

const ELEVENLABS_DEFAULT_BASE = 'https://api.elevenlabs.io';
// A stable, publicly documented default voice ("Rachel") so speech works
// before the user picks a voice id from their own library.
const ELEVENLABS_DEFAULT_VOICE = '21m00Tcm4TlvDq8ikWAM';

export class ElevenLabsAdapter implements MediaAdapter {
  readonly id = 'elevenlabs';
  readonly kind = 'audio' as const;

  constructor(private readonly cfg: MediaProviderConfig, private readonly apiKey: string) {}

  private baseUrl(): string { return (this.cfg.baseUrl || ELEVENLABS_DEFAULT_BASE).replace(/\/$/, ''); }
  private headers(extra?: Record<string, string>): Record<string, string> {
    return { 'xi-api-key': this.apiKey, ...(this.cfg.customHeaders || {}), ...(extra || {}) };
  }

  async test(): Promise<{ ok: boolean; error?: string; hint?: string }> {
    if (!this.apiKey) return { ok: false, error: 'API key required' };
    try {
      const r = await fetch(`${this.baseUrl()}/v1/user`, { headers: this.headers() });
      if (r.ok) return { ok: true };
      if (r.status === 401 || r.status === 403) return { ok: false, error: `Auth failed (${r.status})`, hint: 'Check the ElevenLabs API key.' };
      return { ok: false, error: `HTTP ${r.status}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async generate(req: MediaGenerationRequest, ctx: MediaAdapterContext): Promise<MediaJobResult> {
    if (!this.apiKey) throw new Error('ElevenLabs API key not set');
    const model = req.model || this.cfg.defaultAudioModel || 'eleven_multilingual_v2';
    const voiceId = req.voice || ELEVENLABS_DEFAULT_VOICE;
    const resp = await fetch(`${this.baseUrl()}/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json', Accept: 'audio/mpeg' }),
      body: JSON.stringify({ text: req.prompt, model_id: model })
    });
    if (!resp.ok) throw new Error(`ElevenLabs error: ${resp.status} ${(await resp.text()).slice(0, 400)}`);
    const buf = Buffer.from(new Uint8Array(await resp.arrayBuffer()));
    const mime = resp.headers.get('content-type') || 'audio/mpeg';
    const ext = audioExtFromMime(mime);
    const filename = makeFilename('audio', ext);
    const abs = join(ctx.outputDir, ctx.filename || filename);
    const relative = ctx.filename || filename;
    const bytes = await writeBuffer(abs, buf);
    return { absolutePath: abs, relativePath: relative, mimeType: mime, bytes };
  }
}

// ───────────────────────────────────────────────────────────────────────────
// MiniMax native media (image / speech / music / video)
//
// MiniMax exposes media generation on its own REST endpoints (not the
// OpenAI shape), reusing the same API key as the chat provider:
//   image  → POST /image_generation                → data.image_urls[]
//   speech → POST /t2a_v2                           → data.audio (hex)
//   music  → POST /music_generation                → data.audio (hex)
//   video  → POST /video_generation (async) → GET /query/video_generation
//            → GET /files/retrieve → file.download_url
// ───────────────────────────────────────────────────────────────────────────

const MINIMAX_DEFAULT_BASE = 'https://api.minimax.io/v1';
const MINIMAX_DEFAULT_VOICE = 'English_Graceful_Lady';
// OpenAI voice names would be rejected by MiniMax — fall back to a valid voice.
const OPENAI_VOICE_NAMES = new Set(['alloy', 'ash', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer']);

interface MinimaxBaseResp { base_resp?: { status_code?: number; status_msg?: string } }

function assertMinimaxOk(json: MinimaxBaseResp | null): void {
  const code = json?.base_resp?.status_code;
  if (code !== undefined && code !== 0) {
    throw new Error(`MiniMax error ${code}: ${json?.base_resp?.status_msg || 'unknown'}`);
  }
}

export class MinimaxMediaAdapter implements MediaAdapter {
  readonly id = 'minimax-media';
  readonly kind: MediaKind;

  constructor(private readonly cfg: MediaProviderConfig, private readonly apiKey: string, kind: MediaKind) {
    this.kind = kind;
  }

  private base(): string { return (this.cfg.baseUrl || MINIMAX_DEFAULT_BASE).replace(/\/$/, ''); }
  private headers(): Record<string, string> {
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}`, ...(this.cfg.customHeaders || {}) };
  }

  async test(): Promise<{ ok: boolean; error?: string; hint?: string }> {
    if (!this.apiKey) return { ok: false, error: 'MiniMax API key required' };
    return { ok: true, hint: 'MiniMax media generation reuses your MiniMax API key.' };
  }

  async generate(req: MediaGenerationRequest, ctx: MediaAdapterContext): Promise<MediaJobResult> {
    if (!this.apiKey) throw new Error('MiniMax API key not set');
    if (this.kind === 'image') return this.image(req, ctx);
    if (this.kind === 'video') return this.video(req, ctx);
    if (/music/i.test(req.model || '')) return this.music(req, ctx);
    return this.speech(req, ctx);
  }

  private async writeOut(buf: Buffer, kind: MediaKind, ext: string, ctx: MediaAdapterContext): Promise<{ abs: string; relative: string }> {
    const filename = makeFilename(kind, ext);
    const abs = join(ctx.outputDir, ctx.filename || filename);
    const relative = ctx.filename || filename;
    await writeBuffer(abs, buf);
    return { abs, relative };
  }

  private async image(req: MediaGenerationRequest, ctx: MediaAdapterContext): Promise<MediaJobResult> {
    const { width, height } = resolveAspectOrDefault(req);
    const body = {
      model: req.model || 'image-01',
      prompt: req.prompt,
      aspect_ratio: aspectFromSize(width, height),
      response_format: 'url',
      n: 1,
      prompt_optimizer: true
    };
    const resp = await fetch(`${this.base()}/image_generation`, { method: 'POST', headers: this.headers(), body: JSON.stringify(body) });
    if (!resp.ok) throw new Error(`MiniMax image error: ${resp.status} ${(await resp.text()).slice(0, 400)}`);
    const json = readJsonSafe(await resp.text()) as (MinimaxBaseResp & { data?: { image_urls?: string[] } }) | null;
    assertMinimaxOk(json);
    const url = json?.data?.image_urls?.[0];
    if (!url) throw new Error('MiniMax returned no image');
    const dl = await fetch(url);
    if (!dl.ok) throw new Error(`MiniMax image download failed: ${dl.status}`);
    const buf = Buffer.from(new Uint8Array(await dl.arrayBuffer()));
    const mime = dl.headers.get('content-type') || 'image/png';
    const { abs, relative } = await this.writeOut(buf, 'image', mimeToExt(mime), ctx);
    return { absolutePath: abs, relativePath: relative, mimeType: mime, bytes: buf.length, width, height, seed: req.seed };
  }

  private async speech(req: MediaGenerationRequest, ctx: MediaAdapterContext): Promise<MediaJobResult> {
    const voice = req.voice && !OPENAI_VOICE_NAMES.has(req.voice) ? req.voice : MINIMAX_DEFAULT_VOICE;
    const body = {
      model: req.model || 'speech-02-hd',
      text: req.prompt,
      stream: false,
      voice_setting: { voice_id: voice, speed: 1, vol: 1, pitch: 0 },
      audio_setting: { format: 'mp3', sample_rate: 32000, bitrate: 128000 }
    };
    const resp = await fetch(`${this.base()}/t2a_v2`, { method: 'POST', headers: this.headers(), body: JSON.stringify(body) });
    if (!resp.ok) throw new Error(`MiniMax speech error: ${resp.status} ${(await resp.text()).slice(0, 400)}`);
    const json = readJsonSafe(await resp.text()) as (MinimaxBaseResp & { data?: { audio?: string } }) | null;
    assertMinimaxOk(json);
    const hex = json?.data?.audio;
    if (!hex) throw new Error('MiniMax returned no audio');
    const buf = Buffer.from(hex, 'hex');
    const { abs, relative } = await this.writeOut(buf, 'audio', 'mp3', ctx);
    return { absolutePath: abs, relativePath: relative, mimeType: 'audio/mpeg', bytes: buf.length };
  }

  private async music(req: MediaGenerationRequest, ctx: MediaAdapterContext): Promise<MediaJobResult> {
    const lyrics = req.options?.lyrics || '';
    const body = {
      model: req.model || 'music-1.5',
      prompt: req.prompt,
      lyrics,
      audio_setting: { sample_rate: 44100, bitrate: 256000, format: 'mp3' },
      output_format: 'hex',
      is_instrumental: !lyrics
    };
    const resp = await fetch(`${this.base()}/music_generation`, { method: 'POST', headers: this.headers(), body: JSON.stringify(body) });
    if (!resp.ok) throw new Error(`MiniMax music error: ${resp.status} ${(await resp.text()).slice(0, 400)}`);
    const json = readJsonSafe(await resp.text()) as (MinimaxBaseResp & { data?: { audio?: string } }) | null;
    assertMinimaxOk(json);
    const hex = json?.data?.audio;
    if (!hex) throw new Error('MiniMax returned no music');
    const buf = Buffer.from(hex, 'hex');
    const { abs, relative } = await this.writeOut(buf, 'audio', 'mp3', ctx);
    return { absolutePath: abs, relativePath: relative, mimeType: 'audio/mpeg', bytes: buf.length };
  }

  private async video(req: MediaGenerationRequest, ctx: MediaAdapterContext): Promise<MediaJobResult> {
    const duration = req.durationSeconds && req.durationSeconds > 0 ? Math.min(10, Math.max(1, Math.round(req.durationSeconds))) : 6;
    const start = await fetch(`${this.base()}/video_generation`, {
      method: 'POST', headers: this.headers(),
      body: JSON.stringify({ model: req.model || 'MiniMax-Hailuo-02', prompt: req.prompt, duration, resolution: '768P' })
    });
    if (!start.ok) throw new Error(`MiniMax video start error: ${start.status} ${(await start.text()).slice(0, 400)}`);
    const sj = readJsonSafe(await start.text()) as (MinimaxBaseResp & { task_id?: string }) | null;
    assertMinimaxOk(sj);
    const taskId = sj?.task_id;
    if (!taskId) throw new Error('MiniMax returned no task_id');

    // Poll for completion (video generation can take several minutes).
    const deadline = Date.now() + 8 * 60_000;
    let fileId: string | undefined;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5000));
      const q = await fetch(`${this.base()}/query/video_generation?task_id=${encodeURIComponent(taskId)}`, { headers: this.headers() });
      if (!q.ok) continue;
      const qj = readJsonSafe(await q.text()) as { status?: string; file_id?: string } | null;
      const status = (qj?.status || '').toLowerCase();
      if (status === 'success') { fileId = qj?.file_id; break; }
      if (status === 'fail' || status === 'failed') throw new Error('MiniMax video generation failed');
    }
    if (!fileId) throw new Error('MiniMax video generation timed out');

    const fr = await fetch(`${this.base()}/files/retrieve?file_id=${encodeURIComponent(fileId)}`, { headers: this.headers() });
    if (!fr.ok) throw new Error(`MiniMax file retrieve error: ${fr.status}`);
    const fj = readJsonSafe(await fr.text()) as { file?: { download_url?: string } } | null;
    const durl = fj?.file?.download_url;
    if (!durl) throw new Error('MiniMax video: no download url');
    const dl = await fetch(durl);
    if (!dl.ok) throw new Error(`MiniMax video download failed: ${dl.status}`);
    const buf = Buffer.from(new Uint8Array(await dl.arrayBuffer()));
    const mime = dl.headers.get('content-type') || 'video/mp4';
    const { abs, relative } = await this.writeOut(buf, 'video', mimeToExt(mime, 'video'), ctx);
    return { absolutePath: abs, relativePath: relative, mimeType: mime, bytes: buf.length, durationSeconds: duration };
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Adapter factory
// ───────────────────────────────────────────────────────────────────────────

export function adapterFor(
  cfg: MediaProviderConfig,
  apiKey: string,
  kind: MediaKind
): MediaAdapter | null {
  switch (cfg.presetId) {
    case 'openai-images':
      return kind === 'image' ? new OpenAIImageAdapter(cfg, apiKey) : null;
    case 'stability':
      return kind === 'image' ? new StabilityAdapter(cfg, apiKey) : null;
    case 'pollinations':
      return kind === 'image' ? new PollinationsAdapter(cfg) : null;
    case 'replicate':
      return new ReplicateAdapter(cfg, apiKey, kind);
    case 'comfyui':
      return kind === 'video' ? new ComfyUIAdapter(cfg, 'video') : kind === 'image' ? new ComfyUIAdapter(cfg, 'image') : null;
    case 'a1111':
      return kind === 'image' ? new A1111Adapter(cfg) : null;
    case 'openai-compatible':
      return kind === 'image' ? new OpenAICompatibleImageAdapter(cfg, apiKey) : null;
    case 'openai-tts':
      return kind === 'audio' ? new OpenAITTSAdapter(cfg, apiKey) : null;
    case 'elevenlabs':
      return kind === 'audio' ? new ElevenLabsAdapter(cfg, apiKey) : null;
    case 'minimax-media':
      return new MinimaxMediaAdapter(cfg, apiKey, kind);
    default:
      // Fall back to OpenAI-compatible if baseUrl is set
      if (kind === 'image' && cfg.baseUrl) return new OpenAICompatibleImageAdapter(cfg, apiKey);
      return null;
  }
}
