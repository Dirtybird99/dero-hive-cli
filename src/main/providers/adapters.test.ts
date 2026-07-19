import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentPart, Message, ProviderConfig } from '../../shared/types.js';
import { APP_VERSION } from '../../shared/version.js';
import { AnthropicAdapter } from './anthropic.js';
import type { ProviderStreamEvent, ProviderStreamRequest } from './base.js';
import { OpenAICompatibleAdapter } from './openai-compatible.js';
import { getProviderApiKey } from './registry.js';
import { parseSSE } from './streaming.js';
import {
  MAX_PROVIDER_ERROR_BYTES,
  MAX_PROVIDER_JSON_BYTES,
  MAX_PROVIDER_SSE_EVENT_BYTES,
  MAX_PROVIDER_STREAM_BYTES,
  providerRequestSignal,
  readProviderText
} from './http.js';

// Keep logger output (silent-stream warnings etc.) inside a disposable directory.
const dataDir = mkdtempSync(join(tmpdir(), 'dero-hive-adapters-'));
process.env.HIVE_DATA_DIR = dataDir;

const sseData = (payload: unknown): string =>
  `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
const sseEvent = (name: string, payload: unknown): string => `event: ${name}\n${sseData(payload)}`;

// Happy-path OpenAI stream, deliberately salted with malformed and unexpected
// chunks that a graceful parser must skip: invalid JSON, JSON null, an object
// without `choices`, an empty `choices` array, and a choice without a delta.
const openAiHappySse = [
  sseData({ choices: [{ delta: { content: 'Hel' } }] }),
  sseData({ choices: [{ delta: { content: 'lo' } }] }),
  sseData({ choices: [{ delta: { text: '!' } }] }),
  sseData({ choices: [{ delta: { reasoning_content: 'thinking...' } }] }),
  sseData({ choices: [{ delta: { reasoning: 'alt' } }] }),
  'data: not json {{{\n\n',
  'data: null\n\n',
  sseData({ unexpected: 'shape' }),
  sseData({ choices: [] }),
  sseData({ choices: [{}] }),
  sseData({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '{"ci' } }] } }] }),
  sseData({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"Oslo"}' } }] } }] }),
  sseData({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_2', function: { name: 'get_time', arguments: '{}' } }] } }] }),
  sseData({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
  sseData({ usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 } }),
  sseData('[DONE]')
].join('');

const openAiMidStreamErrorSse = [
  sseData({ choices: [{ delta: { content: 'partial' } }] }),
  sseData({ error: { message: 'rate limited', code: '429' } }),
  sseData({ choices: [{ delta: { content: 'never delivered' } }] }),
  sseData('[DONE]')
].join('');

const openAiUsageOnlySse = [
  sseData({ usage: { prompt_tokens: 7 } }),
  sseData('[DONE]')
].join('');

// Tool call accumulated but the stream closes without finish_reason or [DONE].
const openAiUnflushedToolSse = sseData({
  choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_9', function: { name: 'lookup', arguments: '{"q":1}' } }] } }]
});

// Anthropic stream salted with a malformed JSON line, a JSON null, an unknown
// event type, an unknown delta type, and a content_block_stop for a non-tool
// block — all of which must be skipped without breaking the stream.
const anthropicHappySse = [
  sseEvent('message_start', { type: 'message_start', message: { usage: { input_tokens: 21 } } }),
  sseEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
  sseEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } }),
  sseEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } }),
  sseEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'unknown_delta', text: 'zzz' } }),
  sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
  sseEvent('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'search' } }),
  sseEvent('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"query":' } }),
  sseEvent('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"cats"}' } }),
  sseEvent('content_block_stop', { type: 'content_block_stop', index: 1 }),
  'data: half-open{\n\n',
  'data: null\n\n',
  sseEvent('unexpected_event', { type: 'unexpected_event', whatever: true }),
  sseEvent('message_delta', { type: 'message_delta', usage: { output_tokens: 9 } }),
  sseEvent('message_stop', { type: 'message_stop' })
].join('');

const anthropicMidStreamErrorSse = [
  sseEvent('message_start', { type: 'message_start', message: { usage: { input_tokens: 5 } } }),
  sseEvent('error', { type: 'error', error: { message: 'Overloaded' } })
].join('');

const openAiJsonFallbackBody = {
  choices: [{
    message: {
      content: 'solid response',
      reasoning_content: 'deep thought',
      tool_calls: [
        { id: 'call_j', function: { name: 'fn', arguments: '{"a":2}' } },
        {}
      ]
    }
  }],
  usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 }
};

const requests: Array<{ url: string; authorization?: string; apiKey?: string; userAgent?: string; body: string }> = [];
const hangingResponses: ServerResponse[] = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
  req.on('end', () => {
    requests.push({
      url: req.url || '',
      authorization: req.headers.authorization,
      apiKey: req.headers['x-api-key'] as string | undefined,
      userAgent: req.headers['user-agent'],
      body
    });
    const sse = (payload: string): void => {
      res.setHeader('content-type', 'text/event-stream');
      res.end(payload);
    };
    const holdDeclaredBody = (contentType: string, bytes: number, status = 200): void => {
      res.statusCode = status;
      res.setHeader('content-type', contentType);
      res.setHeader('content-length', String(bytes));
      res.flushHeaders();
      hangingResponses.push(res);
    };
    res.setHeader('content-type', 'application/json');
    if (req.url === '/anthropic/models') res.end(JSON.stringify({ data: [{ id: 'claude-test' }] }));
    else if (req.url === '/leak/chat/completions') {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: { message: 'API key provided: leak-secret' } }));
    }
    else if (req.url === '/sse-happy/chat/completions') sse(openAiHappySse);
    else if (req.url === '/sse-error/chat/completions') sse(openAiMidStreamErrorSse);
    else if (req.url === '/sse-empty/chat/completions') sse(sseData('[DONE]'));
    else if (req.url === '/sse-usage-only/chat/completions') sse(openAiUsageOnlySse);
    else if (req.url === '/sse-unflushed/chat/completions') sse(openAiUnflushedToolSse);
    else if (req.url === '/sse-hang/chat/completions') {
      res.setHeader('content-type', 'text/event-stream');
      res.write(sseData({ choices: [{ delta: { content: 'first' } }] }));
      hangingResponses.push(res); // intentionally left open until cleanup
    }
    else if (req.url === '/sse-fail/chat/completions') {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: { message: 'Invalid api key stream-secret provided' } }));
    }
    else if (req.url === '/sse-error-oversized/chat/completions') {
      holdDeclaredBody('application/json', MAX_PROVIDER_ERROR_BYTES + 1, 500);
    }
    else if (req.url === '/sse-event-oversized/chat/completions') {
      sse(sseData({ choices: [{ delta: { content: 'x'.repeat(MAX_PROVIDER_SSE_EVENT_BYTES) } }] }));
    }
    else if (req.url === '/sse-body-oversized/chat/completions') {
      holdDeclaredBody('text/event-stream', MAX_PROVIDER_STREAM_BYTES + 1);
    }
    else if (req.url === '/json-fallback/chat/completions') res.end(JSON.stringify(openAiJsonFallbackBody));
    else if (req.url === '/json-bad/chat/completions') res.end('this is not json');
    else if (req.url === '/json-body-oversized/chat/completions') {
      holdDeclaredBody('application/json', MAX_PROVIDER_JSON_BYTES + 1);
    }
    else if (req.url === '/anthropic-happy/messages') sse(anthropicHappySse);
    else if (req.url === '/anthropic-error/messages') sse(anthropicMidStreamErrorSse);
    else if (req.url === '/anthropic-fail/messages') {
      res.statusCode = 500;
      res.end(JSON.stringify({ type: 'error', error: { message: 'server exploded with key anthro-stream-secret' } }));
    }
    else if (req.url === '/anthropic-fail/models') {
      res.statusCode = 500;
      res.end('{}');
    }
    else if (req.url === '/anthropic-model-oversized/models') {
      holdDeclaredBody('application/json', MAX_PROVIDER_JSON_BYTES + 1);
    }
    else res.end(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }));
  });
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

  // ---------------------------------------------------------------------------
  // Streaming coverage: text/reasoning/tool/usage events, malformed chunks,
  // mid-stream errors, non-2xx bodies, empty streams, and cancellation.
  // ---------------------------------------------------------------------------
  let messageSeq = 0;
  const message = (role: Message['role'], content: string | ContentPart[], extra: Partial<Message> = {}): Message =>
    ({ id: `m${++messageSeq}`, role, content, createdAt: Date.now(), ...extra });
  const collect = async (gen: AsyncGenerator<ProviderStreamEvent>): Promise<ProviderStreamEvent[]> => {
    const events: ProviderStreamEvent[] = [];
    for await (const event of gen) events.push(event);
    return events;
  };
  const streamReq = (overrides: Partial<ProviderStreamRequest> = {}): ProviderStreamRequest => ({
    conversationId: 'stream-test',
    model: 'test-model',
    messages: [message('user', 'hi')],
    ...overrides
  });
  const openAiAdapter = (path: string, presetId = 'openai'): OpenAICompatibleAdapter =>
    new OpenAICompatibleAdapter(config(path.slice(1), `${base}${path}`, presetId), 'stream-secret');
  const anthropicAdapter = (path: string): AnthropicAdapter =>
    new AnthropicAdapter(config(path.slice(1), `${base}${path}`, 'anthropic'), 'anthro-stream-secret');

  // The shared body reader must time out even after headers arrive and the
  // body stalls forever. Adapter requests use the same signal composition.
  const stalledBody = new Response(new ReadableStream<Uint8Array>({ start() { /* intentionally never close */ } }));
  const stalledAt = Date.now();
  await assert.rejects(
    readProviderText(stalledBody, MAX_PROVIDER_JSON_BYTES, providerRequestSignal(undefined, 25)),
    /abort|timeout/iu
  );
  assert.ok(Date.now() - stalledAt < 1_000, 'stalled body timeout must be prompt');
  const chunkedOversize = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Buffer.alloc(8));
      controller.enqueue(Buffer.alloc(1));
      controller.close();
    }
  }));
  await assert.rejects(
    readProviderText(chunkedOversize, 8, providerRequestSignal(undefined, 1_000)),
    /Provider response exceeds 8 byte limit/u
  );
  let hostileCancelCalled = false;
  const hostileCancel = new Response(new ReadableStream<Uint8Array>({
    pull: () => new Promise<void>(() => { /* stalled read */ }),
    cancel: () => {
      hostileCancelCalled = true;
      return new Promise<void>(() => { /* cancel also stalls forever */ });
    }
  }));
  const consumeHostileSse = async (): Promise<void> => {
    await parseSSE(hostileCancel, providerRequestSignal(undefined, 25)).next();
  };
  const hostileCancelAt = Date.now();
  await assert.rejects(consumeHostileSse(), /abort|timeout/iu);
  assert.equal(hostileCancelCalled, true);
  assert.ok(Date.now() - hostileCancelAt < 1_000, 'a non-settling cancel must not defeat the deadline');
  const tinyChunkPayload = 'x'.repeat(512 * 1024);
  const tinyChunkWire = Buffer.from(sseData({ choices: [{ delta: { content: tinyChunkPayload } }] }));
  let tinyChunkOffset = 0;
  const tinyChunkResponse = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (tinyChunkOffset >= tinyChunkWire.length) {
        controller.close();
        return;
      }
      const end = Math.min(tinyChunkWire.length, tinyChunkOffset + 8);
      controller.enqueue(tinyChunkWire.subarray(tinyChunkOffset, end));
      tinyChunkOffset = end;
    }
  }));
  const tinyChunkEvents = [];
  for await (const event of parseSSE(tinyChunkResponse, providerRequestSignal(undefined, 5_000))) {
    tinyChunkEvents.push(event);
  }
  assert.equal(tinyChunkEvents.length, 1);
  const tinyChunkData = tinyChunkEvents[0]?.data as { choices?: Array<{ delta?: { content?: string } }> };
  assert.equal(tinyChunkData.choices?.[0]?.delta?.content?.length, tinyChunkPayload.length,
    'newline-free tiny chunks must be framed without quadratic accumulation');

  // 1. OpenAI happy path: text deltas (content/text fields), reasoning deltas
  //    (reasoning_content/reasoning fields), tool-call argument assembly across
  //    chunks and across indices, usage from the final chunk, and graceful
  //    skipping of the malformed chunks salted into the stream.
  const happyEvents = await collect(openAiAdapter('/sse-happy').stream(streamReq({
    model: 'o3-mini',
    systemPrompt: 'be terse',
    temperature: 0.5,
    topP: 0.9,
    maxTokens: 256,
    reasoning: { effort: 'high' },
    tools: [{ name: 'get_weather', description: 'Weather lookup', parameters: { type: 'object' }, source: 'builtin' }],
    messages: [
      message('assistant', 'calling tools', {
        toolCalls: [
          { id: 'call_ok', type: 'function', function: { name: 'fn', arguments: '{"x":1}' } },
          { id: 'call_bad', type: 'function', function: { name: 'fn', arguments: '{"trunc' } }
        ]
      }),
      message('tool', 'ok result', { toolCallId: 'call_ok' }),
      message('tool', 'orphan result', { toolCallId: 'call_bad' }),
      message('tool', 'ghost result', { toolCallId: 'call_never' }),
      message('assistant', 'kept text', {
        toolCalls: [{ id: 'call_x', type: 'function', function: { name: 'fn', arguments: 'not json' } }]
      }),
      message('user', [
        { type: 'text', text: 'analyze' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
        { type: 'file', file: { filename: 'notes.txt', data: Buffer.from('hello file').toString('base64'), mimeType: 'text/plain' } },
        { type: 'file', file: { filename: 'blob.bin', data: 'QUJD', mimeType: 'application/octet-stream' } }
      ])
    ]
  })));
  assert.deepEqual(happyEvents, [
    { type: 'delta', content: 'Hel' },
    { type: 'delta', content: 'lo' },
    { type: 'delta', content: '!' },
    { type: 'reasoning', reasoning: 'thinking...' },
    { type: 'reasoning', reasoning: 'alt' },
    {
      type: 'tool_calls',
      toolCalls: [
        { id: 'call_1', name: 'get_weather', arguments: '{"city":"Oslo"}' },
        { id: 'call_2', name: 'get_time', arguments: '{}' }
      ]
    },
    { type: 'usage', usage: { promptTokens: 11, completionTokens: 5, totalTokens: 16 } },
    { type: 'done' }
  ]);
  const happyBody = JSON.parse(requests.at(-1)?.body || '{}') as {
    model?: string; stream?: boolean; stream_options?: unknown; reasoning_effort?: string;
    temperature?: number; top_p?: number; max_tokens?: number; tool_choice?: string;
    tools?: unknown; messages?: unknown[];
  };
  assert.equal(happyBody.model, 'o3-mini');
  assert.equal(happyBody.stream, true);
  assert.deepEqual(happyBody.stream_options, { include_usage: true });
  assert.equal(happyBody.reasoning_effort, 'high');
  assert.equal(happyBody.temperature, 0.5);
  assert.equal(happyBody.top_p, 0.9);
  assert.equal(happyBody.max_tokens, 256);
  assert.equal(happyBody.tool_choice, 'auto');
  assert.deepEqual(happyBody.tools, [
    { type: 'function', function: { name: 'get_weather', description: 'Weather lookup', parameters: { type: 'object' } } }
  ]);
  // History conversion: malformed/orphaned tool records are dropped, valid
  // pairs preserved, attachments converted (text files inlined, binary files
  // as data URIs).
  assert.deepEqual(happyBody.messages, [
    { role: 'system', content: 'be terse' },
    {
      role: 'assistant',
      content: 'calling tools',
      tool_calls: [{ id: 'call_ok', type: 'function', function: { name: 'fn', arguments: '{"x":1}' } }]
    },
    { role: 'tool', tool_call_id: 'call_ok', content: 'ok result' },
    { role: 'assistant', content: 'kept text' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'analyze' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
        { type: 'text', text: '[Attached file: notes.txt]\nhello file' },
        { type: 'file', file: { filename: 'blob.bin', file_data: 'data:application/octet-stream;base64,QUJD' } }
      ]
    }
  ]);

  // 2. Error object mid-stream: surfaces the provider message and stops the
  //    stream immediately (no trailing 'done', later chunks ignored).
  const midStreamError = await collect(openAiAdapter('/sse-error').stream(streamReq({ reasoning: { effort: 'high' } })));
  assert.deepEqual(midStreamError, [
    { type: 'delta', content: 'partial' },
    { type: 'error', error: 'rate limited' }
  ]);
  const midStreamBody = JSON.parse(requests.at(-1)?.body || '{}') as Record<string, unknown>;
  assert.equal('reasoning_effort' in midStreamBody, false, 'non-reasoning models must not receive reasoning_effort');

  // 3. Empty stream (200 OK, [DONE] only): silent-stream guard yields a real
  //    error instead of a blank assistant turn — generic and Kimi-specific.
  const emptyEvents = await collect(openAiAdapter('/sse-empty').stream(streamReq()));
  assert.equal(emptyEvents.length, 2);
  assert.equal(emptyEvents[0]?.type, 'error');
  assert.match(emptyEvents[0]?.error || '', /200 OK but streamed no content/u);
  assert.deepEqual(emptyEvents[1], { type: 'done' });
  const kimiEmpty = await collect(openAiAdapter('/sse-empty', 'kimi').stream(streamReq()));
  assert.equal(kimiEmpty[0]?.type, 'error');
  assert.match(kimiEmpty[0]?.error || '', /Kimi Code accepted the request but returned no content/u);

  // 4. Usage-only stream: usage still surfaces with missing fields defaulting
  //    to zero, and usage alone does not satisfy the silent-stream guard.
  const usageOnly = await collect(openAiAdapter('/sse-usage-only').stream(streamReq()));
  assert.equal(usageOnly.length, 3);
  assert.deepEqual(usageOnly[0], { type: 'usage', usage: { promptTokens: 7, completionTokens: 0, totalTokens: 0 } });
  assert.equal(usageOnly[1]?.type, 'error');
  assert.match(usageOnly[1]?.error || '', /streamed no content/u);
  assert.deepEqual(usageOnly[2], { type: 'done' });

  // 5. Stream closes without finish_reason or [DONE]: accumulated tool calls
  //    are flushed instead of dropped.
  const unflushed = await collect(openAiAdapter('/sse-unflushed').stream(streamReq()));
  assert.deepEqual(unflushed, [
    { type: 'tool_calls', toolCalls: [{ id: 'call_9', name: 'lookup', arguments: '{"q":1}' }] },
    { type: 'done' }
  ]);

  // 6. Non-2xx response: status line plus redacted body, never the API key.
  const httpError = await collect(openAiAdapter('/sse-fail').stream(streamReq()));
  assert.equal(httpError.length, 1);
  assert.match(httpError[0]?.error || '', /^400 Bad Request:/u);
  assert.match(httpError[0]?.error || '', /\[REDACTED\]/u);
  assert.doesNotMatch(httpError[0]?.error || '', /stream-secret/u);

  // Oversized error bodies are rejected from headers without waiting for the
  // hostile server to finish sending them.
  const oversizedHttpError = await collect(openAiAdapter('/sse-error-oversized').stream(streamReq()));
  assert.equal(oversizedHttpError.length, 1);
  assert.match(oversizedHttpError[0]?.error || '', /Provider response exceeds 65536 byte limit/u);

  // 7. Provider ignores stream:true and returns a single JSON object: content,
  //    reasoning, tool calls (missing fields defaulting to '') and usage are
  //    still delivered.
  const jsonFallback = await collect(openAiAdapter('/json-fallback').stream(streamReq()));
  assert.deepEqual(jsonFallback, [
    { type: 'delta', content: 'solid response' },
    { type: 'reasoning', reasoning: 'deep thought' },
    {
      type: 'tool_calls',
      toolCalls: [
        { id: 'call_j', name: 'fn', arguments: '{"a":2}' },
        { id: '', name: '', arguments: '' }
      ]
    },
    { type: 'usage', usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 } },
    { type: 'done' }
  ]);

  // 8. JSON content-type with an unparseable body: ends cleanly with 'done'.
  const jsonBad = await collect(openAiAdapter('/json-bad').stream(streamReq()));
  assert.deepEqual(jsonBad, [{ type: 'done' }]);

  // JSON fallbacks, whole SSE bodies, and individual SSE events each have an
  // independent ceiling. Declared oversized bodies stay open to catch code
  // that checks only after buffering the response.
  await assert.rejects(
    collect(openAiAdapter('/json-body-oversized').stream(streamReq())),
    new RegExp(`Provider response exceeds ${MAX_PROVIDER_JSON_BYTES} byte limit`, 'u')
  );
  await assert.rejects(
    collect(openAiAdapter('/sse-body-oversized').stream(streamReq())),
    new RegExp(`Provider stream exceeds ${MAX_PROVIDER_STREAM_BYTES} byte limit`, 'u')
  );
  await assert.rejects(
    collect(openAiAdapter('/sse-event-oversized').stream(streamReq())),
    new RegExp(`Provider SSE event exceeds ${MAX_PROVIDER_SSE_EVENT_BYTES} byte limit`, 'u')
  );

  // 9. Cancellation mid-stream: the generator rejects once the signal aborts.
  //    parseSSE cleanup handles the rejection of its fire-and-forget
  //    `reader.cancel()` on a stream the fetch layer has already errored, so
  //    the abort must leak NO unhandled rejections of any shape.
  const unhandledRejections: unknown[] = [];
  const captureRejection = (reason: unknown): void => { unhandledRejections.push(reason); };
  process.on('unhandledRejection', captureRejection);
  try {
    const controller = new AbortController();
    const hangGen = openAiAdapter('/sse-hang').stream(streamReq({ signal: controller.signal }));
    const firstEvent = await hangGen.next();
    assert.deepEqual(firstEvent.value, { type: 'delta', content: 'first' });
    const remainder = collect(hangGen);
    controller.abort();
    await assert.rejects(remainder, (err: unknown) => /abort|terminated/iu.test(String(err)));
    // Give any stray internal rejection time to surface while the capture is active.
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(unhandledRejections, [], 'abort must not leak unhandled rejections');
  } finally {
    process.off('unhandledRejection', captureRejection);
  }

  // 10. Anthropic happy path: message_start/message_delta usage merging,
  //     text/thinking deltas, tool input assembled from input_json_delta
  //     chunks, and graceful skipping of malformed/unknown events.
  const anthroEvents = await collect(anthropicAdapter('/anthropic-happy').stream(streamReq({
    model: 'claude-sonnet-4-5',
    systemPrompt: 'stay focused',
    temperature: 0.2,
    topP: 0.8,
    reasoning: { effort: 'high' },
    tools: [{ name: 'search', description: 'Find things', parameters: { type: 'object' }, source: 'builtin' }],
    messages: [
      message('system', 'compaction summary'),
      message('assistant', 'I will call', {
        toolCalls: [{ id: 'toolu_9', type: 'function', function: { name: 'search', arguments: '{"broken' } }]
      }),
      message('tool', 'result text', { toolCallId: 'toolu_9' }),
      message('user', [
        { type: 'text', text: 'look' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } },
        { type: 'image_url', image_url: { url: 'https://images.example.test/cat.png' } },
        { type: 'file', file: { filename: 'doc.pdf', data: 'UERG', mimeType: 'application/pdf' } },
        { type: 'file', file: { filename: 'a.json', data: Buffer.from('{"k":1}').toString('base64'), mimeType: 'application/json' } }
      ])
    ]
  })));
  assert.deepEqual(anthroEvents, [
    { type: 'delta', content: 'Hi' },
    { type: 'reasoning', reasoning: 'hmm' },
    { type: 'tool_calls', toolCalls: [{ id: 'toolu_1', name: 'search', arguments: '{"query":"cats"}' }] },
    { type: 'usage', usage: { promptTokens: 21, completionTokens: 9, totalTokens: 30 } },
    { type: 'done' }
  ]);
  assert.equal(requests.at(-1)?.apiKey, 'anthro-stream-secret');
  const anthroBody = JSON.parse(requests.at(-1)?.body || '{}') as {
    model?: string; system?: string; max_tokens?: number; temperature?: number; top_p?: number;
    thinking?: unknown; tools?: unknown; messages?: unknown[];
  };
  assert.equal(anthroBody.model, 'claude-sonnet-4-5');
  assert.equal(anthroBody.system, 'stay focused');
  assert.equal(anthroBody.temperature, 0.2);
  assert.equal(anthroBody.top_p, 0.8);
  // max_tokens must exceed the extended-thinking budget (8192 + 1024).
  assert.equal(anthroBody.max_tokens, 9216);
  assert.deepEqual(anthroBody.thinking, { type: 'enabled', budget_tokens: 8192 });
  assert.deepEqual(anthroBody.tools, [{ name: 'search', description: 'Find things', input_schema: { type: 'object' } }]);
  // Message conversion: system turns carried as marked user turns, malformed
  // historical tool arguments degrade to {}, tool results folded into user
  // tool_result blocks, attachments mapped per mime type.
  assert.deepEqual(anthroBody.messages, [
    { role: 'user', content: [{ type: 'text', text: '[system note]\ncompaction summary' }] },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'I will call' },
        { type: 'tool_use', id: 'toolu_9', name: 'search', input: {} }
      ]
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_9', content: 'result text' }] },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'look' },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } },
        { type: 'image', source: { type: 'url', url: 'https://images.example.test/cat.png' } },
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'UERG' } },
        { type: 'text', text: '[Attached file: a.json]\n{"k":1}' }
      ]
    }
  ]);

  // 11. Anthropic error event mid-stream: surfaces the message and stops
  //     without usage or 'done'.
  const anthroError = await collect(anthropicAdapter('/anthropic-error').stream(streamReq({ model: 'claude-test' })));
  assert.deepEqual(anthroError, [{ type: 'error', error: 'Overloaded' }]);

  // 12. Anthropic non-2xx response: status line plus redacted body.
  const anthroHttpError = await collect(anthropicAdapter('/anthropic-fail').stream(streamReq({ model: 'claude-test' })));
  assert.equal(anthroHttpError.length, 1);
  assert.match(anthroHttpError[0]?.error || '', /^500 Internal Server Error:/u);
  assert.match(anthroHttpError[0]?.error || '', /\[REDACTED\]/u);
  assert.doesNotMatch(anthroHttpError[0]?.error || '', /anthro-stream-secret/u);

  // 13. Audio attachments are rejected before any request leaves the process.
  const beforeAudio = requests.length;
  const audioEvents = await collect(anthropicAdapter('/anthropic-happy').stream(streamReq({
    model: 'claude-test',
    messages: [message('user', [{ type: 'input_audio', input_audio: { data: 'QUJD', format: 'wav' } }])]
  })));
  assert.equal(audioEvents.length, 1);
  assert.equal(audioEvents[0]?.type, 'error');
  assert.match(audioEvents[0]?.error || '', /audio attachments/u);
  assert.equal(requests.length, beforeAudio, 'audio rejection must not reach the network');

  // 14. Anthropic testConnection surfaces non-2xx statuses.
  const anthroDown = await anthropicAdapter('/anthropic-fail').testConnection();
  assert.deepEqual(anthroDown, { ok: false, error: 'HTTP 500 Internal Server Error' });

  const anthroOversized = await anthropicAdapter('/anthropic-model-oversized').testConnection();
  assert.equal(anthroOversized.ok, false);
  assert.match(anthroOversized.error || '', new RegExp(`Provider response exceeds ${MAX_PROVIDER_JSON_BYTES} byte limit`, 'u'));

  console.log('provider adapter tests passed');
} finally {
  for (const res of hangingResponses) res.destroy();
  server.closeAllConnections();
  server.close();
  rmSync(dataDir, { recursive: true, force: true });
}
