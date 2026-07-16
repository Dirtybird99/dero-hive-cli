import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MediaKind, MediaProviderConfig } from '../../shared/types.js';
import { adapterFor } from './adapters.js';

const bytes = Buffer.from('media');
const b64 = bytes.toString('base64');
const json = (value: unknown) => new Response(JSON.stringify(value), {
  headers: { 'content-type': 'application/json' }
});
const media = (contentType: string) => new Response(bytes, {
  headers: { 'content-type': contentType }
});

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  const path = url.pathname;

  if (init?.method === 'HEAD') return new Response(null);
  if (path.endsWith('/models') || path.endsWith('/v1/user/accounts') || path.endsWith('/v1/user') || path.endsWith('/system_stats') || path.endsWith('/sd-api/v1/options')) return json({ ok: true });
  if (path.endsWith('/images/generations')) return json({ data: [{ b64_json: b64 }] });
  if (url.hostname === 'image.pollinations.ai') return media('image/jpeg');
  if (path.includes('/stable-image/generate/')) return media('image/png');
  if (path.endsWith('/predictions')) return json({ id: 'prediction', status: 'succeeded', output: 'https://stub.invalid/download/replicate' });
  if (path === '/download/replicate') return media('image/png');
  if (path.endsWith('/history/prompt')) return json({ prompt: { outputs: { output: { images: [{ filename: 'result.png' }] } } } });
  if (path.endsWith('/prompt')) return json({ prompt_id: 'prompt' });
  if (path.endsWith('/view')) return media('image/png');
  if (path.endsWith('/sd-api/v1/txt2img')) return json({ images: [b64], info: '{"seed":7}' });
  if (path.endsWith('/audio/speech') || path.includes('/text-to-speech/')) return media('audio/mpeg');
  throw new Error(`Unexpected fetch: ${init?.method || 'GET'} ${url}`);
};

const outputDir = mkdtempSync(join(tmpdir(), 'dero-hive-media-adapters-'));
const cases: Array<{ presetId: string; kind: MediaKind; mimeType: string; model?: string }> = [
  { presetId: 'openai-images', kind: 'image', mimeType: 'image/png' },
  { presetId: 'stability', kind: 'image', mimeType: 'image/png' },
  { presetId: 'pollinations', kind: 'image', mimeType: 'image/jpeg' },
  { presetId: 'replicate', kind: 'image', mimeType: 'image/png', model: 'owner/model' },
  { presetId: 'comfyui', kind: 'image', mimeType: 'image/png' },
  { presetId: 'a1111', kind: 'image', mimeType: 'image/png' },
  { presetId: 'openai-compatible', kind: 'image', mimeType: 'image/png' },
  { presetId: 'openai-tts', kind: 'audio', mimeType: 'audio/mpeg' },
  { presetId: 'elevenlabs', kind: 'audio', mimeType: 'audio/mpeg' }
];

try {
  for (const testCase of cases) {
    const cfg: MediaProviderConfig = {
      id: testCase.presetId,
      presetId: testCase.presetId,
      name: testCase.presetId,
      baseUrl: `https://stub.invalid/${testCase.presetId}`,
      hasApiKey: true,
      enabled: true,
      updatedAt: Date.now()
    };
    const adapter = adapterFor(cfg, 'test-key', testCase.kind);
    assert.ok(adapter, `${testCase.presetId} should have a ${testCase.kind} adapter`);
    assert.equal(adapter.id, testCase.presetId);
    assert.equal((await adapter.test()).ok, true, `${testCase.presetId} test should succeed`);

    const filename = `${testCase.presetId}.${testCase.kind === 'audio' ? 'mp3' : 'png'}`;
    const result = await adapter.generate({
      prompt: 'test media',
      model: testCase.model,
      options: testCase.presetId === 'comfyui' ? { workflow: '{}' } : undefined
    }, { outputDir, filename, apiKey: 'test-key', cfg });
    assert.equal(result.mimeType, testCase.mimeType);
    assert.deepEqual(readFileSync(result.absolutePath), bytes);
  }
} finally {
  globalThis.fetch = originalFetch;
  rmSync(outputDir, { recursive: true, force: true });
}

