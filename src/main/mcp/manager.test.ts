import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServerConfig } from '../../shared/types.js';
import type { ToolDefinition } from '../../shared/types.js';

const dataDir = mkdtempSync(join(tmpdir(), 'dero-hive-mcp-manager-'));
process.env.HIVE_DATA_DIR = dataDir;
process.env.HIVE_KEYCHAIN_DISABLED = '1';

const { initDb, closeDb } = await import('../db/client.js');
const { McpManager, validateMcpConfig } = await import('./manager.js');
const {
  MCP_RESULT_MAX_BYTES,
  MCP_RESULT_MAX_DEPTH,
  MCP_RESULT_MAX_ITEMS,
  MCP_RESULT_MAX_STRING_BYTES,
  normalizeMcpToolResult
} = await import('./client.js');
const { ToolRegistry } = await import('../tools/registry.js');
const {
  BoundedMcpReadBuffer,
  BoundedStdioClientTransport,
  McpFrameLimitError,
  createBoundedMcpFetch
} = await import('./transport.js');

try {
  await initDb();
  assert.throws(() => validateMcpConfig({
    id: 'ambiguous:id', name: 'Ambiguous', enabled: true, command: process.execPath
  }), /server id/u, 'qualified MCP tool and secret names require an unambiguous server id');
  assert.throws(() => validateMcpConfig({
    id: 'slow', name: 'Slow', enabled: true, command: process.execPath, timeoutMs: -1
  }), /timeout/u, 'negative MCP timeouts fail closed');
  assert.throws(() => validateMcpConfig({
    id: 'slow', name: 'Slow', enabled: true, command: process.execPath, timeoutMs: 300_001
  }), /timeout/u, 'unbounded MCP timeouts fail closed');

  const manager = new McpManager();
  const config: McpServerConfig = {
    id: 'retry-probe',
    name: 'Retry probe',
    enabled: true,
    command: process.execPath,
    args: ['-e', 'process.exit(1)']
  };
  const internal = manager as unknown as {
    pendingReconnects: Map<string, NodeJS.Timeout>;
    handleDisconnect: (id: string, cfg: McpServerConfig, cause?: unknown) => void;
  };

  internal.handleDisconnect(config.id, config, new Error('probe'));
  assert.equal(internal.pendingReconnects.size, 1);
  await manager.shutdownAll();
  assert.equal(internal.pendingReconnects.size, 0, 'shutdown clears reconnects for servers with no live transport');

  internal.handleDisconnect(config.id, config, new Error('late close'));
  assert.equal(internal.pendingReconnects.size, 0, 'late close callbacks cannot reschedule after shutdown');
  await assert.rejects(manager.connect(config), /shutting down/u);

  const collisionManager = new McpManager();
  const collisionInternal = collisionManager as unknown as {
    servers: Map<string, { id: string; trust: boolean; tools: ToolDefinition[] }>;
  };
  const tool = (name: string, serverId: string): ToolDefinition => ({
    name,
    description: name,
    parameters: { type: 'object' },
    source: `mcp:${serverId}`
  });
  collisionInternal.servers.set('alpha', { id: 'alpha', trust: true, tools: [tool('shared', 'alpha'), tool('unique', 'alpha')] });
  collisionInternal.servers.set('beta', { id: 'beta', trust: false, tools: [tool('shared', 'beta')] });
  assert.deepEqual(collisionManager.getAllTools().map((item) => item.name).sort(), [
    'mcp:alpha:shared', 'mcp:beta:shared', 'unique'
  ]);
  assert.equal(collisionManager.resolveTool('shared'), null, 'ambiguous raw aliases fail closed');
  assert.equal(collisionManager.resolveTool('mcp:beta:shared')?.serverId, 'beta');
  assert.equal(collisionManager.resolveTool('unique')?.serverId, 'alpha');

  const normal = normalizeMcpToolResult([
    { type: 'text', text: 'alpha' },
    { type: 'json', value: { ok: true } }
  ]);
  assert.deepEqual(normal, {
    content: 'alpha\n{"type":"json","value":{"ok":true}}',
    truncated: false
  });

  let deep: unknown = 'bottom';
  for (let i = 0; i < MCP_RESULT_MAX_DEPTH + 2; i += 1) deep = { next: deep };
  const hostileContent = [
    { type: 'text', text: '\ud83e\uddea'.repeat(MCP_RESULT_MAX_STRING_BYTES) },
    { type: 'json', deep },
    ...Array.from({ length: MCP_RESULT_MAX_ITEMS + 10 }, (_, index) => ({ type: 'text', text: String(index) }))
  ];
  const normalized = normalizeMcpToolResult(hostileContent);
  assert.equal(normalized.truncated, true);
  assert.ok(Buffer.byteLength(normalized.content, 'utf8') <= MCP_RESULT_MAX_BYTES);
  assert.match(normalized.content, /MCP result truncated by safety limits/u);

  const fakeManager = {
    resolveTool: () => ({ serverId: 'hostile', serverName: 'Hostile', toolName: 'oversized', trusted: true }),
    callTool: async () => ({ content: hostileContent }),
    getAllTools: () => []
  } as unknown as InstanceType<typeof McpManager>;
  const result = await new ToolRegistry(fakeManager).execute('oversized', {}, {
    cwd: dataDir,
    conversationId: 'mcp-result-bounds'
  });
  assert.equal(result.isError, undefined, 'truncation preserves the MCP call/result pair as a successful result');
  assert.equal(result.meta?.truncated, true);
  assert.ok(Buffer.byteLength(result.content, 'utf8') <= MCP_RESULT_MAX_BYTES);
  assert.match(result.content, /MCP result truncated by safety limits/u);

  fakeManager.callTool = async () => { throw new Error('x'.repeat(MCP_RESULT_MAX_BYTES * 2)); };
  const errorResult = await new ToolRegistry(fakeManager).execute('oversized', {}, {
    cwd: dataDir,
    conversationId: 'mcp-error-bounds'
  });
  assert.equal(errorResult.isError, true, 'oversized MCP failures still produce a paired error result');
  assert.equal(errorResult.meta?.truncated, true);
  assert.ok(Buffer.byteLength(errorResult.content, 'utf8') <= MCP_RESULT_MAX_BYTES);
  assert.match(errorResult.content, /MCP result truncated by safety limits/u);

  const frameBuffer = new BoundedMcpReadBuffer(128);
  const wireMessage = Buffer.from('{"jsonrpc":"2.0","id":1,"result":{}}\n', 'utf8');
  frameBuffer.append(wireMessage.subarray(0, 12));
  assert.equal(frameBuffer.readMessage(), null, 'partial stdio frames remain buffered');
  frameBuffer.append(wireMessage.subarray(12));
  assert.deepEqual(frameBuffer.readMessage(), { jsonrpc: '2.0', id: 1, result: {} });
  frameBuffer.append(Buffer.alloc(129, 0x78));
  assert.throws(() => frameBuffer.readMessage(), McpFrameLimitError, 'oversized stdio frames fail before JSON parsing');

  const fragmentedFrame = new BoundedMcpReadBuffer(64 * 1024);
  const fragmentedWire = Buffer.from(JSON.stringify({
    jsonrpc: '2.0', id: 2, result: { text: 'x'.repeat(32 * 1024) }
  }) + '\n');
  const originalConcat = Buffer.concat;
  let concatCalls = 0;
  Buffer.concat = (...args: Parameters<typeof Buffer.concat>) => {
    concatCalls += 1;
    return originalConcat(...args);
  };
  try {
    for (const byte of fragmentedWire) fragmentedFrame.append(Buffer.of(byte));
  } finally {
    Buffer.concat = originalConcat;
  }
  assert.equal(concatCalls, 0, 'one-byte stdio chunks must not recopy the accumulated frame');
  assert.deepEqual(fragmentedFrame.readMessage(), {
    jsonrpc: '2.0', id: 2, result: { text: 'x'.repeat(32 * 1024) }
  });

  const sdkCompatibleTransport = new BoundedStdioClientTransport({ command: process.execPath });
  assert.ok(sdkCompatibleTransport, 'the pinned SDK exposes the read-buffer slot used by the bounded transport');
  await sdkCompatibleTransport.close();

  const boundedJsonFetch = createBoundedMcpFetch(
    async () => new Response('x'.repeat(129), { headers: { 'content-type': 'application/json' } }),
    128
  );
  await assert.rejects((await boundedJsonFetch('https://example.test')).text(), McpFrameLimitError);

  const boundedSseFetch = createBoundedMcpFetch(
    async () => new Response(`data: ${'x'.repeat(129)}\n\n`, { headers: { 'content-type': 'text/event-stream' } }),
    128
  );
  await assert.rejects((await boundedSseFetch('https://example.test')).text(), McpFrameLimitError);

  const multiEventFetch = createBoundedMcpFetch(
    async () => new Response(`${'data: ok\n\n'.repeat(40)}`, { headers: { 'content-type': 'text/event-stream' } }),
    32
  );
  assert.equal((await (await multiEventFetch('https://example.test')).text()).split('data: ok').length - 1, 40,
    'the SSE cap applies per event rather than terminating healthy long-lived streams');
} finally {
  closeDb();
  delete process.env.HIVE_KEYCHAIN_DISABLED;
  rmSync(dataDir, { recursive: true, force: true });
}

console.log('MCP manager lifecycle tests passed');
