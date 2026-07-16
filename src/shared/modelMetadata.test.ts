import assert from 'node:assert/strict';
import {
  KNOWN_MODELS,
  applyKnownMetadata,
  getModelMetadata,
  mediaKindsForModel
} from './modelMetadata.js';

// --- getModelMetadata: exact, normalized, and tag-stripped lookups ---

// Exact table hit returns the entry itself.
assert.equal(getModelMetadata('gpt-4o'), KNOWN_MODELS['gpt-4o']);

// Separator and case variants normalize onto the same entry (OpenCode-style ids).
assert.equal(getModelMetadata('claude-sonnet-4-5'), KNOWN_MODELS['claude-sonnet-4.5']);
assert.equal(getModelMetadata('MINIMAX-M3'), KNOWN_MODELS['MiniMax-M3']);

// Free-tier suffixes (-free / :free) are stripped before matching.
assert.equal(getModelMetadata('deepseek-v4-flash-free'), KNOWN_MODELS['deepseek-v4-flash']);
assert.equal(getModelMetadata('glm-4.6:free'), KNOWN_MODELS['glm-4.6']);

// Ollama ":tag" ids fall back to a match on the model family.
assert.equal(getModelMetadata('llama3.2:latest'), KNOWN_MODELS['llama3.2']);
assert.equal(getModelMetadata('qwen2.5-coder:7b'), KNOWN_MODELS['qwen2.5-coder']);

// Unknown ids (with or without a tag) return null, as does the empty id.
assert.equal(getModelMetadata('totally-unknown-model'), null);
assert.equal(getModelMetadata('mystery:latest'), null);
assert.equal(getModelMetadata(''), null);

// --- applyKnownMetadata: live-reported fields win, gaps are filled ---

{
  const [filled] = applyKnownMetadata([{ id: 'gpt-4o', name: 'GPT-4o', contextWindow: 999 }]);
  assert.equal(filled.contextWindow, 999); // provider-reported value kept
  assert.equal(filled.maxOutput, 16_384); // filled from the table
  assert.equal(filled.supportsVision, true);
  assert.equal(filled.supportsTools, true);
  assert.equal(filled.supportsReasoning, undefined); // absent in table stays absent
  assert.equal(filled.mediaKinds, undefined); // chat model gets no media kinds
}

// Unknown chat models pass through untouched (no mediaKinds key added).
assert.deepEqual(
  applyKnownMetadata([{ id: 'mystery-model', name: 'Mystery' }]),
  [{ id: 'mystery-model', name: 'Mystery' }]
);

// Media models get kinds auto-detected from the id even without table metadata.
assert.deepEqual(
  applyKnownMetadata([{ id: 'dall-e-3', name: 'DALL-E 3' }]),
  [{ id: 'dall-e-3', name: 'DALL-E 3', mediaKinds: ['image'] }]
);

// Provider-reported mediaKinds are never overridden by id detection, and
// table metadata still applies to such models.
{
  const [m] = applyKnownMetadata([{ id: 'gpt-4o', name: 'GPT-4o', mediaKinds: ['audio'] }]);
  assert.deepEqual(m.mediaKinds, ['audio']);
  assert.equal(m.contextWindow, 128_000);
}

// --- mediaKindsForModel: generation-kind detection from the id ---

assert.deepEqual(mediaKindsForModel('dall-e-3'), ['image']);
assert.deepEqual(mediaKindsForModel('gpt_image_1'), ['image']); // hits via the normalized copy
assert.deepEqual(mediaKindsForModel('sora-2-pro'), ['video']);
assert.deepEqual(mediaKindsForModel('tts-1-hd'), ['audio']);
assert.deepEqual(mediaKindsForModel('eleven_multilingual_v2'), ['audio']);

// Speech *input* models and plain chat models stay out of media.
assert.deepEqual(mediaKindsForModel('whisper-large-v3'), []);
assert.deepEqual(mediaKindsForModel('gpt-4o-transcribe'), []);
assert.deepEqual(mediaKindsForModel('gpt-4o'), []);
assert.deepEqual(mediaKindsForModel('grok-4.5'), []); // grok, but not grok-image

console.log('modelMetadata.test.ts passed');