// ───────────────────────────────────────────────────────────────────────────
// Branch coverage: adapter factory fallbacks, test() failures, provider HTTP
// error bodies (initial request and mid-poll), malformed JSON, polling flows
// (pending → succeeded, failed, canceled), base64 vs URL artifact paths, and
// artifact persistence with adapter-chosen filenames. Served by a real local
// HTTP fake so status codes and headers travel the same path production does.
// ───────────────────────────────────────────────────────────────────────────
import { createServer } from 'node:http';
import type { MediaAdapterContext } from './adapters.js';

interface StubStep { status?: number; body?: string | Buffer; contentType?: string }
const routes = new Map<string, StubStep | StubStep[]>();
const seen: Array<{ method: string; path: string; search: string; body: string }> = [];
const stubJson = (value: unknown, status = 200): StubStep => ({ status, body: JSON.stringify(value), contentType: 'application/json' });
const stubMedia = (contentType: string): StubStep => ({ body: bytes, contentType });
const setRoutes = (entries: Record<string, StubStep | StubStep[]>): void => {
  routes.clear();
  seen.length = 0;
  for (const [path, step] of Object.entries(entries)) routes.set(path, step);
};

const branchServer = createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const chunks: Buffer[] = [];
  req.on('data', (chunk) => chunks.push(chunk as Buffer));
  req.on('end', () => {
    seen.push({ method: req.method || 'GET', path: url.pathname, search: url.search, body: Buffer.concat(chunks).toString('utf-8') });
    const route = routes.get(url.pathname);
    if (!route) {
      res.statusCode = 404;
      res.end(`no stub for ${url.pathname}`);
      return;
    }
    const step = Array.isArray(route) ? (route.length > 1 ? route.shift()! : route[0]) : route;
    res.statusCode = step.status ?? 200;
    if (step.contentType) res.setHeader('content-type', step.contentType);
    res.end(step.body ?? '');
  });
});
await new Promise<void>((resolve) => branchServer.listen(0, '127.0.0.1', resolve));
const branchAddress = branchServer.address();
assert.ok(branchAddress && typeof branchAddress === 'object');
const branchBase = `http://127.0.0.1:${branchAddress.port}`;

const branchDir = mkdtempSync(join(tmpdir(), 'dero-hive-media-branches-'));
const branchCfg = (presetId: string, baseUrl = branchBase): MediaProviderConfig => ({
  id: presetId, presetId, name: presetId, baseUrl, hasApiKey: true, enabled: true, updatedAt: Date.now()
});
const mk = (presetId: string, kind: MediaKind, apiKey = 'test-key', baseUrl = branchBase): { adapter: NonNullable<ReturnType<typeof adapterFor>>; ctx: MediaAdapterContext } => {
  const c = branchCfg(presetId, baseUrl);
  const adapter = adapterFor(c, apiKey, kind);
  assert.ok(adapter, `${presetId} must provide a ${kind} adapter`);
  return { adapter, ctx: { outputDir: branchDir, apiKey, cfg: c } };
};

