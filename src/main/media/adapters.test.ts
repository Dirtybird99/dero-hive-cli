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

console.log('media adapter tests passed');
