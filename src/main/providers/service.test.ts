import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'dero-hive-providers-'));
process.env.HIVE_DATA_DIR = dataDir;

const requests: Array<{ url: string; authorization?: string }> = [];
const server = createServer((req, res) => {
  requests.push({ url: req.url || '', authorization: req.headers.authorization });
  res.setHeader('content-type', 'application/json');
  if (req.url === '/fail/models') {
    res.statusCode = 500;
    res.end('{}');
    return;
  }
  res.end(JSON.stringify({
    data: [{
      id: 'live-chat-model',
      display_name: 'Live chat model',
      context_length: 12_345,
      supported_parameters: ['tools', 'reasoning'],
      architecture: { input_modalities: ['text', 'image'] }
    }]
  }));
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
try {
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const { closeDb, getDb, initDb } = await import('../db/client.js');
  const { getSecret } = await import('../utils/secrets.js');
  const { CodexAcpAdapter } = await import('./codex-acp.js');
  const { getAdapter, getProviderConfig } = await import('./registry.js');
  const {
    refreshProviderModels,
    refreshStaleProviders,
    removeProvider,
    saveProvider,
    setProviderEnabled
  } = await import('./service.js');

  await initDb();
  try {
    await assert.rejects(
      saveProvider({ id: 'unsafe-url', presetId: 'custom', baseUrl: 'https://user:password@example.test/v1' }),
      /must not be embedded/u
    );
    const plaintext = 'local-plaintext-secret';
    const saved = await saveProvider({
      id: 'local',
      presetId: 'openai',
      name: 'Local test',
      baseUrl,
      apiKey: plaintext,
      enabled: true
    });
    assert.equal(saved.discovery.ok, true);
    assert.deepEqual(saved.discovery.models, ['live-chat-model']);
    assert.equal(saved.provider.apiKey, '');
    assert.equal(saved.provider.hasApiKey, true);
    assert.equal(saved.provider.models[0]?.contextWindow, 12_345);
    assert.equal(saved.provider.models[0]?.supportsVision, true);
    assert.equal(saved.provider.models[0]?.supportsTools, true);
    assert.equal(requests.at(-1)?.authorization, `Bearer ${plaintext}`);
    assert.doesNotMatch(JSON.stringify(getDb().prepare('SELECT * FROM providers').all()), new RegExp(plaintext));
    assert.doesNotMatch(readFileSync(join(dataDir, 'secrets.json'), 'utf8'), new RegExp(plaintext));

    await saveProvider({ id: 'local', name: 'Renamed local' });
    assert.equal(getSecret('provider:local'), plaintext, 'an omitted key must preserve the stored secret');

    process.env.HIVE_PROVIDER_LOCAL_API_KEY = 'environment-secret';
    await refreshProviderModels('local');
    assert.equal(requests.at(-1)?.authorization, 'Bearer environment-secret');
    delete process.env.HIVE_PROVIDER_LOCAL_API_KEY;

    await saveProvider({ id: 'local', clearApiKey: true });
    assert.equal(getSecret('provider:local'), undefined);
    assert.equal(getProviderConfig('local')?.hasApiKey, false);

    const adapter = getAdapter('local');
    assert.ok(adapter);
    assert.equal(setProviderEnabled('local', false).ok, true);
    assert.equal(getAdapter('local'), null);
    assert.equal(setProviderEnabled('local', true).provider?.enabled, true);
    assert.notEqual(getAdapter('local'), adapter);

    const fallback = await saveProvider({
      id: 'fallback',
      presetId: 'openai',
      name: 'Fallback test',
      baseUrl: `${baseUrl}/fail`,
      defaultModel: 'fallback-model'
    });
    assert.equal(fallback.discovery.ok, false);
    assert.deepEqual(fallback.provider.models.map((model) => model.id), ['fallback-model']);
    setProviderEnabled('fallback', false);

    getDb().prepare('UPDATE providers SET models_fetched_at = ? WHERE id = ?')
      .run(Date.now() - 2 * 60 * 60 * 1000, 'local');
    const beforeStaleRefresh = requests.length;
    assert.equal((await refreshStaleProviders()).length, 1);
    assert.equal(requests.length, beforeStaleRefresh + 1);

    const originalCodexTest = CodexAcpAdapter.prototype.testConnection;
    const codexInstances: Array<InstanceType<typeof CodexAcpAdapter>> = [];
    CodexAcpAdapter.prototype.testConnection = async function () {
      codexInstances.push(this);
      return {
        ok: true,
        models: ['codex-test'],
        modelDetails: {
          'codex-test': {
            supportsReasoning: true,
            thinkingOptions: [{ id: 'high', label: 'High', description: 'Deep reasoning' }]
          }
        }
      };
    };
    try {
      const codex = await saveProvider({
        id: 'codex-test', presetId: 'codex', name: 'Codex', apiKey: 'must-not-be-stored', enabled: true
      });
      assert.equal(codex.discovery.ok, true);
      assert.equal(codex.provider.models[0]?.thinkingOptions?.[0]?.id, 'high');
      assert.equal(getSecret('provider:codex-test'), undefined, 'Codex owns its credentials');
      await refreshProviderModels('codex-test');
      assert.equal(codexInstances[0], codexInstances[1], 'Codex refreshes must reuse the cached adapter');
      const codexAdapter = getAdapter('codex-test');
      setProviderEnabled('fallback', true);
      assert.equal(getAdapter('codex-test'), codexAdapter, 'unrelated provider changes must preserve Codex sessions');
      setProviderEnabled('fallback', false);
    } finally {
      CodexAcpAdapter.prototype.testConnection = originalCodexTest;
      removeProvider('codex-test');
    }

    assert.equal(removeProvider('local').ok, true);
    assert.equal(getProviderConfig('local'), null);
    assert.equal(removeProvider('fallback').ok, true);
    assert.equal(removeProvider('missing').ok, false);
  } finally {
    closeDb();
  }
  console.log('provider service tests passed');
} finally {
  server.close();
  rmSync(dataDir, { recursive: true, force: true });
}