try {
  // ── Adapter factory: unsupported preset/kind combinations return null ─────
  const noAdapter: Array<[string, MediaKind]> = [
    ['openai-images', 'video'], ['openai-images', 'audio'],
    ['stability', 'audio'], ['pollinations', 'video'],
    ['comfyui', 'audio'], ['a1111', 'video'],
    ['openai-compatible', 'audio'], ['openai-tts', 'image'],
    ['elevenlabs', 'video'], ['unknown-preset', 'audio']
  ];
  for (const [presetId, kind] of noAdapter) {
    assert.equal(adapterFor(branchCfg(presetId), 'test-key', kind), null, `${presetId} must not offer a ${kind} adapter`);
  }
  // Unknown preset falls back to OpenAI-compatible only when a base URL is set.
  assert.equal(adapterFor(branchCfg('unknown-preset'), 'test-key', 'image')?.id, 'openai-compatible');
  assert.equal(adapterFor(branchCfg('unknown-preset', ''), 'test-key', 'image'), null);
  assert.equal(adapterFor(branchCfg('comfyui'), '', 'video')?.kind, 'video');
  assert.equal(adapterFor(branchCfg('replicate'), 'test-key', 'audio')?.kind, 'audio');
  assert.equal(adapterFor(branchCfg('minimax-media'), 'test-key', 'video')?.id, 'minimax-media');

  // ── test(): missing keys, auth failures, HTTP failures, unreachable hosts ─
  const openaiNoKey = mk('openai-images', 'image', '').adapter;
  assert.deepEqual(await openaiNoKey.test(), { ok: false, error: 'API key required' });

  const openai = mk('openai-images', 'image');
  setRoutes({ '/models': { status: 401, body: '{}' } });
  let probe = await openai.adapter.test();
  assert.equal(probe.ok, false);
  assert.equal(probe.error, 'Auth failed (401)');
  assert.match(probe.hint ?? '', /OpenAI API key/);

  setRoutes({ '/models': { status: 500 } });
  assert.deepEqual(await openai.adapter.test(), { ok: false, error: 'HTTP 500' });

  // Grab a port that is verifiably free (listen, then close) so the request
  // is refused rather than answered by something else on the machine.
  const closedServer = createServer(() => undefined);
  await new Promise<void>((resolve) => closedServer.listen(0, '127.0.0.1', resolve));
  const closedAddress = closedServer.address();
  assert.ok(closedAddress && typeof closedAddress === 'object');
  const closedPort = closedAddress.port;
  await new Promise<void>((resolve, reject) => closedServer.close((err) => err ? reject(err) : resolve()));
  const unreachable = mk('openai-images', 'image', 'test-key', `http://127.0.0.1:${closedPort}`);
  probe = await unreachable.adapter.test();
  assert.equal(probe.ok, false);
  assert.ok(probe.error, 'network failure must surface an error message');

  const stability = mk('stability', 'image');
  setRoutes({ '/v1/user/accounts': { status: 403 } });
  probe = await stability.adapter.test();
  assert.equal(probe.error, 'Auth failed (403)');
  assert.match(probe.hint ?? '', /platform\.stability\.ai/);

  assert.deepEqual(await mk('replicate', 'image', '').adapter.test(), { ok: false, error: 'Replicate API token required' });

  setRoutes({ '/system_stats': { status: 503 } });
  probe = await mk('comfyui', 'image', '').adapter.test();
  assert.equal(probe.error, 'HTTP 503');
  assert.match(probe.hint ?? '', /--api/);

  setRoutes({ '/sd-api/v1/options': { status: 500 } });
  assert.deepEqual(await mk('a1111', 'image', '').adapter.test(), { ok: false, error: 'HTTP 500', hint: 'Start A1111 with --api and ensure the URL matches.' });

  assert.deepEqual(await mk('openai-compatible', 'image', 'test-key', '').adapter.test(), { ok: false, error: 'Base URL required' });
  assert.deepEqual(await mk('openai-tts', 'audio', '').adapter.test(), { ok: false, error: 'API key required' });

  setRoutes({ '/v1/user': { status: 401 } });
  probe = await mk('elevenlabs', 'audio').adapter.test();
  assert.equal(probe.error, 'Auth failed (401)');

  assert.equal((await mk('minimax-media', 'audio', '').adapter.test()).ok, false);
  setRoutes({});
  assert.equal((await mk('minimax-media', 'audio').adapter.test()).ok, true);
  assert.equal(seen.length, 0, 'minimax test() must not touch the network');

  // ── OpenAI Images: error bodies, malformed JSON, base64 vs URL branches ───
  await assert.rejects(openaiNoKey.generate({ prompt: 'p' }, openai.ctx), /OpenAI API key not set/);

  setRoutes({ '/images/generations': { status: 429, body: 'x'.repeat(500) } });
  await assert.rejects(openai.adapter.generate({ prompt: 'p' }, openai.ctx), (err: Error) => {
    assert.equal(err.message, `OpenAI image error: 429 ${'x'.repeat(400)}`, 'body must be surfaced and truncated to 400 chars');
    return true;
  });

  setRoutes({ '/images/generations': { body: 'not json {{{', contentType: 'application/json' } });
  await assert.rejects(openai.adapter.generate({ prompt: 'p' }, openai.ctx), /OpenAI returned no image/);

  setRoutes({ '/images/generations': stubJson({ data: [{}] }) });
  await assert.rejects(openai.adapter.generate({ prompt: 'p' }, openai.ctx), /OpenAI response had neither b64_json nor url/);

  setRoutes({
    '/images/generations': stubJson({ data: [{ url: `${branchBase}/hosted-image` }] }),
    '/hosted-image': stubMedia('image/webp')
  });
  const hosted = await openai.adapter.generate({ prompt: 'p' }, openai.ctx);
  assert.equal(hosted.mimeType, 'image/webp');
  assert.match(hosted.relativePath, /^image-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}\.webp$/, 'adapter-picked filename carries kind, timestamp, and mime-derived extension');
  assert.equal(hosted.absolutePath, join(branchDir, hosted.relativePath));
  assert.equal(hosted.bytes, bytes.length);
  assert.equal(hosted.width, 1024);
  assert.equal(hosted.height, 1024);
  assert.deepEqual(readFileSync(hosted.absolutePath), bytes);

  setRoutes({
    '/images/generations': stubJson({ data: [{ url: `${branchBase}/missing-image` }] }),
    '/missing-image': { status: 404 }
  });
  await assert.rejects(openai.adapter.generate({ prompt: 'p' }, openai.ctx), /OpenAI image URL fetch failed: 404/);

  // ── Stability / Pollinations error bodies ─────────────────────────────────
  await assert.rejects(mk('stability', 'image', '').adapter.generate({ prompt: 'p' }, stability.ctx), /Stability API key not set/);
  setRoutes({ '/v2beta/stable-image/generate/core': { status: 402, body: 'payment required' } });
  await assert.rejects(stability.adapter.generate({ prompt: 'p' }, stability.ctx), /Stability error: 402 payment required/);

  const pollinations = mk('pollinations', 'image', '');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('overloaded', { status: 503 });
  try {
    await assert.rejects(pollinations.adapter.generate({ prompt: 'p' }, pollinations.ctx), /Pollinations error: 503/);
  } finally {
    globalThis.fetch = realFetch;
  }

  // ── Replicate: start errors, terminal statuses, polling, downloads ────────
  const replicate = mk('replicate', 'image', 'test-token');
  setRoutes({ '/models/owner/model/predictions': { status: 401, body: 'bad token' } });
  await assert.rejects(replicate.adapter.generate({ prompt: 'p', model: 'owner/model' }, replicate.ctx), /Replicate start failed: 401 bad token/);

  setRoutes({ '/models/owner/model/predictions': stubJson({}) });
  await assert.rejects(replicate.adapter.generate({ prompt: 'p', model: 'owner/model' }, replicate.ctx), /Replicate returned no prediction id/);

  setRoutes({ '/models/owner/model/predictions': stubJson({ id: 'p1', status: 'failed', error: 'boom' }) });
  await assert.rejects(replicate.adapter.generate({ prompt: 'p', model: 'owner/model' }, replicate.ctx), /Replicate prediction failed: boom/);

  setRoutes({ '/models/owner/model/predictions': stubJson({ id: 'p1', status: 'canceled' }) });
  await assert.rejects(replicate.adapter.generate({ prompt: 'p', model: 'owner/model' }, replicate.ctx), /Replicate prediction canceled/);

  setRoutes({ '/models/owner/model/predictions': stubJson({ id: 'p1', status: 'succeeded', output: null }) });
  await assert.rejects(replicate.adapter.generate({ prompt: 'p', model: 'owner/model' }, replicate.ctx), /Replicate returned no media/);

  setRoutes({
    '/models/owner/model/predictions': stubJson({ id: 'p1', status: 'succeeded', output: `${branchBase}/replicate-file` }),
    '/replicate-file': { status: 500 }
  });
  await assert.rejects(replicate.adapter.generate({ prompt: 'p', model: 'owner/model' }, replicate.ctx), /Replicate download failed: 500/);

  // Pending → processing → succeeded across two polls, object-array output.
  const replicateVideo = mk('replicate', 'video', 'test-token');
  setRoutes({
    '/models/owner/vid/predictions': stubJson({ id: 'p2', status: 'starting', urls: { get: `${branchBase}/predictions/p2` } }),
    '/predictions/p2': [
      stubJson({ id: 'p2', status: 'processing' }),
      stubJson({ id: 'p2', status: 'succeeded', output: [{ url: `${branchBase}/replicate-video` }] })
    ],
    '/replicate-video': stubMedia('video/mp4')
  });
  const vid = await replicateVideo.adapter.generate({ prompt: 'p', model: 'owner/vid', durationSeconds: 2 }, replicateVideo.ctx);
  assert.equal(vid.mimeType, 'video/mp4');
  // Fixed: video/mp4 maps to a .mp4 extension (kind-timestamp-id.ext pattern).
  assert.match(vid.relativePath, /^video-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}\.mp4$/);
  assert.equal(vid.durationSeconds, 2);
  assert.equal(vid.width, undefined);
  assert.equal(vid.height, undefined);
  assert.deepEqual(readFileSync(vid.absolutePath), bytes);
  assert.equal(seen.filter((r) => r.path === '/predictions/p2').length, 2, 'must poll until a terminal status arrives');

  // Other video mimes map to their own extensions, and an unknown mime falls
  // back to the kind default (video → mp4), not png.
  setRoutes({
    '/models/owner/vid/predictions': stubJson({ id: 'p2b', status: 'succeeded', output: `${branchBase}/replicate-webm` }),
    '/replicate-webm': stubMedia('video/webm')
  });
  const webm = await replicateVideo.adapter.generate({ prompt: 'p', model: 'owner/vid' }, replicateVideo.ctx);
  assert.equal(webm.mimeType, 'video/webm');
  assert.match(webm.relativePath, /^video-.*\.webm$/);

  setRoutes({
    '/models/owner/vid/predictions': stubJson({ id: 'p2c', status: 'succeeded', output: `${branchBase}/replicate-mov` }),
    '/replicate-mov': stubMedia('video/quicktime')
  });
  const mov = await replicateVideo.adapter.generate({ prompt: 'p', model: 'owner/vid' }, replicateVideo.ctx);
  assert.equal(mov.mimeType, 'video/quicktime');
  assert.match(mov.relativePath, /^video-.*\.mov$/);

  setRoutes({
    '/models/owner/vid/predictions': stubJson({ id: 'p2d', status: 'succeeded', output: `${branchBase}/replicate-unknown` }),
    '/replicate-unknown': stubMedia('application/octet-stream')
  });
  const unknownVid = await replicateVideo.adapter.generate({ prompt: 'p', model: 'owner/vid' }, replicateVideo.ctx);
  assert.match(unknownVid.relativePath, /^video-.*\.mp4$/, 'unknown video mime must fall back to mp4, not png');

  // Non-2xx mid-poll aborts the job.
  setRoutes({
    '/models/owner/model/predictions': stubJson({ id: 'p3', status: 'processing', urls: { get: `${branchBase}/predictions/p3` } }),
    '/predictions/p3': { status: 500 }
  });
  await assert.rejects(replicate.adapter.generate({ prompt: 'p', model: 'owner/model' }, replicate.ctx), /Replicate poll error: 500/);

  // Malformed JSON mid-poll rejects (current behavior: null prediction TypeError).
  setRoutes({
    '/models/owner/model/predictions': stubJson({ id: 'p4', status: 'processing', urls: { get: `${branchBase}/predictions/p4` } }),
    '/predictions/p4': { body: 'garbage {{{', contentType: 'application/json' }
  });
  await assert.rejects(replicate.adapter.generate({ prompt: 'p', model: 'owner/model' }, replicate.ctx), TypeError);

  // Audio kind: default model, duration clamped to 30s, mp3 extension.
  const replicateAudio = mk('replicate', 'audio', 'test-token');
  setRoutes({
    '/models/meta/musicgen/predictions': stubJson({ id: 'p5', status: 'succeeded', output: `${branchBase}/replicate-audio` }),
    '/replicate-audio': stubMedia('audio/mpeg')
  });
  const aud = await replicateAudio.adapter.generate({ prompt: 'p', durationSeconds: 100, seed: 4 }, replicateAudio.ctx);
  assert.equal(aud.mimeType, 'audio/mpeg');
  assert.match(aud.relativePath, /^audio-.*\.mp3$/);
  assert.equal(aud.durationSeconds, 100);
  const replicateStartBody = JSON.parse(seen.find((r) => r.path === '/models/meta/musicgen/predictions')!.body);
  assert.equal(replicateStartBody.input.duration, 30, 'requested duration must be clamped to the 30s cap');
  assert.equal(replicateStartBody.input.output_format, 'mp3');
  assert.equal(replicateStartBody.input.seed, 4);

  // ── ComfyUI: queue errors and history polling (gifs branch) ───────────────
  const comfy = mk('comfyui', 'video', '');
  setRoutes({ '/prompt': { status: 500, body: 'queue full' } });
  await assert.rejects(comfy.adapter.generate({ prompt: 'p' }, comfy.ctx), /ComfyUI queue failed: 500 queue full/);

  setRoutes({ '/prompt': stubJson({}) });
  await assert.rejects(comfy.adapter.generate({ prompt: 'p' }, comfy.ctx), /ComfyUI returned no prompt_id/);

  setRoutes({
    '/prompt': stubJson({ prompt_id: 'job1' }),
    '/history/job1': [
      stubJson({}),
      stubJson({ job1: { outputs: { '10': { gifs: [{ filename: 'anim.gif', subfolder: 'clips' }] } } } })
    ],
    '/view': stubMedia('image/gif')
  });
  const gif = await comfy.adapter.generate({ prompt: 'p', seed: 5, durationSeconds: 3 }, comfy.ctx);
  assert.equal(gif.mimeType, 'image/gif');
  assert.match(gif.relativePath, /^video-.*\.gif$/);
  assert.equal(gif.durationSeconds, 3);
  assert.equal(gif.seed, 5);
  assert.deepEqual(readFileSync(gif.absolutePath), bytes);
  const queueBody = JSON.parse(seen.find((r) => r.path === '/prompt')!.body);
  assert.equal(queueBody.prompt['3'].class_type, 'KSampler', 'default workflow must be built when none is supplied');
  assert.equal(queueBody.prompt['3'].inputs.seed, 5);
  const viewReq = seen.find((r) => r.path === '/view');
  assert.ok(viewReq);
  assert.match(viewReq.search, /filename=anim\.gif/);
  assert.match(viewReq.search, /subfolder=clips/);
  assert.equal(seen.filter((r) => r.path === '/history/job1').length, 2, 'must keep polling history until outputs appear');

  // ── A1111: HTTP error, empty result, seed reporting ───────────────────────
  const a1111 = mk('a1111', 'image', '');
  setRoutes({ '/sd-api/v1/txt2img': { status: 500 } });
  await assert.rejects(a1111.adapter.generate({ prompt: 'p' }, a1111.ctx), /A1111 error: 500/);

  setRoutes({ '/sd-api/v1/txt2img': stubJson({ images: [] }) });
  await assert.rejects(a1111.adapter.generate({ prompt: 'p' }, a1111.ctx), /A1111 returned no image/);

  setRoutes({ '/sd-api/v1/txt2img': stubJson({ images: [b64], info: 'not json' }) });
  assert.equal((await a1111.adapter.generate({ prompt: 'p', seed: 42 }, a1111.ctx)).seed, 42, 'malformed info must fall back to the requested seed');

  setRoutes({ '/sd-api/v1/txt2img': stubJson({ images: [b64], info: '{"seed":7}' }) });
  assert.equal((await a1111.adapter.generate({ prompt: 'p', seed: 42 }, a1111.ctx)).seed, 7, 'provider-reported seed must win');

  // ── OpenAI-compatible: base URL guard, error bodies, URL branch ───────────
  const compatNoBase = mk('openai-compatible', 'image', 'test-key', '');
  await assert.rejects(compatNoBase.adapter.generate({ prompt: 'p' }, compatNoBase.ctx), /Base URL required/);

  const compat = mk('openai-compatible', 'image');
  setRoutes({ '/images/generations': { status: 500, body: 'exploded' } });
  await assert.rejects(compat.adapter.generate({ prompt: 'p' }, compat.ctx), /Image API error: 500 exploded/);

  setRoutes({ '/images/generations': stubJson({ data: [] }) });
  await assert.rejects(compat.adapter.generate({ prompt: 'p' }, compat.ctx), /Image API returned no data/);

  setRoutes({ '/images/generations': stubJson({ data: [{}] }) });
  await assert.rejects(compat.adapter.generate({ prompt: 'p' }, compat.ctx), /Image API returned no usable data/);

  setRoutes({
    '/images/generations': stubJson({ data: [{ url: `${branchBase}/compat-image` }] }),
    '/compat-image': { status: 404 }
  });
  await assert.rejects(compat.adapter.generate({ prompt: 'p' }, compat.ctx), /Image URL fetch failed: 404/);

  setRoutes({
    '/images/generations': stubJson({ data: [{ url: `${branchBase}/compat-image` }] }),
    '/compat-image': stubMedia('image/jpeg')
  });
  const compatRes = await compat.adapter.generate({ prompt: 'p', width: 640, height: 480, seed: 9, negativePrompt: 'bad', steps: 4, cfgScale: 2 }, compat.ctx);
  assert.equal(compatRes.mimeType, 'image/jpeg');
  assert.match(compatRes.relativePath, /\.jpg$/);
  assert.equal(compatRes.width, 640);
  assert.equal(compatRes.height, 480);
  const compatBody = JSON.parse(seen.find((r) => r.path === '/images/generations')!.body);
  assert.equal(compatBody.size, '640x480');
  assert.equal(compatBody.negative_prompt, 'bad');
  assert.equal(compatBody.seed, 9);
  assert.equal(compatBody.steps, 4);
  assert.equal(compatBody.cfg_scale, 2);

  // ── OpenAI TTS / ElevenLabs: key guards, error bodies, format handling ────
  const ttsNoKey = mk('openai-tts', 'audio', '');
  await assert.rejects(ttsNoKey.adapter.generate({ prompt: 'p' }, ttsNoKey.ctx), /OpenAI API key not set/);

  const tts = mk('openai-tts', 'audio');
  setRoutes({ '/audio/speech': { status: 500, body: 'quota' } });
  await assert.rejects(tts.adapter.generate({ prompt: 'p' }, tts.ctx), /OpenAI speech error: 500 quota/);

  setRoutes({ '/audio/speech': stubMedia('audio/wav') });
  const wav = await tts.adapter.generate({ prompt: 'p', voice: 'nova', format: 'wav' }, tts.ctx);
  assert.equal(wav.mimeType, 'audio/wav');
  assert.match(wav.relativePath, /^audio-.*\.wav$/);
  const ttsBody = JSON.parse(seen.find((r) => r.path === '/audio/speech')!.body);
  assert.equal(ttsBody.voice, 'nova');
  assert.equal(ttsBody.response_format, 'wav');

  const elevenNoKey = mk('elevenlabs', 'audio', '');
  await assert.rejects(elevenNoKey.adapter.generate({ prompt: 'p' }, elevenNoKey.ctx), /ElevenLabs API key not set/);

  const eleven = mk('elevenlabs', 'audio');
  setRoutes({ '/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM': { status: 422, body: 'invalid voice settings' } });
  await assert.rejects(eleven.adapter.generate({ prompt: 'p' }, eleven.ctx), /ElevenLabs error: 422 invalid voice settings/);
  assert.equal(seen[0].path, '/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM', 'default voice id must land in the URL path');

  // ── MiniMax: image / speech / music / video branches ──────────────────────
  const mmNoKey = mk('minimax-media', 'image', '');
  await assert.rejects(mmNoKey.adapter.generate({ prompt: 'p' }, mmNoKey.ctx), /MiniMax API key not set/);

  const mmImage = mk('minimax-media', 'image');
  setRoutes({
    '/image_generation': stubJson({ base_resp: { status_code: 0 }, data: { image_urls: [`${branchBase}/mm-image`] } }),
    '/mm-image': stubMedia('image/jpeg')
  });
  const mmImg = await mmImage.adapter.generate({ prompt: 'p' }, mmImage.ctx);
  assert.equal(mmImg.mimeType, 'image/jpeg');
  assert.match(mmImg.relativePath, /^image-.*\.jpg$/);
  assert.deepEqual(readFileSync(mmImg.absolutePath), bytes);
  const mmImgBody = JSON.parse(seen.find((r) => r.path === '/image_generation')!.body);
  assert.equal(mmImgBody.model, 'image-01');
  assert.equal(mmImgBody.aspect_ratio, '1:1');

  setRoutes({ '/image_generation': stubJson({ base_resp: { status_code: 1002, status_msg: 'rate limited' } }) });
  await assert.rejects(mmImage.adapter.generate({ prompt: 'p' }, mmImage.ctx), /MiniMax error 1002: rate limited/);

  setRoutes({ '/image_generation': stubJson({ base_resp: { status_code: 0 }, data: { image_urls: [] } }) });
  await assert.rejects(mmImage.adapter.generate({ prompt: 'p' }, mmImage.ctx), /MiniMax returned no image/);

  setRoutes({
    '/image_generation': stubJson({ base_resp: { status_code: 0 }, data: { image_urls: [`${branchBase}/mm-image`] } }),
    '/mm-image': { status: 500 }
  });
  await assert.rejects(mmImage.adapter.generate({ prompt: 'p' }, mmImage.ctx), /MiniMax image download failed: 500/);

  const mmAudio = mk('minimax-media', 'audio');
  setRoutes({ '/t2a_v2': stubJson({ base_resp: { status_code: 0 }, data: { audio: bytes.toString('hex') } }) });
  const mmSpeech = await mmAudio.adapter.generate({ prompt: 'p', voice: 'alloy' }, mmAudio.ctx);
  assert.equal(mmSpeech.mimeType, 'audio/mpeg');
  assert.match(mmSpeech.relativePath, /^audio-.*\.mp3$/);
  assert.deepEqual(readFileSync(mmSpeech.absolutePath), bytes, 'hex-encoded audio must decode to the original payload');
  let mmSpeechBody = JSON.parse(seen.find((r) => r.path === '/t2a_v2')!.body);
  assert.equal(mmSpeechBody.voice_setting.voice_id, 'English_Graceful_Lady', 'OpenAI voice names must be replaced with a valid MiniMax voice');

  setRoutes({ '/t2a_v2': stubJson({ base_resp: { status_code: 0 }, data: { audio: bytes.toString('hex') } }) });
  await mmAudio.adapter.generate({ prompt: 'p', voice: 'my-custom-voice' }, mmAudio.ctx);
  mmSpeechBody = JSON.parse(seen.find((r) => r.path === '/t2a_v2')!.body);
  assert.equal(mmSpeechBody.voice_setting.voice_id, 'my-custom-voice');

  setRoutes({ '/t2a_v2': stubJson({ base_resp: { status_code: 0 }, data: {} }) });
  await assert.rejects(mmAudio.adapter.generate({ prompt: 'p' }, mmAudio.ctx), /MiniMax returned no audio/);

  setRoutes({ '/music_generation': stubJson({ base_resp: { status_code: 0 }, data: { audio: bytes.toString('hex') } }) });
  const mmMusic = await mmAudio.adapter.generate({ prompt: 'p', model: 'music-1.5' }, mmAudio.ctx);
  assert.match(mmMusic.relativePath, /^audio-.*\.mp3$/);
  const mmMusicBody = JSON.parse(seen.find((r) => r.path === '/music_generation')!.body);
  assert.equal(mmMusicBody.is_instrumental, true, 'no lyrics means instrumental');

  setRoutes({ '/music_generation': stubJson({ base_resp: { status_code: 0 }, data: {} }) });
  await assert.rejects(mmAudio.adapter.generate({ prompt: 'p', model: 'music-2' }, mmAudio.ctx), /MiniMax returned no music/);

  const mmVideo = mk('minimax-media', 'video');
  setRoutes({ '/video_generation': stubJson({ base_resp: { status_code: 0 } }) });
  await assert.rejects(mmVideo.adapter.generate({ prompt: 'p' }, mmVideo.ctx), /MiniMax returned no task_id/);

  // Video happy path: start → one 5s poll → file retrieve → download.
  // (The failure-status and timeout branches are not exercised here: each poll
  // costs a hardcoded 5s sleep and the timeout deadline is 8 minutes.)
  setRoutes({
    '/video_generation': stubJson({ base_resp: { status_code: 0 }, task_id: 't1' }),
    '/query/video_generation': stubJson({ status: 'Success', file_id: 'f1' }),
    '/files/retrieve': stubJson({ file: { download_url: `${branchBase}/mm-video` } }),
    '/mm-video': stubMedia('video/mp4')
  });
  const mmVid = await mmVideo.adapter.generate({ prompt: 'p', durationSeconds: 99 }, mmVideo.ctx);
  assert.equal(mmVid.mimeType, 'video/mp4');
  // Fixed: same as Replicate video — video/mp4 yields a .mp4 extension.
  assert.match(mmVid.relativePath, /^video-.*\.mp4$/);
  assert.equal(mmVid.durationSeconds, 10, 'duration must be clamped to the 10s cap');
  const mmVidStart = JSON.parse(seen.find((r) => r.path === '/video_generation')!.body);
  assert.equal(mmVidStart.duration, 10);
  assert.match(seen.find((r) => r.path === '/query/video_generation')!.search, /task_id=t1/);
} finally {
  branchServer.close();
  rmSync(branchDir, { recursive: true, force: true });
}

console.log('media adapter tests passed');
