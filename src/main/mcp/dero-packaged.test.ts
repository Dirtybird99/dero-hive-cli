import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const dataDir = mkdtempSync(resolve(tmpdir(), 'dero-hive-mcp-'));
process.env.HIVE_DATA_DIR = dataDir;
process.env.HIVE_RESOURCES = resolve('resources');
process.env.HIVE_CLI = '1';

const methods: string[] = [];
const daemon = createServer((request, response) => {
  let body = '';
  request.setEncoding('utf8');
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => {
    const rpc = JSON.parse(body) as { id: string | number; method: string };
    methods.push(rpc.method);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: 'Pong ' }));
  });
});

await new Promise<void>((resolveListen, reject) => {
  daemon.once('error', reject);
  daemon.listen(0, '127.0.0.1', resolveListen);
});
const address = daemon.address();
assert.ok(address && typeof address !== 'string');
process.env.DERO_DAEMON_URL = `http://127.0.0.1:${address.port}`;

const { initDb, closeDb } = await import('../db/client.js');
const { McpManager } = await import('./manager.js');
const manager = new McpManager();

try {
  await initDb();
  await manager.ensureBundledServers('dero-mcp-server');

  const status = manager.getStatuses().find(({ id }) => id === 'bundled-dero-mcp-server');
  assert.equal(status?.connected, true);
  assert.equal(status.tools.length, 32);
  assert.equal(status.resources.length, 4);
  assert.equal(status.prompts.length, 5);

  await manager.callTool(status.id, 'dero_daemon_ping', {});
  assert.deepEqual(methods, ['DERO.Ping']);
} finally {
  await manager.shutdownAll();
  closeDb();
  await new Promise<void>((resolveClose, reject) => daemon.close((error) => error ? reject(error) : resolveClose()));
  rmSync(dataDir, { recursive: true, force: true });
}

process.exit(0);
