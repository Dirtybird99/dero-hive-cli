import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { ProviderConfig } from '../../shared/types.js';
import { APP_VERSION } from '../../shared/version.js';
import { AnthropicAdapter } from './anthropic.js';
import { OpenAICompatibleAdapter } from './openai-compatible.js';
import { getProviderApiKey } from './registry.js';

const requests: Array<{ url: string; authorization?: string; apiKey?: string; userAgent?: string }> = [];
const server = createServer((req, res) => {
  requests.push({
    url: req.url || '',
    authorization: req.headers.authorization,
    apiKey: req.headers['x-api-key'] as string | undefined,
    userAgent: req.headers['user-agent']
  });
  res.setHeader('content-type', 'application/json');
  if (req.url === '/anthropic/models') res.end(JSON.stringify({ data: [{ id: 'claude-test' }] }));
  else if (req.url === '/leak/chat/completions') {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: { message: 'API key provided: leak-secret' } }));
  }
  else res.end(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }));
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
try {
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const config = (id: string, baseUrl: string, presetId: string): ProviderConfig => ({
    id,
    name: id,
    baseUrl,
    presetId,
    enabled: true,
    models: [{ id: 'test-model', name: 'Test model' }]
  });

  const openai = await new OpenAICompatibleAdapter(config('openai-test', `${base}/openai`, 'openai'), 'openai-secret').testConnection();
  assert.equal(openai.ok, true);
  assert.equal(requests[0]?.authorization, 'Bearer openai-secret');
  assert.equal(requests[0]?.userAgent, `DERO-Hive/${APP_VERSION}`);

  const leaking = await new OpenAICompatibleAdapter(config('leak-test', `${base}/leak`, 'openai'), 'leak-secret').testConnection();
  assert.equal(leaking.ok, false);
  assert.doesNotMatch(leaking.error || '', /leak-secret/u);

  const anthropic = await new AnthropicAdapter(config('anthropic-test', `${base}/anthropic`, 'anthropic'), 'anthropic-secret').testConnection();
  assert.deepEqual(anthropic.models, ['claude-test']);
  assert.equal(requests[2]?.apiKey, 'anthropic-secret');

  process.env.HIVE_PROVIDER_OPEN_ROUTER_API_KEY = 'environment-secret';
  assert.equal(getProviderApiKey('open-router'), 'environment-secret');
  delete process.env.HIVE_PROVIDER_OPEN_ROUTER_API_KEY;

  console.log('provider adapter tests passed');
} finally {
  server.close();
}
