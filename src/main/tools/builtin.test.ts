import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILTIN_TOOLS, builtinExecutors } from './builtin.js';
import { setMediaManager } from '../media/instance.js';
import { setSimulatorManager } from '../simulator/instance.js';

const root = mkdtempSync(join(tmpdir(), 'dero-hive-tools-'));
const ctx = { cwd: root, conversationId: 'tool-test' };
const originalFetch = globalThis.fetch;

assert.equal(BUILTIN_TOOLS.length, 21);
assert.equal(new Set(BUILTIN_TOOLS.map(({ name }) => name)).size, BUILTIN_TOOLS.length);
assert.deepEqual(Object.keys(builtinExecutors).sort(), BUILTIN_TOOLS.map(({ name }) => name).sort());

try {
  let result = await builtinExecutors.write_file({ path: 'src/example.txt', content: 'alpha\nbeta\n' }, ctx);
  assert.equal(result.isError, undefined);
  assert.equal(readFileSync(join(root, 'src', 'example.txt'), 'utf8'), 'alpha\nbeta\n');

  result = await builtinExecutors.read_file({ path: 'src/example.txt', start_line: 2, end_line: 2 }, ctx);
  assert.equal(result.content, 'beta');
  assert.equal((await builtinExecutors.read_file({ path: 'src/example.txt', encoding: 'base64' }, ctx)).content, Buffer.from('alpha\nbeta\n').toString('base64'));

  result = await builtinExecutors.edit_file({ path: 'src/example.txt', old_text: 'beta', new_text: 'gamma' }, ctx);
  assert.equal(result.isError, undefined);
  assert.match(readFileSync(join(root, 'src', 'example.txt'), 'utf8'), /gamma/u);
  assert.equal((await builtinExecutors.edit_file({ path: 'src/example.txt', old_text: 'missing', new_text: 'x' }, ctx)).isError, true);

  assert.match((await builtinExecutors.list_directory({ path: 'src' }, ctx)).content, /example\.txt/u);
  assert.match((await builtinExecutors.glob_files({ pattern: '**/*.txt' }, ctx)).content, /src[\\/]example\.txt/u);
  assert.match((await builtinExecutors.grep_files({ pattern: 'gamma', include: '**/*.txt' }, ctx)).content, /example\.txt:2:gamma/u);
  await assert.rejects(() => builtinExecutors.read_file({ path: '../outside.txt' }, ctx), /outside allowed workspace/u);

  result = await builtinExecutors.run_shell({ command: 'node -e "process.stdout.write(\'shell-ok\')"' }, ctx);
  assert.equal(result.content, 'shell-ok');
  assert.match((await builtinExecutors.todo_write({ todos: [{ content: 'ship', status: 'completed' }] }, ctx)).content, /\[x\] ship/u);

  const contract = 'Function Initialize() Uint64\n10 STORE("owner", SIGNER())\n20 RETURN 0\nEnd Function';
  assert.match((await builtinExecutors.lint_dvm_basic({ source: contract }, ctx)).content, /function/u);
  assert.match((await builtinExecutors.generate_dvm_contract({ name: 'Vault', brief: 'Owner guarded vault' }, ctx)).content, /Vault/u);
  assert.match((await builtinExecutors.audit_dvm_contract({ source: contract, contractName: 'Vault' }, ctx)).content, /Security Audit/u);
  assert.match((await builtinExecutors.discover_contracts({ query: 'vault', kind: 'by-function' }, ctx)).content, /vault/u);

  result = await builtinExecutors.generate_tela_dapp({ name: 'ToolTest', description: 'test dApp' }, ctx);
  assert.equal(result.isError, undefined);
  assert.match(readFileSync(join(root, 'tela', 'ToolTest', 'tela.config.json'), 'utf8'), /ToolTest/u);

  globalThis.fetch = async () => new Response(JSON.stringify({ result: {
    network: 'simulator', height: 12, topoheight: 11, tx_pool_size: 0, status: 'OK', version: 'test'
  } }), { status: 200, headers: { 'content-type': 'application/json' } });
  assert.match((await builtinExecutors.get_simulator_chain_info({}, ctx)).content, /simulator/u);

  setSimulatorManager({
    async createFixtureWallet() { return { address: 'dero1test', scid: '0'.repeat(64) }; },
    async getBalance() { return { balance: 42 }; },
    async getContractState() { return { owner: 'dero1test' }; },
    async getHeight() { return 12; }
  } as never);
  assert.match((await builtinExecutors.simulator_create_wallet({}, ctx)).content, /dero1test/u);
  assert.match((await builtinExecutors.simulator_get_balance({ address: 'dero1test' }, ctx)).content, /42/u);
  assert.match((await builtinExecutors.simulator_get_contract_state({ scid: '0'.repeat(64), keys: 'owner' }, ctx)).content, /owner/u);
  assert.match((await builtinExecutors.simulator_get_height({}, ctx)).content, /12/u);

  setMediaManager({
    autoPick(kind: string) { return { providerId: 'fake', model: `fake-${kind}` }; },
    async generate(request: { kind: string; prompt: string }) {
      return { id: `artifact-${request.kind}`, kind: request.kind, model: `fake-${request.kind}`, mimeType: `${request.kind}/test`, prompt: request.prompt };
    },
    async copyArtifactToProject(id: string) { return { ok: true, path: join(root, `${id}.bin`) }; }
  } as never);
  process.env.HIVE_CLI = '1';
  assert.match((await builtinExecutors.generate_image({ prompt: 'hive', aspect: 'landscape' }, ctx)).content, /saved/u);
  assert.match((await builtinExecutors.generate_audio({ text: 'hello', voice: 'alloy' }, ctx)).content, /saved/u);
  assert.match((await builtinExecutors.generate_video({ prompt: 'chain', duration_seconds: 5 }, ctx)).content, /saved/u);
} finally {
  globalThis.fetch = originalFetch;
  setMediaManager(null);
  setSimulatorManager(null);
  delete process.env.HIVE_CLI;
  rmSync(root, { recursive: true, force: true });
}
