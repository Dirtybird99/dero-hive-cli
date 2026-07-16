import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'dero-hive-providers-'));
process.env.HIVE_DATA_DIR = dataDir;

const requests: Array<{ url: string; authorization?: string }> = [];
const slowResponses: ServerResponse[] = [];
const server = createServer((req, res) => {
  requests.push({ url: req.url || '', authorization: req.headers.authorization });
  res.setHeader('content-type', 'application/json');
  if (req.url === '/fail/models') {
    res.statusCode = 500;
    res.end('{}');
    return;
  }
  if (req.url === '/empty/models') {
    res.end(JSON.stringify({ data: [] }));
    return;
  }
  if (req.url === '/slow/models') {
    slowResponses.push(res); // held open until the test releases it
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
  const { deleteSecret, getSecret, setSecret } = await import('../utils/secrets.js');
  const { CodexAcpAdapter } = await import('./codex-acp.js');
  const {
    clearAdapterCache,
    closeConversationSessions,
    getAdapter,
    getProviderApiKey,
    getProviderConfig,
    listProviders,
    shutdownAdapterCache,
    testConnection
  } = await import('./registry.js');
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

    // -----------------------------------------------------------------------
    // Save-time validation failures must reject before any row is written.
    // -----------------------------------------------------------------------
    await assert.rejects(
      saveProvider({ id: 'bad-url', presetId: 'custom', baseUrl: 'not a url' }),
      /must be a valid URL/u
    );
    await assert.rejects(
      saveProvider({ id: 'bad-proto', presetId: 'custom', baseUrl: 'ftp://example.test/v1' }),
      /must use http or https/u
    );
    assert.equal(getProviderConfig('bad-url'), null, 'rejected saves must not persist a row');
    assert.equal(getProviderConfig('bad-proto'), null, 'rejected saves must not persist a row');

    // -----------------------------------------------------------------------
    // Error propagation from discovery and refresh failures.
    // -----------------------------------------------------------------------
    assert.deepEqual(await refreshProviderModels('missing'), { ok: false, error: 'Provider not found' });
    assert.deepEqual(setProviderEnabled('missing', true), { ok: false, error: 'Provider not found' });

    const noUrl = await saveProvider({ id: 'no-url', presetId: 'custom', name: 'No URL yet' });
    assert.deepEqual(noUrl.discovery, { ok: false, error: 'Base URL is required' });
    assert.deepEqual(noUrl.provider.models.map((model) => model.id), ['default']);
    assert.deepEqual(await refreshProviderModels('no-url'), { ok: false, error: 'Base URL is required' });

    const emptyList = await saveProvider({
      id: 'empty', presetId: 'openai', name: 'Empty list', baseUrl: `${baseUrl}/empty`, defaultModel: 'seed-model'
    });
    assert.deepEqual(emptyList.discovery, { ok: false, error: 'Could not retrieve model list from provider' });
    assert.deepEqual(emptyList.provider.models.map((model) => model.id), ['seed-model'],
      'failed discovery must keep the seeded fallback models');
    assert.ok(!emptyList.provider.modelsFetchedAt, 'failed discovery must not stamp a fetch timestamp');

    // -----------------------------------------------------------------------
    // Malformed provider rows degrade to safe defaults instead of throwing.
    // -----------------------------------------------------------------------
    getDb().prepare('UPDATE providers SET models = ?, custom_headers = ? WHERE id = ?')
      .run('{definitely not json', null, 'empty');
    const corrupt = getProviderConfig('empty');
    assert.deepEqual(corrupt?.models, []);
    assert.deepEqual(corrupt?.customHeaders, {});
    assert.ok(listProviders().some((provider) => provider.id === 'empty'), 'listProviders must survive malformed rows');
    assert.equal(setProviderEnabled('empty', false).ok, true);

    // -----------------------------------------------------------------------
    // Registry lookups for unknown providers, and blank environment keys.
    // -----------------------------------------------------------------------
    assert.equal(getAdapter('never-saved'), null);
    assert.deepEqual(await testConnection('never-saved'), { ok: false, error: 'Provider not enabled' });

    setSecret('provider:ws-test', 'stored-secret');
    process.env.HIVE_PROVIDER_WS_TEST_API_KEY = '   ';
    assert.equal(getProviderApiKey('ws-test'), 'stored-secret',
      'whitespace-only environment keys must fall back to the stored secret');
    delete process.env.HIVE_PROVIDER_WS_TEST_API_KEY;
    deleteSecret('provider:ws-test');

    // -----------------------------------------------------------------------
    // Concurrency: in-flight refreshes are shared, saves wait for them, and a
    // provider removed mid-refresh stays removed.
    // -----------------------------------------------------------------------
    const waitFor = async (condition: () => boolean, label: string): Promise<void> => {
      const deadline = Date.now() + 5_000;
      while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(condition(), label);
    };
    const releaseSlow = (): void => {
      const res = slowResponses.shift();
      assert.ok(res, 'expected a held slow response');
      res.end(JSON.stringify({ data: [{ id: 'live-chat-model' }] }));
    };
    const slowRequestCount = (): number => requests.filter((request) => request.url === '/slow/models').length;

    const firstSave = saveProvider({ id: 'slow', presetId: 'openai', name: 'Slow', baseUrl: `${baseUrl}/slow` });
    const sharedRefresh = refreshProviderModels('slow');
    assert.equal(refreshProviderModels('slow'), sharedRefresh, 'concurrent refreshes must share one in-flight promise');
    await waitFor(() => slowResponses.length === 1, 'discovery request must reach the server');
    const rename = saveProvider({ id: 'slow', name: 'Renamed slow' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(getProviderConfig('slow')?.name, 'Slow', 'a save issued during a refresh must wait for it');
    assert.equal(slowRequestCount(), 1, 'shared refreshes must issue exactly one request');
    releaseSlow();
    const [firstSaved, sharedResult] = await Promise.all([firstSave, sharedRefresh]);
    assert.equal(firstSaved.discovery.ok, true);
    assert.deepEqual(sharedResult.models, ['live-chat-model']);
    await waitFor(() => slowResponses.length === 1, 'the deferred save must trigger its own refresh');
    releaseSlow();
    const renamed = await rename;
    assert.equal(renamed.provider.name, 'Renamed slow');
    assert.equal(renamed.discovery.ok, true);
    assert.equal(slowRequestCount(), 2);
    assert.equal(setProviderEnabled('slow', false).ok, true);

    const vanish = await saveProvider({ id: 'vanish', presetId: 'openai', name: 'Vanish', baseUrl });
    assert.equal(vanish.discovery.ok, true);
    getDb().prepare('UPDATE providers SET base_url = ? WHERE id = ?').run(`${baseUrl}/slow`, 'vanish');
    const doomed = refreshProviderModels('vanish');
    await waitFor(() => slowResponses.length === 1, 'the doomed refresh must reach the server');
    assert.equal(removeProvider('vanish').ok, true);
    releaseSlow();
    assert.deepEqual(await doomed, { ok: false, error: 'Provider not found' },
      'a provider removed mid-refresh must not be resurrected');
    assert.equal(getProviderConfig('vanish'), null);

    // -----------------------------------------------------------------------
    // Codex-specific refresh failures and the stale sweep's exclusions.
    // -----------------------------------------------------------------------
    const originalCodexProbe = CodexAcpAdapter.prototype.testConnection;
    let codexBehavior: 'fail' | 'empty' | 'throw' = 'fail';
    let codexProbeCalls = 0;
    CodexAcpAdapter.prototype.testConnection = async function () {
      codexProbeCalls += 1;
      if (codexBehavior === 'throw') throw new Error('codex crashed');
      if (codexBehavior === 'empty') return { ok: true, models: [] };
      return { ok: false, error: 'codex exploded' };
    };
    try {
      const codexOff = await saveProvider({ id: 'codex-off', presetId: 'codex', name: 'Codex off', enabled: false });
      assert.deepEqual(codexOff.discovery, { ok: false, error: 'Codex provider not enabled' });
      assert.equal(codexProbeCalls, 0, 'a disabled Codex provider must never be probed');
      assert.equal(removeProvider('codex-off').ok, true);

      const codexErr = await saveProvider({ id: 'codex-err', presetId: 'codex', name: 'Codex err', enabled: true });
      assert.deepEqual(codexErr.discovery, { ok: false, error: 'codex exploded' });
      assert.ok(!getProviderConfig('codex-err')?.modelsFetchedAt, 'failed Codex discovery must not stamp a fetch timestamp');
      assert.deepEqual(await testConnection('codex-err'), { ok: false, error: 'codex exploded' });

      codexBehavior = 'empty';
      assert.deepEqual(await refreshProviderModels('codex-err'), { ok: false, error: 'No models found' });

      codexBehavior = 'throw';
      assert.deepEqual(await refreshProviderModels('codex-err'), { ok: false, error: 'codex crashed' });
      assert.deepEqual(await testConnection('codex-err'), { ok: false, error: 'codex crashed' });

      // The stale sweep must skip codex (even stale), fresh, disabled, and
      // URL-less providers — with no network traffic at all.
      getDb().prepare('UPDATE providers SET models_fetched_at = ? WHERE id = ?')
        .run(Date.now() - 3 * 60 * 60 * 1000, 'codex-err');
      const probesBeforeSweep = codexProbeCalls;
      const requestsBeforeSweep = requests.length;
      assert.deepEqual(await refreshStaleProviders(), []);
      assert.equal(codexProbeCalls, probesBeforeSweep, 'the stale sweep must never probe Codex');
      assert.equal(requests.length, requestsBeforeSweep, 'the stale sweep must not issue network requests');
    } finally {
      CodexAcpAdapter.prototype.testConnection = originalCodexProbe;
      removeProvider('codex-err');
    }

    // -----------------------------------------------------------------------
    // Adapter cache lifecycle: clear and shutdown drop every cached adapter.
    // -----------------------------------------------------------------------
    const cachedAdapter = getAdapter('local');
    assert.ok(cachedAdapter);
    clearAdapterCache();
    const rebuiltAdapter = getAdapter('local');
    assert.ok(rebuiltAdapter);
    assert.notEqual(rebuiltAdapter, cachedAdapter, 'clearAdapterCache must evict cached adapters');
    await shutdownAdapterCache();
    assert.notEqual(getAdapter('local'), rebuiltAdapter, 'shutdownAdapterCache must drop every cached adapter');
    await closeConversationSessions('conversation-without-sessions'); // adapters without sessions must tolerate this

    assert.equal(removeProvider('no-url').ok, true);
    assert.equal(removeProvider('empty').ok, true);
    assert.equal(removeProvider('slow').ok, true);

    assert.equal(removeProvider('local').ok, true);
    assert.equal(getProviderConfig('local'), null);
    assert.equal(removeProvider('fallback').ok, true);
    assert.equal(removeProvider('missing').ok, false);
  } finally {
    closeDb();
  }
  console.log('provider service tests passed');
} finally {
  for (const res of slowResponses) res.destroy();
  server.close();
  rmSync(dataDir, { recursive: true, force: true });
}
