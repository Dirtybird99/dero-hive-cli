import assert from 'node:assert/strict';
import { PROVIDER_PRESETS, findPreset } from './presets.js';

// --- findPreset: exact, case-sensitive id lookup ---

const openrouter = findPreset('openrouter');
assert.equal(openrouter?.name, 'OpenRouter');
assert.equal(openrouter?.baseUrl, 'https://openrouter.ai/api/v1');
assert.equal(findPreset('does-not-exist'), undefined);
assert.equal(findPreset('OpenRouter'), undefined); // matches on id, not name, case-sensitively
assert.equal(findPreset(''), undefined);

// --- catalog invariants ---

// Preset ids are unique — duplicates would make findPreset ambiguous.
const ids = PROVIDER_PRESETS.map((p) => p.id);
assert.equal(new Set(ids).size, ids.length);

// Every preset has a non-empty id and name.
for (const p of PROVIDER_PRESETS) {
  assert.ok(p.id.length > 0, 'preset with empty id');
  assert.ok(p.name.length > 0, `preset ${p.id} has empty name`);
}

// No baseUrl carries a trailing slash (gemini's notes call this out explicitly;
// it holds for the whole catalog).
for (const p of PROVIDER_PRESETS) {
  assert.ok(!p.baseUrl.endsWith('/'), `preset ${p.id} baseUrl has a trailing slash`);
}

// Exactly these presets ship a seeded model list (providers without a usable
// /models endpoint), and each seeded list contains its own default model so the
// dropdown is consistent before the live refresh completes.
const seeded = PROVIDER_PRESETS.filter((p) => p.models.length > 0);
assert.deepEqual(
  seeded.map((p) => p.id),
  ['fireworks', 'perplexity', 'zai', 'qwen', 'volcengine']
);
for (const p of seeded) {
  assert.ok(
    p.models.some((m) => m.id === p.defaultModel),
    `preset ${p.id}: default model ${p.defaultModel} missing from its seeded list`
  );
}

// The catch-all custom preset exists and leaves endpoint/model to the user.
const custom = findPreset('custom');
assert.equal(custom?.baseUrl, '');
assert.equal(custom?.defaultModel, '');

// Local presets point at localhost and require no API key.
for (const id of ['ollama', 'lmstudio', 'vllm', 'sglang', 'llamacpp', 'litellm', 'localai', 'jan']) {
  const p = findPreset(id);
  assert.ok(p, `missing local preset ${id}`);
  assert.ok(p.baseUrl.startsWith('http://localhost:'), `preset ${id} is not localhost`);
  assert.equal(p.apiKeyUrl, undefined, `local preset ${id} should not have an apiKeyUrl`);
}

console.log('presets.test.ts passed');
