import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const dataDir = mkdtempSync(resolve(tmpdir(), 'dero-hive-mcp-'));
process.env.HIVE_DATA_DIR = dataDir;
process.env.HIVE_RESOURCES = resolve('resources');
process.env.HIVE_CLI = '1';

// ---------------------------------------------------------------------------
// Method-aware loopback daemon fixtures. Every JSON-RPC method a covered
// daemon-backed tool issues gets a deterministic canned response; unfixtured
// methods return a JSON-RPC -32601 error so the packaged server's structured
// error classifier is exercised against a real RPC failure.
// ---------------------------------------------------------------------------

const MEMPOOL_TX_HASH = 'a1'.repeat(32);
// Topoheight + proof string from the server's flagged-artifact registry
// (the 2022 inflation claim). Responses keyed on them must carry the
// integrity context note and rebuttal citations.
const FLAGGED_TOPOHEIGHT = 1_081_893;
const FLAGGED_PROOF_STRING =
  'deroproof1qyyj0cgu3htmkumr79sgca75vwsx8kx7zkrjg0nfez46w36qyx4kwq9zvfyyskpqvdpcfhkhk4m7y9d77ehyj7yhnnrv9z0tjr9m5fqe2yx9t27dwtdxy4j4r0llll7vcmaxwjcl8jzfq';

const DVM_SOURCE = [
  'Function Initialize() Uint64',
  '10 STORE("owner", SIGNER())',
  '20 RETURN 0',
  'End Function',
  '',
  'Function Deposit(amount Uint64) Uint64',
  '10 RETURN 0',
  'End Function',
].join('\n');

// Registry-style DVM contract (EXISTS + Register/Lookup) so
// explain_smart_contract classifies it as kind "registry".
const REGISTRY_SCID = 'f'.repeat(64);
const REGISTRY_SC_CODE = [
  'Function Register(name String) Uint64',
  '10 IF EXISTS(name) THEN GOTO 30',
  '20 STORE(name, SIGNER())',
  '30 RETURN 0',
  'End Function',
  '',
  'Function Lookup(name String) Uint64',
  '10 RETURN 0',
  'End Function',
].join('\n');

const GET_INFO_FIXTURE = {
  topoheight: 5000,
  stableheight: 4992,
  height: 5000,
  // Mainnet derod reports network: "" and signals the chain via `testnet`;
  // diagnose_chain_health must resolve this to the label "mainnet".
  network: '',
  testnet: false,
  version: '3.5.3-139.DEROHE.STARGATE',
  difficulty: 100_000,
  total_supply: 1_234_567,
  tx_pool_size: 1,
};

// ---------------------------------------------------------------------------
// Extended fixture registry: flagged artifacts, canned transactions keyed by
// hash, TELA contracts keyed by SCID, and a miniature GnomonSC registry so
// the in-process dURL discovery scan resolves against the loopback daemon.
// ---------------------------------------------------------------------------

/** On-chain STRING values come back from DERO.GetSC hex-encoded. */
const hexEncode = (text: string): string => Buffer.from(text, 'utf8').toString('hex');

// Block hash + tx hash from the server's flagged-artifact registry (2022 claim).
const FLAGGED_BLOCK_HASH = 'b6bd914f7fb1c79788fe8676c277e58e7bb5a904317afb096b1d2793af9aed13';
const FLAGGED_TX_HASH = '5bbe1b7eecfe3447cb045b1197a07a214b456968eda8a3d5a90f5fae9ce57e55';

const TEST_WALLET_ADDRESS = 'dero1qyk3005a2z1zonx0cln8x2r0d8sq7wsg64nmk3sqqzwmvcx4t8ycsqqjw86y5';

const CONFIRMED_TRANSFER_TX = 'c0de'.repeat(16);
const SC_INSTALL_TX = '5c1d'.repeat(16);
const UNKNOWN_TX_HASH = 'dead'.repeat(16);
// Daemon knows this tx but returns no raw hex — forge's daemon path must fail loud.
const HEXLESS_TX_HASH = '0b0e'.repeat(16);

// DERO's Pedersen base point (compressed) — a valid bn254 curve point, reused
// as D and both ring commitments in the minimal hand-assembled forge-demo tx.
const DERO_G_COMPRESSED_HEX =
  '02eacfbf92b94015c9b0b3d901dae37ec68f74dea7e4484c76d505aade4ad7c001';

// Minimal parseable DERO NORMAL transaction (version 1, one payload, ring
// size 2). Layout mirrors transaction.go:Deserialize + Statement.Deserialize:
// uvarints for version/networks/type/height, 32-byte blid, then one payload
// (burn, scid, rpc_type, 145-byte rpc payload) and its statement (ring power,
// bytes-per-publickey, fees, D point, pointers, C[] commitments, roothash).
const FORGE_DEMO_TX_HEX = [
  '01', // version = 1
  '00', // source network
  '00', // destination network
  '03', // type = NORMAL
  '00', // height
  '00'.repeat(32), // blid
  '01', // asset (payload) count
  '00', // payload.burn_value
  '00'.repeat(32), // payload.scid
  '00', // payload.rpc_type
  '00'.repeat(145), // payload.rpc_payload (fixed 145 bytes)
  '01', // statement.ring power → ring size 2
  '21', // statement.bytes_per_publickey = 33
  '00', // statement.fees
  DERO_G_COMPRESSED_HEX, // statement.D
  '00'.repeat(66), // statement.publickey_pointers (2 × 33)
  DERO_G_COMPRESSED_HEX, // statement.C[0]
  DERO_G_COMPRESSED_HEX, // statement.C[1]
  '00'.repeat(32), // statement.roothash
].join('');

// TELA contracts + GnomonSC registry (SCID-keyed DERO.GetSC fixtures).
const TELA_INDEX_SCID = '1de1'.repeat(16);
const TELA_INDEX_OLD_SCID = '01de'.repeat(16);
const TELA_DOC_SCID = 'd0c1'.repeat(16);
const GZ_DOC_SCID = '6a2f'.repeat(16);
const PLAIN_SC_SCID = 'ab12'.repeat(16);
const BIG_SC_SCID = 'b16b'.repeat(16);
// Mainnet GnomonSC registry contract the in-process TELA discovery scans.
const GNOMON_REGISTRY_SCID = 'a05395bb0cf77adc850928b0db00eb5ca7a9ccbafd9a38d021c8d299ad5ce1a4';

const TELA_DOC_HTML = '<html><body>Hello TELA</body></html>';
const GZ_PLAINTEXT = 'console.log("hello from tela");\n';
const GZ_BASE64 = gzipSync(Buffer.from(GZ_PLAINTEXT, 'utf8')).toString('base64');

const DOC_STUB_CODE = 'Function InitializePrivate() Uint64\n10 RETURN 0\nEnd Function';
const BIG_SC_CODE = 'Function Initialize() Uint64\n10 RETURN 0\nEnd Function';

const scFixtures: Record<string, () => unknown> = {
  [GNOMON_REGISTRY_SCID]: () => ({
    status: 'OK',
    stringkeys: {
      [`${TELA_INDEX_SCID}height`]: 4200,
      [`${TELA_INDEX_OLD_SCID}height`]: 4150,
      [`${PLAIN_SC_SCID}height`]: 4100,
    },
  }),
  [TELA_INDEX_SCID]: () => ({
    code: DOC_STUB_CODE,
    status: 'OK',
    stringkeys: {
      dURL: hexEncode('test.tela'),
      DOC1: hexEncode(TELA_DOC_SCID),
      var_header_name: hexEncode('Test App'),
      var_header_description: hexEncode('A test TELA app'),
      mods: hexEncode('xswd,vars'),
      hash: hexEncode('c0ffee01'),
      '0': hexEncode('a'.repeat(64)),
    },
    uint64keys: { commit: 1 },
  }),
  [TELA_INDEX_OLD_SCID]: () => ({
    code: DOC_STUB_CODE,
    status: 'OK',
    stringkeys: {
      dURL: hexEncode('test.tela'),
      DOC1: hexEncode(TELA_DOC_SCID),
      var_header_name: hexEncode('Old Test App'),
    },
    uint64keys: {},
  }),
  [TELA_DOC_SCID]: () => ({
    code: `${DOC_STUB_CODE}\n/*${TELA_DOC_HTML}*/`,
    status: 'OK',
    stringkeys: {
      docType: hexEncode('TELA-HTML-1'),
      var_header_name: hexEncode('index.html'),
      fileCheckC: 'ab'.repeat(32),
      fileCheckS: 'cd'.repeat(32),
    },
  }),
  [GZ_DOC_SCID]: () => ({
    code: `${DOC_STUB_CODE}\n/*\n${GZ_BASE64}\n*/`,
    status: 'OK',
    stringkeys: {
      docType: hexEncode('TELA-STATIC-1'),
      var_header_name: hexEncode('app.js.gz'),
      fileCheckC: '11'.repeat(32),
      fileCheckS: '22'.repeat(32),
    },
  }),
  [BIG_SC_SCID]: () => ({
    code: BIG_SC_CODE,
    status: 'OK',
    balance: 0,
    balances: {},
    stringkeys: Object.fromEntries(
      Array.from({ length: 60 }, (_, i) => [`k${String(i).padStart(2, '0')}`, `value-${i}`]),
    ),
    uint64keys: {},
  }),
};

const txFixtures: Record<string, () => unknown> = {
  [CONFIRMED_TRANSFER_TX]: () => ({
    txs: [{
      tx_hash: CONFIRMED_TRANSFER_TX,
      block_height: 4980,
      in_pool: false,
      valid_block: 'f1'.repeat(32),
      invalid_block: [],
      ring: [['dero1qymember0', 'dero1qymember1']],
      signer: '',
      balance: 100,
      balancenow: 90,
    }],
    txs_as_hex: ['deadbeefcafe'],
    status: 'OK',
  }),
  [SC_INSTALL_TX]: () => ({
    txs: [{
      tx_hash: SC_INSTALL_TX,
      block_height: 4990,
      in_pool: false,
      valid_block: 'f2'.repeat(32),
      ring: [],
      code: DVM_SOURCE,
    }],
    txs_as_hex: ['aa'.repeat(120)],
    status: 'OK',
  }),
  [FLAGGED_TX_HASH]: () => ({
    txs: [{
      tx_hash: FLAGGED_TX_HASH,
      block_height: 1_081_870,
      in_pool: false,
      valid_block: FLAGGED_BLOCK_HASH,
      ring: [['dero1qyflagged0', 'dero1qyflagged1']],
    }],
    // Not a parseable tx binary: the audit composite's forge attempt must
    // degrade to forge_demo.skipped instead of fabricating a proof string.
    txs_as_hex: ['bb'.repeat(64)],
    status: 'OK',
  }),
  [HEXLESS_TX_HASH]: () => ({
    txs: [{
      tx_hash: HEXLESS_TX_HASH,
      block_height: 4000,
      in_pool: false,
      valid_block: 'f3'.repeat(32),
      ring: [['dero1qyx0', 'dero1qyx1']],
    }],
    txs_as_hex: [],
    status: 'OK',
  }),
};

// The daemon signals an unknown tx hash with an EMPTY record, not an error.
const EMPTY_TX_RESPONSE = {
  txs: [{ block_height: 0, in_pool: false, code: '', ring: [] }],
  txs_as_hex: [''],
  status: 'OK',
};

const daemonFixtures: Record<string, (params: unknown) => unknown> = {
  'DERO.Ping': () => 'Pong ',
  'DERO.Echo': (params) => (params as string[]).join(' '),
  'DERO.GetInfo': () => ({ ...GET_INFO_FIXTURE }),
  'DERO.GetHeight': () => ({ height: 5000, stableheight: 4992, topoheight: 5000 }),
  'DERO.GetTxPool': () => ({ tx_hashes: [MEMPOOL_TX_HASH] }),
  'DERO.GetLastBlockHeader': () => ({
    block_header: { topoheight: 5000, height: 5000, depth: 0, hash: 'c3'.repeat(32) },
    status: 'OK',
  }),
  'DERO.GetBlockHeaderByTopoHeight': (params) => ({
    block_header: {
      topoheight: (params as { topoheight: number }).topoheight,
      depth: 0,
      hash: 'e4'.repeat(32),
      reward: 123_456_789,
      txcount: 2,
    },
    status: 'OK',
  }),
  'DERO.GetBlockHeaderByHash': (params) => {
    const { hash } = params as { hash: string };
    return {
      block_header: {
        hash,
        topoheight: hash === FLAGGED_BLOCK_HASH ? FLAGGED_TOPOHEIGHT : 4321,
        depth: 2,
      },
      status: 'OK',
    };
  },
  'DERO.GetRandomAddress': () => ({
    address: ['dero1qyrandom0', 'dero1qyrandom1'],
    status: 'OK',
  }),
  'DERO.GetTransaction': (params) => {
    const { txs_hashes } = params as { txs_hashes: string[] };
    return txFixtures[txs_hashes[0]]?.() ?? { ...EMPTY_TX_RESPONSE };
  },
  'DERO.GetEncryptedBalance': () => ({
    data: 'aa'.repeat(66),
    registration: 4321,
    topoheight: 5000,
    status: 'OK',
  }),
  'DERO.NameToAddress': (params) => ({
    address: 'dero1qynamedaddr',
    name: (params as { name: string }).name,
    status: 'OK',
  }),
  'DERO.GetBlockTemplate': () => ({
    jobid: 'job-0001',
    blockhashing_blob: 'deadbeef',
    blocktemplate_blob: 'beefdead',
    difficulty: '100000',
    height: 5001,
    prev_hash: 'c3'.repeat(32),
    epochmilli: 0,
    blocks: 0,
    miniblocks: 0,
    lasterror: '',
    status: 'OK',
  }),
  'DERO.GetGasEstimate': () => ({ gascompute: 1111, gasstorage: 2222, status: 'OK' }),
  'DERO.GetSC': (params) => {
    const { scid } = params as { scid: string };
    const fixture = scFixtures[scid];
    if (fixture) return fixture();
    return {
      code: REGISTRY_SC_CODE,
      status: 'OK',
      balance: 0,
      balances: { ['0'.repeat(64)]: 12_345 },
      stringkeys: { alice: 'sig-a', bob: 'sig-b' },
      uint64keys: {},
    };
  },
};

const methods: string[] = [];
const calls: Array<{ method: string; params: unknown }> = [];
const daemon = createServer((request, response) => {
  let body = '';
  request.setEncoding('utf8');
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => {
    const rpc = JSON.parse(body) as { id: string | number; method: string; params?: unknown };
    methods.push(rpc.method);
    calls.push({ method: rpc.method, params: rpc.params });
    const fixture = daemonFixtures[rpc.method];
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(
      fixture
        ? { jsonrpc: '2.0', id: rpc.id, result: fixture(rpc.params) }
        : { jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: `Method ${rpc.method} not found` } }
    ));
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

const EXPECTED_TOOLS = [
  'dero_daemon_ping', 'dero_daemon_echo', 'dero_get_info', 'dero_get_height',
  'dero_get_block_count', 'dero_get_last_block_header', 'dero_get_block',
  'dero_get_block_header_by_topo_height', 'dero_get_block_header_by_hash',
  'dero_get_tx_pool', 'dero_get_random_address', 'dero_get_transaction',
  'dero_get_encrypted_balance', 'dero_get_sc', 'dero_get_gas_estimate',
  'dero_name_to_address', 'dero_get_block_template', 'dero_decode_proof_string',
  'dero_docs_search', 'dero_docs_get_page', 'dero_docs_list',
  'diagnose_chain_health', 'explain_smart_contract', 'tela_inspect',
  'tela_get_doc_content', 'dero_durl_to_scid', 'dero_tela_list_apps',
  'recommend_docs_path', 'estimate_deploy_cost', 'trace_transaction_with_context',
  'audit_chain_artifact_claim', 'dero_forge_demo_proof',
] as const;

const EXPECTED_RESOURCES = [
  'dero://mcp/server-info',
  'dero://mcp/safety-boundary',
  'dero://mcp/example-flows',
  'dero://mcp/composites',
] as const;

const EXPECTED_PROMPTS = [
  'network_health_check', 'inspect_smart_contract', 'trace_transaction',
  'find_dero_docs_for_intent', 'estimate_deploy_for_contract',
] as const;

const COMPOSITE_TOOLS = [
  'diagnose_chain_health', 'explain_smart_contract', 'recommend_docs_path',
  'estimate_deploy_cost', 'trace_transaction_with_context',
  'audit_chain_artifact_claim', 'dero_forge_demo_proof', 'tela_inspect',
  'tela_get_doc_content', 'dero_durl_to_scid', 'dero_tela_list_apps',
] as const;

type Json = Record<string, unknown>;
type ToolCallResult = { content: unknown; isError?: boolean };
type StructuredError = { code: string; hint: string; retryable: boolean; raw: string };

const expectText = (result: ToolCallResult): string => {
  const content = result.content as Array<{ type?: string; text?: string }>;
  assert.ok(Array.isArray(content) && content.length === 1, 'tool result carries one content item');
  assert.equal(content[0].type, 'text');
  assert.equal(typeof content[0].text, 'string');
  return content[0].text as string;
};

const expectJson = (result: ToolCallResult): Json => JSON.parse(expectText(result)) as Json;

const expectStructuredError = (result: ToolCallResult, tool: string): StructuredError => {
  assert.equal(result.isError, true, `${tool} failure is flagged at the protocol level`);
  const body = expectJson(result);
  assert.equal(body.ok, false);
  assert.equal(body.tool, tool);
  const error = (body._meta as { error: StructuredError }).error;
  assert.equal(typeof error.code, 'string');
  assert.equal(typeof error.hint, 'string');
  assert.equal(typeof error.retryable, 'boolean');
  return error;
};

const drainDaemonLog = (): Array<{ method: string; params: unknown }> => {
  const seen = calls.slice();
  methods.length = 0;
  calls.length = 0;
  return seen;
};

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

  const serverId = status.id;
  const instance = manager.getInstance(serverId);
  assert.ok(instance, 'bundled server instance is retrievable');
  const client = instance.client;

  // ---------------------------------------------------------------------
  // Advertised surface: every primitive, composite, resource, and prompt
  // is present by name, not just by count.
  // ---------------------------------------------------------------------
  assert.deepEqual(
    status.tools.map((tool) => tool.name).sort(),
    [...EXPECTED_TOOLS].sort()
  );
  assert.ok(
    status.tools.every((tool) => tool.description.startsWith('[dero-mcp-server] ')),
    'tool descriptions are prefixed with the bundled server name'
  );
  assert.deepEqual(
    status.resources.map((resource) => resource.uri).sort(),
    [...EXPECTED_RESOURCES].sort()
  );
  assert.deepEqual(
    status.prompts.map((prompt) => prompt.name).sort(),
    [...EXPECTED_PROMPTS].sort()
  );

  // ---------------------------------------------------------------------
  // Offline documentation and lookup tools — served entirely from the
  // packaged data/docs-index.json bundle; the daemon must never be hit.
  // ---------------------------------------------------------------------

  const docsList = expectJson(await manager.callTool(serverId, 'dero_docs_list', {}));
  assert.equal(docsList.docs_source, 'bundled');
  assert.equal(docsList.total, 147);
  assert.deepEqual(docsList.products, ['derod', 'tela', 'hologram', 'deropay']);
  assert.equal(docsList.returned, 120, 'default page cap is 120');
  assert.equal((docsList.pages as Json[]).length, 120);

  const telaList = expectJson(await manager.callTool(serverId, 'dero_docs_list', { product: 'tela', limit: 5 }));
  assert.equal(telaList.total, 38);
  assert.equal(telaList.returned, 5);
  const telaPages = telaList.pages as Array<{ product: string; slug: string; title: string; canonical_url: string }>;
  assert.equal(telaPages.length, 5);
  assert.ok(telaPages.every((page) => page.product === 'tela'));
  // The site landing page carries an empty slug, so only titles are universal.
  assert.ok(telaPages.every((page) => page.title.length > 0));
  assert.ok(telaPages.every((page) => page.canonical_url.startsWith('https://tela.derod.org/')));

  const search = expectJson(await manager.callTool(serverId, 'dero_docs_search', {
    query: 'daemon rpc api', product: 'derod', limit: 10,
  }));
  assert.equal(search.docs_source, 'bundled');
  assert.ok((search.total_matches as number) > 0);
  const hits = search.results as Array<{ product: string; slug: string; excerpt: string; score: number }>;
  assert.ok(hits.length > 0 && hits.length <= 10);
  assert.ok(hits.every((hit) => hit.product === 'derod'));
  assert.ok(hits.every((hit) => hit.excerpt.length > 0 && hit.score > 0));
  assert.ok(
    hits.some((hit) => hit.slug === 'rpc-api/daemon-rpc-api'),
    'daemon RPC reference ranks among the search hits'
  );

  const aboutPage = expectJson(await manager.callTool(serverId, 'dero_docs_get_page', {
    slug: 'basics/about', product: 'derod',
  }));
  assert.equal(aboutPage.product, 'derod');
  assert.equal(aboutPage.slug, 'basics/about');
  assert.ok((aboutPage.title as string).includes('Understanding DERO'));
  assert.equal(aboutPage.canonical_url, 'https://derod.org/basics/about.md');
  const aboutContent = aboutPage.content as string;
  assert.ok(aboutContent.length > 1000, 'page body is real packaged prose');
  assert.ok(/privacy/i.test(aboutContent));
  assert.equal(aboutPage.content_offset, 0);
  assert.equal(aboutPage.content_length, aboutContent.length);
  assert.equal(aboutPage.content_truncated, false);
  assert.equal(aboutPage.next_offset, null);

  const aboutTail = expectJson(await manager.callTool(serverId, 'dero_docs_get_page', {
    slug: 'basics/about', offset: 100,
  }));
  assert.equal(aboutTail.content_offset, 100);
  assert.equal(aboutTail.content, aboutContent.slice(100), 'offset pagination returns the same plaintext');

  const recommend = expectJson(await manager.callTool(serverId, 'recommend_docs_path', {
    intent: 'deploy a TELA app', product_hint: 'tela',
  }));
  assert.equal(recommend.intent, 'deploy a TELA app');
  assert.equal(recommend.product_hint, 'tela');
  const recs = recommend.recommended as Array<{ product: string; slug: string; score: number; boosted_score: number; rationale: string }>;
  assert.ok(recs.length > 0);
  assert.ok(recs.some((rec) => rec.product === 'tela'));
  for (const rec of recs) {
    const expected = rec.product === 'tela' ? Math.round(rec.score * 1.5 * 100) / 100 : rec.score;
    assert.equal(rec.boosted_score, expected, `product_hint boost is applied exactly for ${rec.product}/${rec.slug}`);
    assert.ok(rec.rationale.includes(`product=${rec.product}`));
  }
  assert.deepEqual(Object.keys(recommend.by_product as Json).sort(), ['derod', 'deropay', 'hologram', 'tela']);
  const recommendCites = recommend.related_docs as Array<{ source: string; slug: string; page_id: string; canonical_url: string }>;
  assert.ok(recommendCites.length >= 1 && recommendCites.length <= 2);
  assert.ok(recommendCites.every((cite) => cite.source === 'dero_docs' && cite.page_id === cite.slug && cite.canonical_url.endsWith('.md')));

  const proof = expectJson(await manager.callTool(serverId, 'dero_decode_proof_string', {
    proof_string: FLAGGED_PROOF_STRING,
  }));
  const decoded = proof.decoded as Json;
  assert.equal(decoded.hrp, 'deroproof');
  assert.equal(decoded.is_proof, true);
  assert.equal(decoded.mainnet, true);
  assert.match(decoded.public_key_hex as string, /^[0-9a-f]{66}$/);
  assert.ok((proof.context_note as string).includes('2022 inflation claims'), 'flagged proof string carries the integrity context note');
  const proofDocs = proof.related_docs as Array<{ slug: string }>;
  assert.equal(proofDocs[0]?.slug, 'integrity/negative-transfer-protection');

  // Structured tool errors from offline validation paths.
  const emptyQueryError = expectStructuredError(
    await manager.callTool(serverId, 'dero_docs_search', { query: '   ' }),
    'dero_docs_search'
  );
  assert.equal(emptyQueryError.code, 'INVALID_INPUT');
  assert.equal(emptyQueryError.retryable, false);

  const missingPageError = expectStructuredError(
    await manager.callTool(serverId, 'dero_docs_get_page', { slug: 'no/such/page' }),
    'dero_docs_get_page'
  );
  assert.equal(missingPageError.code, 'DOC_NOT_FOUND');
  assert.ok(missingPageError.hint.includes('dero_docs_search'));

  const badBech32Error = expectStructuredError(
    await manager.callTool(serverId, 'dero_decode_proof_string', { proof_string: 'deroproof1qqqqqqqq' }),
    'dero_decode_proof_string'
  );
  assert.equal(badBech32Error.code, 'INVALID_BECH32');

  const blockArgsError = expectStructuredError(
    await manager.callTool(serverId, 'dero_get_block', {}),
    'dero_get_block'
  );
  assert.equal(blockArgsError.code, 'INVALID_INPUT');
  assert.equal(blockArgsError.hint, 'Pass exactly one of "hash" or "height".');

  assert.deepEqual(methods, ['DERO.Ping'], 'offline documentation tools never touch the daemon');
  drainDaemonLog();

  // ---------------------------------------------------------------------
  // Daemon-backed tools against method-aware fixtures.
  // ---------------------------------------------------------------------

  const echo = await manager.callTool(serverId, 'dero_daemon_echo', { words: ['hello', 'hive'] });
  assert.notEqual(echo.isError, true);
  assert.equal(expectText(echo), 'hello hive');
  const echoLog = drainDaemonLog();
  assert.deepEqual(echoLog.map((entry) => entry.method), ['DERO.Echo']);
  assert.deepEqual(echoLog[0]?.params, ['hello', 'hive'], 'echo words pass through as the RPC params');

  const info = expectJson(await manager.callTool(serverId, 'dero_get_info', {}));
  assert.equal(info.topoheight, 5000);
  assert.equal(info.stableheight, 4992);
  assert.equal(info.version, GET_INFO_FIXTURE.version);
  const infoDocs = info.related_docs as Array<{ source: string; slug: string; canonical_url: string }>;
  assert.equal(infoDocs[0]?.source, 'dero_docs');
  assert.equal(infoDocs[0]?.slug, 'rpc-api/daemon-rpc-api');
  assert.equal(infoDocs[0]?.canonical_url, 'https://derod.org/rpc-api/daemon-rpc-api.md');
  assert.deepEqual(drainDaemonLog().map((entry) => entry.method), ['DERO.GetInfo']);

  const header = expectJson(await manager.callTool(serverId, 'dero_get_block_header_by_topo_height', {
    topoheight: FLAGGED_TOPOHEIGHT,
  }));
  assert.equal((header.block_header as Json).topoheight, FLAGGED_TOPOHEIGHT);
  assert.equal(header.status, 'OK');
  assert.ok((header.context_note as string).includes('2022 inflation claims'), 'flagged topoheight response is enriched');
  assert.deepEqual(
    (header.related_docs as Array<{ slug: string }>).slice(0, 3).map((doc) => doc.slug),
    [
      'integrity/negative-transfer-protection',
      'integrity/payload-vs-transaction-proofs',
      'integrity/ring-member-behavior',
    ]
  );
  const headerLog = drainDaemonLog();
  assert.deepEqual(headerLog.map((entry) => entry.method), ['DERO.GetBlockHeaderByTopoHeight']);
  assert.deepEqual(headerLog[0]?.params, { topoheight: FLAGGED_TOPOHEIGHT });

  const health = expectJson(await manager.callTool(serverId, 'diagnose_chain_health', {}));
  assert.equal(health.status, 'healthy');
  const chain = health.chain as Json;
  assert.equal(chain.topoheight, 5000);
  assert.equal(chain.stableheight, 4992);
  assert.equal(chain.network, 'mainnet', 'blank network + testnet:false resolves to mainnet');
  assert.equal(chain.version, GET_INFO_FIXTURE.version);
  const mempool = health.mempool as { pending: number; sample: string[] };
  assert.equal(mempool.pending, 1);
  assert.deepEqual(mempool.sample, [MEMPOOL_TX_HASH]);
  const signals = health.signals as Array<{ key: string; value: unknown }>;
  const signalFor = (key: string) => signals.find((signal) => signal.key === key);
  assert.equal(signalFor('topoheight')?.value, 5000);
  assert.equal(signalFor('lag_depth')?.value, 8);
  assert.equal(signalFor('mempool_pending')?.value, 1);
  assert.ok((health.narrative as string).includes('Mempool has 1 pending transaction'));
  assert.ok((health.related_docs as Array<{ slug: string }>).some((doc) => doc.slug === 'basics/daemon'));
  assert.deepEqual(
    drainDaemonLog().map((entry) => entry.method),
    ['DERO.Ping', 'DERO.GetInfo', 'DERO.GetHeight', 'DERO.GetTxPool'],
    'composite chains its primitives sequentially'
  );

  const estimate = expectJson(await manager.callTool(serverId, 'estimate_deploy_cost', { sc: DVM_SOURCE }));
  assert.deepEqual(estimate.estimate, { gascompute: 1111, gasstorage: 2222, status: 'OK' });
  const breakdown = estimate.breakdown as { compute_note: string; storage_note: string; total_units: number };
  assert.equal(breakdown.total_units, 3333);
  assert.ok(breakdown.compute_note.includes('gascompute=1111'));
  assert.ok(breakdown.storage_note.includes('gasstorage=2222'));
  const surface = estimate.sc_surface as {
    functions: Array<{ name: string; args: string[]; returns: string }>;
    function_count: number;
    raw_code_length: number;
  };
  assert.equal(surface.function_count, 2);
  assert.deepEqual(surface.functions.map((fn) => fn.name), ['Initialize', 'Deposit']);
  assert.deepEqual(surface.functions[1]?.args, ['amount Uint64']);
  assert.equal(surface.functions[1]?.returns, 'Uint64');
  assert.equal(surface.raw_code_length, DVM_SOURCE.length);
  assert.ok((estimate.related_docs as Array<{ slug: string }>).some((doc) => doc.slug === 'dvm/create-deploy-use-smart-contract'));
  const estimateLog = drainDaemonLog();
  assert.deepEqual(estimateLog.map((entry) => entry.method), ['DERO.GetGasEstimate']);
  assert.equal((estimateLog[0]?.params as { sc: string }).sc, DVM_SOURCE, 'contract source is forwarded verbatim');

  const explain = expectJson(await manager.callTool(serverId, 'explain_smart_contract', { scid: REGISTRY_SCID }));
  assert.equal(explain.scid, REGISTRY_SCID);
  assert.equal(explain.kind, 'registry', 'EXISTS/Register/Lookup surface classifies as a registry');
  assert.equal(explain.has_code, true);
  assert.equal(explain.raw_code_length, REGISTRY_SC_CODE.length);
  const explainSurface = explain.surface as {
    functions: Array<{ name: string }>;
    stringkeys: string[];
    stringkeys_total: number;
    stringkeys_truncated: boolean;
    balances: Record<string, number>;
  };
  assert.deepEqual(explainSurface.functions.map((fn) => fn.name), ['Register', 'Lookup']);
  assert.deepEqual(explainSurface.stringkeys, ['alice', 'bob']);
  assert.equal(explainSurface.stringkeys_total, 2);
  assert.equal(explainSurface.stringkeys_truncated, false);
  assert.deepEqual(explainSurface.balances, { ['0'.repeat(64)]: 12_345 });
  assert.ok((explain.narrative as string).includes('registry-style surface'));
  assert.equal(
    (explain.related_docs as Array<{ slug: string }>)[0]?.slug,
    'dvm/smart-contract-fundamentals',
    'registry classification elevates the fundamentals docs page'
  );
  const explainLog = drainDaemonLog();
  assert.deepEqual(explainLog.map((entry) => entry.method), ['DERO.GetSC']);
  assert.deepEqual(explainLog[0]?.params, { scid: REGISTRY_SCID, code: true, variables: true });

  // A real JSON-RPC -32601 from the daemon maps to a structured code.
  const methodNotFound = expectStructuredError(
    await manager.callTool(serverId, 'dero_get_block_count', {}),
    'dero_get_block_count'
  );
  assert.equal(methodNotFound.code, 'RPC_METHOD_NOT_FOUND');
  assert.equal(methodNotFound.retryable, false);
  assert.ok(methodNotFound.raw.includes('RPC error -32601'));
  assert.deepEqual(drainDaemonLog().map((entry) => entry.method), ['DERO.GetBlockCount']);

  // ---------------------------------------------------------------------
  // Remaining simple daemon-backed primitives: passthrough payloads, exact
  // RPC params, and flagged-artifact enrichment where inputs match.
  // ---------------------------------------------------------------------

  const height = expectJson(await manager.callTool(serverId, 'dero_get_height', {}));
  assert.deepEqual(height, { height: 5000, stableheight: 4992, topoheight: 5000 });
  const heightLog = drainDaemonLog();
  assert.deepEqual(heightLog.map((entry) => entry.method), ['DERO.GetHeight']);
  assert.equal(heightLog[0]?.params, undefined, 'dero_get_height sends no params');

  const lastHeader = expectJson(await manager.callTool(serverId, 'dero_get_last_block_header', {}));
  assert.deepEqual(lastHeader, {
    block_header: { topoheight: 5000, height: 5000, depth: 0, hash: 'c3'.repeat(32) },
    status: 'OK',
  });
  assert.deepEqual(drainDaemonLog().map((entry) => entry.method), ['DERO.GetLastBlockHeader']);

  const txPool = expectJson(await manager.callTool(serverId, 'dero_get_tx_pool', {}));
  assert.deepEqual(txPool, { tx_hashes: [MEMPOOL_TX_HASH] }, 'tx pool is a verbatim passthrough with no citations');
  assert.deepEqual(drainDaemonLog().map((entry) => entry.method), ['DERO.GetTxPool']);

  const randomAddress = expectJson(await manager.callTool(serverId, 'dero_get_random_address', {}));
  assert.deepEqual(randomAddress, { address: ['dero1qyrandom0', 'dero1qyrandom1'], status: 'OK' });
  const randomLog = drainDaemonLog();
  assert.deepEqual(randomLog.map((entry) => entry.method), ['DERO.GetRandomAddress']);
  assert.equal(randomLog[0]?.params, undefined, 'no scid → the params field is omitted entirely');

  const randomAsset = expectJson(await manager.callTool(serverId, 'dero_get_random_address', { scid: '2'.repeat(64) }));
  assert.equal(randomAsset.status, 'OK');
  assert.deepEqual(drainDaemonLog()[0]?.params, { scid: '2'.repeat(64) });

  const headerByHash = expectJson(await manager.callTool(serverId, 'dero_get_block_header_by_hash', {
    hash: FLAGGED_BLOCK_HASH,
  }));
  assert.equal((headerByHash.block_header as Json).hash, FLAGGED_BLOCK_HASH);
  assert.equal((headerByHash.block_header as Json).topoheight, FLAGGED_TOPOHEIGHT);
  assert.equal(headerByHash.status, 'OK');
  assert.ok((headerByHash.context_note as string).includes('2022 inflation claims'), 'flagged block hash response is enriched');
  assert.deepEqual(
    (headerByHash.related_docs as Array<{ slug: string }>).map((doc) => doc.slug),
    [
      'integrity/negative-transfer-protection',
      'integrity/payload-vs-transaction-proofs',
      'integrity/ring-member-behavior',
    ]
  );
  const headerByHashLog = drainDaemonLog();
  assert.deepEqual(headerByHashLog.map((entry) => entry.method), ['DERO.GetBlockHeaderByHash']);
  assert.deepEqual(headerByHashLog[0]?.params, { hash: FLAGGED_BLOCK_HASH });

  const cleanHeader = expectJson(await manager.callTool(serverId, 'dero_get_block_header_by_hash', {
    hash: 'c3'.repeat(32),
  }));
  assert.equal((cleanHeader.block_header as Json).topoheight, 4321);
  assert.equal('context_note' in cleanHeader, false, 'unflagged hashes carry no integrity note');
  assert.equal('related_docs' in cleanHeader, false, 'dero_get_block_header_by_hash has no baseline citations');
  drainDaemonLog();

  const flaggedTx = expectJson(await manager.callTool(serverId, 'dero_get_transaction', {
    txs_hashes: [FLAGGED_TX_HASH], decode_as_json: 1,
  }));
  assert.equal(flaggedTx.status, 'OK');
  assert.equal((flaggedTx.txs as Json[])[0]?.valid_block, FLAGGED_BLOCK_HASH);
  assert.ok((flaggedTx.context_note as string).includes('2022 inflation claims'), 'flagged tx hash response is enriched');
  assert.deepEqual(
    (flaggedTx.related_docs as Array<{ slug: string }>).map((doc) => doc.slug),
    [
      'integrity/negative-transfer-protection',
      'integrity/payload-vs-transaction-proofs',
      'integrity/ring-member-behavior',
    ]
  );
  const flaggedTxLog = drainDaemonLog();
  assert.deepEqual(flaggedTxLog.map((entry) => entry.method), ['DERO.GetTransaction']);
  assert.deepEqual(flaggedTxLog[0]?.params, { txs_hashes: [FLAGGED_TX_HASH], decode_as_json: 1 });

  const cleanTx = expectJson(await manager.callTool(serverId, 'dero_get_transaction', {
    txs_hashes: [CONFIRMED_TRANSFER_TX],
  }));
  assert.deepEqual(cleanTx.txs_as_hex, ['deadbeefcafe']);
  assert.equal('context_note' in cleanTx, false);
  assert.equal('related_docs' in cleanTx, false, 'dero_get_transaction has no baseline citations');
  assert.deepEqual(
    drainDaemonLog()[0]?.params,
    { txs_hashes: [CONFIRMED_TRANSFER_TX] },
    'decode_as_json is omitted when not requested'
  );

  const balance = expectJson(await manager.callTool(serverId, 'dero_get_encrypted_balance', {
    address: TEST_WALLET_ADDRESS, topoheight: -1,
  }));
  assert.deepEqual(balance, { data: 'aa'.repeat(66), registration: 4321, topoheight: 5000, status: 'OK' });
  const balanceLog = drainDaemonLog();
  assert.deepEqual(balanceLog.map((entry) => entry.method), ['DERO.GetEncryptedBalance']);
  assert.deepEqual(balanceLog[0]?.params, { address: TEST_WALLET_ADDRESS, topoheight: -1 }, 'scid key is omitted for native DERO');

  const assetBalance = expectJson(await manager.callTool(serverId, 'dero_get_encrypted_balance', {
    address: TEST_WALLET_ADDRESS, topoheight: -1, scid: '3'.repeat(64),
  }));
  assert.equal(assetBalance.status, 'OK');
  assert.deepEqual(drainDaemonLog()[0]?.params, { address: TEST_WALLET_ADDRESS, topoheight: -1, scid: '3'.repeat(64) });

  const bigSc = expectJson(await manager.callTool(serverId, 'dero_get_sc', { scid: BIG_SC_SCID }));
  assert.equal(bigSc.status, 'OK');
  assert.equal(bigSc.code, BIG_SC_CODE);
  const bigKeys = Object.keys(bigSc.stringkeys as Json);
  assert.equal(bigKeys.length, 50, 'oversized stringkeys map is capped to a 50-key sample');
  assert.deepEqual(bigKeys, Array.from({ length: 50 }, (_, i) => `k${String(i).padStart(2, '0')}`));
  assert.equal(bigSc.stringkeys_total, 60);
  assert.equal(bigSc.stringkeys_truncated, true);
  assert.equal('uint64keys_total' in bigSc, false, 'maps at/under the cap carry no truncation markers');
  assert.deepEqual(
    (bigSc.related_docs as Array<{ slug: string }>).map((doc) => doc.slug),
    ['dvm/smart-contract-fundamentals', 'dvm/dero-virtual-machine']
  );
  const bigScLog = drainDaemonLog();
  assert.deepEqual(bigScLog.map((entry) => entry.method), ['DERO.GetSC']);
  assert.deepEqual(bigScLog[0]?.params, { scid: BIG_SC_SCID, code: true, variables: true }, 'code/variables default to true');

  const scExplicit = expectJson(await manager.callTool(serverId, 'dero_get_sc', {
    scid: REGISTRY_SCID, code: false, variables: false, topoheight: 4400,
  }));
  assert.equal(scExplicit.status, 'OK');
  assert.deepEqual(
    drainDaemonLog()[0]?.params,
    { scid: REGISTRY_SCID, code: false, variables: false, topoheight: 4400 },
    'explicit code/variables/topoheight are forwarded verbatim'
  );

  const gas = expectJson(await manager.callTool(serverId, 'dero_get_gas_estimate', {
    transfers: [{ destination: TEST_WALLET_ADDRESS, amount: 0 }],
    sc: DVM_SOURCE,
    sc_rpc: [{ name: 'entrypoint', datatype: 'S', value: 'Initialize' }],
    signer: TEST_WALLET_ADDRESS,
  }));
  assert.equal(gas.gascompute, 1111);
  assert.equal(gas.gasstorage, 2222);
  assert.deepEqual(
    (gas.related_docs as Array<{ slug: string }>).map((doc) => doc.slug),
    ['rpc-api/daemon-rpc-api', 'dvm/create-deploy-use-smart-contract']
  );
  const gasLog = drainDaemonLog();
  assert.deepEqual(gasLog.map((entry) => entry.method), ['DERO.GetGasEstimate']);
  assert.deepEqual(gasLog[0]?.params, {
    transfers: [{ destination: TEST_WALLET_ADDRESS, amount: 0 }],
    sc: DVM_SOURCE,
    sc_rpc: [{ name: 'entrypoint', datatype: 'S', value: 'Initialize' }],
    signer: TEST_WALLET_ADDRESS,
  }, 'all four optional gas-estimate params are forwarded');

  const nameLookup = expectJson(await manager.callTool(serverId, 'dero_name_to_address', {
    name: 'captain', topoheight: -1,
  }));
  assert.deepEqual(nameLookup, { address: 'dero1qynamedaddr', name: 'captain', status: 'OK' });
  const nameLog = drainDaemonLog();
  assert.deepEqual(nameLog.map((entry) => entry.method), ['DERO.NameToAddress']);
  assert.deepEqual(nameLog[0]?.params, { name: 'captain', topoheight: -1 });

  const template = expectJson(await manager.callTool(serverId, 'dero_get_block_template', {
    wallet_address: TEST_WALLET_ADDRESS, block: true, miner: 'rig-1',
  }));
  assert.equal(template.status, 'OK');
  assert.equal(template.height, 5001);
  assert.equal(template.jobid, 'job-0001');
  const templateLog = drainDaemonLog();
  assert.deepEqual(templateLog.map((entry) => entry.method), ['DERO.GetBlockTemplate']);
  assert.deepEqual(templateLog[0]?.params, { wallet_address: TEST_WALLET_ADDRESS, block: true, miner: 'rig-1' });

  // ---------------------------------------------------------------------
  // trace_transaction_with_context: confirmation + kind classification,
  // inline SC-install surface extraction, and the TX_NOT_FOUND path.
  // ---------------------------------------------------------------------

  const traceTransfer = expectJson(await manager.callTool(serverId, 'trace_transaction_with_context', {
    tx_hash: CONFIRMED_TRANSFER_TX,
  }));
  assert.equal(traceTransfer.tx_hash, CONFIRMED_TRANSFER_TX);
  assert.deepEqual(traceTransfer.confirmation, {
    status: 'confirmed',
    block_height: 4980,
    valid_block: 'f1'.repeat(32),
    invalid_blocks: [],
    in_pool: false,
  });
  assert.equal(traceTransfer.kind, 'transfer_or_invocation');
  assert.deepEqual(traceTransfer.ring, { groups: 1, first_group_size: 2 });
  assert.equal(traceTransfer.reward, null);
  assert.equal(traceTransfer.signer_visible, false);
  assert.deepEqual(traceTransfer.native_balance, { scid: '0'.repeat(64), at_tx: 100, current: 90 });
  assert.equal(traceTransfer.sc_install, null);
  assert.equal(traceTransfer.raw_tx_hex_length, 12);
  assert.ok((traceTransfer.narrative as string).includes('confirmed at block height 4980'));
  assert.ok((traceTransfer.narrative as string).includes('1 input ring group present.'));
  assert.ok((traceTransfer.narrative as string).includes('12-char raw hex blob'));
  assert.deepEqual(
    (traceTransfer.related_docs as Array<{ slug: string }>).map((doc) => doc.slug),
    ['rpc-api/daemon-rpc-api', 'dvm/smart-contract-fundamentals']
  );
  const traceLog = drainDaemonLog();
  assert.deepEqual(traceLog.map((entry) => entry.method), ['DERO.GetTransaction']);
  assert.deepEqual(traceLog[0]?.params, { txs_hashes: [CONFIRMED_TRANSFER_TX], decode_as_json: 1 }, 'decode defaults to decode_as_json=1');

  const traceInstall = expectJson(await manager.callTool(serverId, 'trace_transaction_with_context', {
    tx_hash: SC_INSTALL_TX, decode: false,
  }));
  assert.equal(traceInstall.kind, 'sc_install');
  const scInstall = traceInstall.sc_install as {
    scid: string;
    surface: { functions: Array<{ name: string }> };
    raw_code_length: number;
    has_code: boolean;
  };
  assert.equal(scInstall.scid, SC_INSTALL_TX, 'for installs the tx_hash is the resulting SCID');
  assert.deepEqual(scInstall.surface.functions.map((fn) => fn.name), ['Initialize', 'Deposit']);
  assert.equal(scInstall.raw_code_length, DVM_SOURCE.length);
  assert.equal(scInstall.has_code, true);
  assert.ok((traceInstall.narrative as string).includes('smart-contract INSTALL'));
  assert.equal((traceInstall._diagnostics as Json).decode_as_json, false);
  const installLog = drainDaemonLog();
  assert.deepEqual(installLog[0]?.params, { txs_hashes: [SC_INSTALL_TX], decode_as_json: 0 }, 'decode:false maps to decode_as_json=0');

  const traceNoCtx = expectJson(await manager.callTool(serverId, 'trace_transaction_with_context', {
    tx_hash: SC_INSTALL_TX, include_sc_context: false,
  }));
  assert.equal(traceNoCtx.kind, 'sc_install');
  assert.equal(traceNoCtx.sc_install, null, 'surface extraction is skipped when include_sc_context=false');
  assert.equal((traceNoCtx._diagnostics as Json).sc_install_surface_attempted, false);
  drainDaemonLog();

  const traceMissing = expectStructuredError(
    await manager.callTool(serverId, 'trace_transaction_with_context', { tx_hash: UNKNOWN_TX_HASH }),
    'trace_transaction_with_context'
  );
  assert.equal(traceMissing.code, 'TX_NOT_FOUND');
  assert.equal(traceMissing.retryable, true);
  assert.ok(traceMissing.raw.includes('empty record'));
  assert.ok(traceMissing.hint.includes('mempool propagation'));
  drainDaemonLog();

  // ---------------------------------------------------------------------
  // audit_chain_artifact_claim: verdicts, flagged-registry matches, proof
  // decode, and the embedded forge-demo degradation paths.
  // ---------------------------------------------------------------------

  const auditInvalid = expectStructuredError(
    await manager.callTool(serverId, 'audit_chain_artifact_claim', {}),
    'audit_chain_artifact_claim'
  );
  assert.equal(auditInvalid.code, 'INVALID_INPUT');
  assert.ok(auditInvalid.hint.includes('at least one of topoheight'));

  const auditFlagged = expectJson(await manager.callTool(serverId, 'audit_chain_artifact_claim', {
    topoheight: FLAGGED_TOPOHEIGHT,
  }));
  assert.equal(auditFlagged.verdict, 'cited_in_false_claim');
  assert.deepEqual(auditFlagged.matched_artifacts, [{ id: '2022-inflation-claim', matched_by: ['topoheight'] }]);
  assert.ok((auditFlagged.context_note as string).includes('2022 inflation claims'));
  const auditHeader = (auditFlagged.chain_facts as { block_header: Json }).block_header;
  assert.equal(auditHeader.topoheight, FLAGGED_TOPOHEIGHT);
  assert.equal(auditHeader.reward, 123_456_789);
  assert.ok((auditFlagged.narrative as string).includes('2022-inflation-claim'));
  assert.ok(
    (auditFlagged.narrative as string).includes('reward=1234.56789 DERO'),
    'atomic reward formatting keeps all five fractional digits'
  );
  assert.ok((auditFlagged.narrative as string).includes('txcount=2'));
  assert.equal(auditFlagged.proof_decode, null);
  assert.equal(auditFlagged.forge_demo, null);
  assert.deepEqual(
    (auditFlagged.related_docs as Array<{ slug: string }>).map((doc) => doc.slug),
    [
      'integrity/negative-transfer-protection',
      'integrity/payload-vs-transaction-proofs',
      'integrity/ring-member-behavior',
    ]
  );
  const auditFlaggedLog = drainDaemonLog();
  assert.deepEqual(auditFlaggedLog.map((entry) => entry.method), ['DERO.GetBlockHeaderByTopoHeight']);
  assert.deepEqual(auditFlaggedLog[0]?.params, { topoheight: FLAGGED_TOPOHEIGHT });

  const auditClean = expectJson(await manager.callTool(serverId, 'audit_chain_artifact_claim', {
    topoheight: 4242, include_forge_demo: true,
  }));
  assert.equal(auditClean.verdict, 'clean');
  assert.deepEqual(auditClean.matched_artifacts, []);
  assert.equal(auditClean.context_note, null);
  assert.equal(((auditClean.chain_facts as { block_header: Json }).block_header).topoheight, 4242);
  assert.deepEqual(auditClean.forge_demo, {
    skipped: true,
    reason: 'include_forge_demo requires tx_hash (forging needs the TX commitments)',
  });
  assert.ok((auditClean.narrative as string).includes('No matches found'));
  assert.deepEqual(
    (auditClean.related_docs as Array<{ slug: string }>).map((doc) => doc.slug),
    ['integrity/payload-vs-transaction-proofs', 'integrity/negative-transfer-protection']
  );
  assert.deepEqual(drainDaemonLog().map((entry) => entry.method), ['DERO.GetBlockHeaderByTopoHeight']);

  const auditProof = expectJson(await manager.callTool(serverId, 'audit_chain_artifact_claim', {
    proof_string: FLAGGED_PROOF_STRING,
  }));
  assert.equal(auditProof.verdict, 'cited_in_false_claim');
  assert.deepEqual(auditProof.matched_artifacts, [{ id: '2022-inflation-claim', matched_by: ['proof_string'] }]);
  assert.equal(auditProof.chain_facts, null);
  const proofFacts = auditProof.proof_decode as Json;
  assert.equal(proofFacts.hrp, 'deroproof');
  assert.equal(proofFacts.is_proof, true);
  assert.equal(proofFacts.value_transfer_uint64, '18446743853709551435');
  assert.equal((proofFacts.value_interpretation as Json).dero, '-2200000.00181');
  assert.equal((proofFacts.value_interpretation as Json).is_negative_wraparound, true);
  assert.ok((auditProof.narrative as string).includes('uint64 wraparound'));
  assert.deepEqual(drainDaemonLog(), [], 'proof-string-only audit is fully offline');

  const auditTx = expectJson(await manager.callTool(serverId, 'audit_chain_artifact_claim', {
    tx_hash: FLAGGED_TX_HASH, include_forge_demo: true,
  }));
  assert.equal(auditTx.verdict, 'cited_in_false_claim');
  assert.deepEqual(auditTx.matched_artifacts, [{ id: '2022-inflation-claim', matched_by: ['tx_hash'] }]);
  assert.deepEqual((auditTx.chain_facts as Json).transaction_status, {
    accepted: true,
    in_pool: false,
    block_height: 1_081_870,
    valid_block: FLAGGED_BLOCK_HASH,
  });
  assert.ok((auditTx.narrative as string).includes('accepted into block height=1081870'));
  const auditForgeDemo = auditTx.forge_demo as { skipped: boolean; reason?: string };
  assert.equal(auditForgeDemo.skipped, true, 'unparseable tx binary degrades the forge demo instead of fabricating a proof');
  assert.ok(auditForgeDemo.reason?.includes('forge failed'));
  const auditTxLog = drainDaemonLog();
  assert.deepEqual(auditTxLog.map((entry) => entry.method), ['DERO.GetTransaction', 'DERO.GetTransaction']);
  assert.deepEqual(auditTxLog[0]?.params, { txs_hashes: [FLAGGED_TX_HASH] });
  assert.deepEqual(auditTxLog[1]?.params, { txs_hashes: [FLAGGED_TX_HASH], decode_as_json: 1 }, 'forge re-fetches the tx with decode enabled');

  // ---------------------------------------------------------------------
  // dero_forge_demo_proof: full offline forge against a hand-assembled tx,
  // round-tripped through dero_decode_proof_string, plus every failure path.
  // ---------------------------------------------------------------------

  const forge = expectJson(await manager.callTool(serverId, 'dero_forge_demo_proof', {
    tx_hex: FORGE_DEMO_TX_HEX,
  }));
  assert.match(forge.forged_proof_string as string, /^deroproof1[02-9ac-hj-np-z]+$/, 'forged string is bech32 with the deroproof HRP');
  assert.deepEqual(forge.target_amount, {
    dero: '-1.00000',
    atoms_signed: '-100000',
    atoms_uint64: '18446744073709451616',
  }, 'default -1 DERO demo amount wraps to uint64');
  assert.equal(forge.ring_slot, 0);
  assert.equal(forge.ring_size, 2);
  assert.equal(forge.ring_receiver_address, null, 'tx_hex path carries no ring addresses');
  const forgeMath = forge.math as { C_slot_hex: string; amount_x_G_hex: string; blinder_hex: string };
  assert.equal(forgeMath.C_slot_hex, DERO_G_COMPRESSED_HEX);
  assert.match(forgeMath.amount_x_G_hex, /^[0-9a-f]{66}$/);
  assert.match(forgeMath.blinder_hex, /^[0-9a-f]{66}$/);
  assert.notEqual(forgeMath.blinder_hex, forgeMath.C_slot_hex);
  const selfCheck = forge.self_check as { verified: boolean; method: string };
  assert.equal(selfCheck.verified, true);
  assert.ok(selfCheck.method.includes('proof.Prove()'));
  assert.equal(forge.explorer_display_amount, '184,467,440,737,094.51616 DERO');
  assert.ok((forge.context_note as string).includes('no wallet, no keys, no broadcast'));
  assert.deepEqual(
    (forge.related_docs as Array<{ slug: string }>).map((doc) => doc.slug),
    [
      'integrity/payload-vs-transaction-proofs',
      'integrity/negative-transfer-protection',
      'integrity/range-proof-integrity',
    ]
  );
  assert.equal((forge._diagnostics as Json).tx_source, 'tx_hex');
  assert.deepEqual(drainDaemonLog(), [], 'tx_hex forge path never touches the daemon');

  // Close the loop: the freshly forged string must decode back to the same
  // blinder point and the same wrapped uint64 amount.
  const forgedDecode = expectJson(await manager.callTool(serverId, 'dero_decode_proof_string', {
    proof_string: forge.forged_proof_string as string,
  }));
  const forgedDecoded = forgedDecode.decoded as {
    hrp: string;
    mainnet: boolean;
    is_proof: boolean;
    public_key_hex: string;
    arguments: Array<{ name: string; type: string; value: unknown }>;
  };
  assert.equal(forgedDecoded.hrp, 'deroproof');
  assert.equal(forgedDecoded.mainnet, true);
  assert.equal(forgedDecoded.is_proof, true);
  assert.equal(forgedDecoded.public_key_hex, forgeMath.blinder_hex, 'embedded point is the forged blinder');
  assert.equal(
    forgedDecoded.arguments.find((arg) => arg.name === 'V')?.value,
    '18446744073709451616',
    'forged VU argument round-trips through the decoder'
  );
  assert.equal(forgedDecoded.arguments.find((arg) => arg.name === 'H')?.value, '00'.repeat(32));
  const forgedInterp = forgedDecode.value_interpretation as Json;
  assert.equal(forgedInterp.dero, '-1.00000');
  assert.equal(forgedInterp.is_negative_wraparound, true);
  assert.equal(forgedInterp.signed_atoms, '-100000');
  assert.equal('context_note' in forgedDecode, false, 'a fresh forged string is not in the flagged registry');

  const forgeBoth = expectStructuredError(
    await manager.callTool(serverId, 'dero_forge_demo_proof', {
      tx_hash: CONFIRMED_TRANSFER_TX, tx_hex: FORGE_DEMO_TX_HEX,
    }),
    'dero_forge_demo_proof'
  );
  assert.equal(forgeBoth.code, 'INVALID_INPUT');
  assert.ok(forgeBoth.hint.includes('exactly one of tx_hash or tx_hex'));

  const forgeNeither = expectStructuredError(
    await manager.callTool(serverId, 'dero_forge_demo_proof', {}),
    'dero_forge_demo_proof'
  );
  assert.equal(forgeNeither.code, 'INVALID_INPUT');
  assert.ok(forgeNeither.hint.includes('either tx_hash or tx_hex'));

  const forgeSlot = expectStructuredError(
    await manager.callTool(serverId, 'dero_forge_demo_proof', {
      tx_hex: FORGE_DEMO_TX_HEX, ring_slot: 2,
    }),
    'dero_forge_demo_proof'
  );
  assert.equal(forgeSlot.code, 'INVALID_INPUT');
  assert.ok(forgeSlot.hint.includes('ring_slot 2 >= ring_size 2'));

  const forgeNoHex = expectStructuredError(
    await manager.callTool(serverId, 'dero_forge_demo_proof', { tx_hash: HEXLESS_TX_HASH }),
    'dero_forge_demo_proof'
  );
  assert.equal(forgeNoHex.code, 'TOOL_EXECUTION_ERROR');
  assert.ok(forgeNoHex.raw.includes('did not return TX hex'));
  assert.deepEqual(
    drainDaemonLog().map((entry) => entry.method),
    ['DERO.GetTransaction'],
    'only the tx_hash forge path touches the daemon'
  );

  // ---------------------------------------------------------------------
  // tela_inspect: INDEX manifest parsing, DOC parsing with citation
  // re-ranking, and the not_tela success (not error) path.
  // ---------------------------------------------------------------------

  const inspectIndex = expectJson(await manager.callTool(serverId, 'tela_inspect', { scid: TELA_INDEX_SCID }));
  assert.equal(inspectIndex.kind, 'tela_index');
  assert.equal(inspectIndex.topoheight, null);
  assert.equal(inspectIndex.has_code, true);
  assert.equal(inspectIndex.collision, false);
  const telaIndex = inspectIndex.index as {
    name: string; durl: string; description: string; mods: string[];
    docs: Array<{ position: number; key: string; scid: string; is_entrypoint: boolean; malformed: boolean }>;
    doc_count: number; commit: number; version_history: Array<{ commit: number; txid: string }>;
    current_commit_hash: string; updateable: string; parse_notes: string[];
  };
  assert.equal(telaIndex.name, 'Test App', 'hex-encoded stringkey values are decoded to text');
  assert.equal(telaIndex.durl, 'test.tela');
  assert.equal(telaIndex.description, 'A test TELA app');
  assert.deepEqual(telaIndex.mods, ['xswd', 'vars']);
  assert.equal(telaIndex.doc_count, 1);
  assert.deepEqual(telaIndex.docs, [
    { position: 1, key: 'DOC1', scid: TELA_DOC_SCID, is_entrypoint: true, malformed: false },
  ]);
  assert.equal(telaIndex.commit, 1, 'commit counter is read from uint64keys');
  assert.deepEqual(telaIndex.version_history, [{ commit: 0, txid: 'a'.repeat(64) }]);
  assert.equal(telaIndex.current_commit_hash, 'c0ffee01');
  assert.equal(telaIndex.updateable, 'unknown', 'GetSC does not expose ringsize, so updateability is honestly unknown');
  assert.deepEqual(telaIndex.parse_notes, []);
  assert.ok((inspectIndex.narrative as string).includes('TELA-INDEX-1 app manifest "Test App" (test.tela)'));
  assert.ok((inspectIndex.narrative as string).includes(`Entrypoint DOC1 → ${TELA_DOC_SCID}`));
  assert.equal((inspectIndex.related_docs as Array<{ slug: string }>)[0]?.slug, 'tela/tela-index-specification');
  const inspectIndexLog = drainDaemonLog();
  assert.deepEqual(inspectIndexLog.map((entry) => entry.method), ['DERO.GetSC']);
  assert.deepEqual(inspectIndexLog[0]?.params, { scid: TELA_INDEX_SCID, code: true, variables: true });

  const inspectDoc = expectJson(await manager.callTool(serverId, 'tela_inspect', {
    scid: TELA_DOC_SCID, topoheight: 4600,
  }));
  assert.equal(inspectDoc.kind, 'tela_doc');
  assert.equal(inspectDoc.topoheight, 4600);
  const telaDoc = inspectDoc.doc as {
    filename: string; doc_type: string;
    signature: { present: boolean; file_check_c_present: boolean; file_check_s_present: boolean };
    content_embedded: boolean; immutable: boolean; parse_notes: string[];
  };
  assert.equal(telaDoc.filename, 'index.html');
  assert.equal(telaDoc.doc_type, 'TELA-HTML-1');
  assert.deepEqual(telaDoc.signature, { present: true, file_check_c_present: true, file_check_s_present: true });
  assert.equal(telaDoc.content_embedded, true);
  assert.equal(telaDoc.immutable, true);
  assert.deepEqual(telaDoc.parse_notes, []);
  assert.ok((inspectDoc.narrative as string).includes('TELA-DOC-1 file contract for "index.html"'));
  assert.ok((inspectDoc.narrative as string).includes('signed by its author'));
  assert.equal(
    (inspectDoc.related_docs as Array<{ slug: string }>)[0]?.slug,
    'tela/tela-doc-specification',
    'the DOC spec is elevated to citation position 0 for DOC contracts'
  );
  const inspectDocLog = drainDaemonLog();
  assert.deepEqual(inspectDocLog[0]?.params, { scid: TELA_DOC_SCID, code: true, variables: true, topoheight: 4600 });

  const inspectPlain = expectJson(await manager.callTool(serverId, 'tela_inspect', { scid: PLAIN_SC_SCID }));
  assert.equal(inspectPlain.kind, 'not_tela');
  assert.notEqual((inspectPlain as { isError?: boolean }).isError, true, 'not_tela is a SUCCESS, not an error');
  assert.ok((inspectPlain.reason as string).includes('lacks TELA-INDEX-1 or TELA-DOC-1 marker keys'));
  const observed = inspectPlain.observed as {
    stringkey_sample: string[]; stringkeys_total: number; has_code: boolean; markers: string[];
  };
  assert.deepEqual(observed.stringkey_sample, ['alice', 'bob']);
  assert.equal(observed.stringkeys_total, 2);
  assert.equal(observed.has_code, true);
  assert.deepEqual(observed.markers, []);
  assert.ok((inspectPlain.narrative as string).includes('explain_smart_contract'));
  drainDaemonLog();

  // ---------------------------------------------------------------------
  // tela_get_doc_content: embedded content extraction, offset pagination,
  // transparent gzip decompression, and the INDEX-not-a-DOC error.
  // ---------------------------------------------------------------------

  const docContent = expectJson(await manager.callTool(serverId, 'tela_get_doc_content', { scid: TELA_DOC_SCID }));
  assert.equal(docContent.filename, 'index.html');
  assert.equal(docContent.stored_filename, 'index.html');
  assert.equal(docContent.doc_type, 'TELA-HTML-1');
  assert.equal(docContent.content_embedded, true);
  assert.equal(docContent.content, TELA_DOC_HTML, 'file bytes are extracted from the DVM comment block');
  assert.equal(docContent.content_offset, 0);
  assert.equal(docContent.content_length, TELA_DOC_HTML.length);
  assert.equal(docContent.content_truncated, false);
  assert.equal(docContent.next_offset, null);
  assert.equal(docContent.compressed, false);
  assert.equal(docContent.decompressed, false);
  assert.ok((docContent.signature_note as string).includes('does NOT cryptographically verify'));
  assert.ok((docContent.narrative as string).includes(`Fetched ${TELA_DOC_HTML.length} bytes`));
  assert.equal((docContent.related_docs as Array<{ slug: string }>)[0]?.slug, 'tela/tela-doc-specification');
  drainDaemonLog();

  const docTail = expectJson(await manager.callTool(serverId, 'tela_get_doc_content', {
    scid: TELA_DOC_SCID, offset: 6,
  }));
  assert.equal(docTail.content_offset, 6);
  assert.equal(docTail.content, TELA_DOC_HTML.slice(6), 'offset pagination slices the same extracted content');
  assert.equal(docTail.content_length, TELA_DOC_HTML.length);
  drainDaemonLog();

  const gzContent = expectJson(await manager.callTool(serverId, 'tela_get_doc_content', { scid: GZ_DOC_SCID }));
  assert.equal(gzContent.compressed, true);
  assert.equal(gzContent.decompressed, true);
  assert.equal(gzContent.filename, 'app.js', 'the .gz suffix the user never sees is stripped');
  assert.equal(gzContent.stored_filename, 'app.js.gz');
  assert.equal(gzContent.content, GZ_PLAINTEXT, 'base64 gzip content is transparently decompressed');
  assert.equal(gzContent.content_length, GZ_PLAINTEXT.length);
  assert.ok((gzContent.note as string).includes('transparently decompressed'));
  drainDaemonLog();

  const docOnIndex = expectStructuredError(
    await manager.callTool(serverId, 'tela_get_doc_content', { scid: TELA_INDEX_SCID }),
    'tela_get_doc_content'
  );
  assert.equal(docOnIndex.code, 'INVALID_INPUT');
  assert.ok(docOnIndex.hint.includes('tela_inspect'), 'INDEX SCIDs are routed to tela_inspect');
  drainDaemonLog();

  // ---------------------------------------------------------------------
  // TELA discovery (dero_durl_to_scid + dero_tela_list_apps): cold-start
  // Gnomon registry scan, collision disclosure, honest misses, and the
  // in-process cache.
  // ---------------------------------------------------------------------

  const durlHit = expectJson(await manager.callTool(serverId, 'dero_durl_to_scid', { durl: 'dero://TEST.tela' }));
  assert.equal(durlHit.query, 'dero://TEST.tela');
  assert.equal(durlHit.normalized, 'test.tela', 'dero:// prefix and case are normalized');
  assert.equal(durlHit.found, true);
  assert.equal(durlHit.match_count, 2);
  assert.equal(durlHit.scid, TELA_INDEX_SCID, 'the newest install wins as primary');
  assert.equal(durlHit.collision, true);
  assert.deepEqual(durlHit.primary, {
    scid: TELA_INDEX_SCID, durl: 'test.tela', name: 'Test App', install_height: 4200, doc_count: 1,
  });
  assert.deepEqual(durlHit.other_candidates, [
    { scid: TELA_INDEX_OLD_SCID, durl: 'test.tela', name: 'Old Test App', install_height: 4150, doc_count: 1 },
  ]);
  assert.ok((durlHit.narrative as string).includes('claimed by 2 contracts'));
  assert.deepEqual(
    (durlHit.related_docs as Array<{ slug: string }>).map((doc) => doc.slug),
    ['advanced-features/durl-explained', 'tela-cli/gnomon-guide']
  );
  const scanLog = drainDaemonLog();
  assert.equal(scanLog.length, 4, 'cold-start discovery = one registry fetch + three candidate scans');
  assert.ok(scanLog.every((entry) => entry.method === 'DERO.GetSC'));
  assert.deepEqual(
    scanLog[0]?.params,
    { scid: GNOMON_REGISTRY_SCID, code: false, variables: true },
    'registry fetch skips code to stay light'
  );
  assert.deepEqual(
    scanLog.slice(1).map((entry) => (entry.params as { scid: string }).scid).sort(),
    [TELA_INDEX_SCID, TELA_INDEX_OLD_SCID, PLAIN_SC_SCID].sort()
  );
  assert.ok(scanLog.slice(1).every((entry) => {
    const params = entry.params as { code: boolean; variables: boolean };
    return params.code === true && params.variables === true;
  }), 'candidate scans fetch code + variables for TELA classification');

  const durlMiss = expectJson(await manager.callTool(serverId, 'dero_durl_to_scid', { durl: 'missing.tela' }));
  assert.equal(durlMiss.found, false);
  assert.equal(durlMiss.match_count, 0);
  assert.ok((durlMiss.hint as string).includes('dero_tela_list_apps'));

  const nameMiss = expectJson(await manager.callTool(serverId, 'dero_durl_to_scid', { durl: 'quickbrownfox' }));
  assert.equal(nameMiss.found, false);
  assert.ok(
    (nameMiss.hint as string).includes('dero_name_to_address'),
    'dot-less queries are routed to the name service'
  );

  const telaApps = expectJson(await manager.callTool(serverId, 'dero_tela_list_apps', {}));
  assert.equal(telaApps.total_matched, 2);
  assert.equal(telaApps.returned, 2);
  assert.equal(telaApps.truncated, false);
  assert.deepEqual(
    (telaApps.apps as Json[]).map((app) => app.scid),
    [TELA_INDEX_SCID, TELA_INDEX_OLD_SCID],
    'apps are ordered newest install first'
  );
  assert.deepEqual(telaApps.index_meta, {
    apps_indexed: 2, scanned_scids: 3, registry_total: 3, newest_height: 4200,
  });

  const telaFiltered = expectJson(await manager.callTool(serverId, 'dero_tela_list_apps', { query: 'OLD', limit: 1 }));
  assert.equal(telaFiltered.total_matched, 1, 'query filter is case-insensitive on name/durl');
  assert.deepEqual((telaFiltered.apps as Json[]).map((app) => app.name), ['Old Test App']);
  assert.deepEqual(drainDaemonLog(), [], 'discovery cache serves every follow-up lookup without daemon calls');

  // ---------------------------------------------------------------------
  // Protocol-level failures must reject cleanly without killing the server.
  // ---------------------------------------------------------------------

  // The MCP SDK surfaces -32602 protocol errors in-band as isError tool
  // results, so the host sees a flagged failure instead of a dead transport.
  const unknownTool = await manager.callTool(serverId, 'dero_no_such_tool', {});
  assert.equal(unknownTool.isError, true, 'unknown tool name yields a flagged MCP error result');
  assert.match(expectText(unknownTool), /-32602.*Tool dero_no_such_tool not found/s);

  const badArgs = await manager.callTool(serverId, 'dero_get_block_header_by_topo_height', { topoheight: 'not-a-number' });
  assert.equal(badArgs.isError, true, 'schema-invalid arguments yield a flagged MCP error result');
  assert.match(expectText(badArgs), /Invalid arguments for tool dero_get_block_header_by_topo_height/);
  const statusAfterErrors = manager.getStatuses().find(({ id }) => id === serverId);
  assert.equal(statusAfterErrors?.connected, true, 'server survives protocol-level errors');
  const hologramList = expectJson(await manager.callTool(serverId, 'dero_docs_list', { product: 'hologram', limit: 1 }));
  assert.equal(hologramList.total, 18);
  assert.deepEqual(methods, [], 'protocol-error probes never reach the daemon');

  // ---------------------------------------------------------------------
  // Resources: read all four and assert their packaged content.
  // ---------------------------------------------------------------------

  const readResourceText = async (uri: string, expectedMime: string): Promise<string> => {
    const result = await client.readResource({ uri });
    const contents = result.contents as Array<{ uri: string; mimeType?: string; text?: string }>;
    assert.equal(contents.length, 1, `${uri} returns one content block`);
    assert.equal(contents[0].uri, uri);
    assert.equal(contents[0].mimeType, expectedMime);
    assert.equal(typeof contents[0].text, 'string');
    return contents[0].text as string;
  };

  const serverInfo = JSON.parse(await readResourceText('dero://mcp/server-info', 'application/json')) as Json;
  assert.equal(serverInfo.name, 'dero-daemon-mcp');
  assert.equal(serverInfo.mode, 'read-only');
  assert.equal(serverInfo.endpoint, `${process.env.DERO_DAEMON_URL}/json_rpc`, 'server points at the loopback daemon');
  assert.deepEqual((serverInfo.tools as string[]).slice().sort(), [...EXPECTED_TOOLS].sort());
  assert.deepEqual(serverInfo.resources, [...EXPECTED_RESOURCES]);
  assert.deepEqual(serverInfo.prompts, [...EXPECTED_PROMPTS]);

  const safety = JSON.parse(await readResourceText('dero://mcp/safety-boundary', 'application/json')) as Json;
  assert.equal(safety.read_only, true);
  assert.deepEqual(safety.excluded_methods, ['transfer', 'scinvoke', 'DERO.SendRawTransaction', 'DERO.SubmitBlock']);

  const flows = await readResourceText('dero://mcp/example-flows', 'text/markdown');
  assert.ok(flows.startsWith('# DERO MCP Example Flows'));
  assert.ok(flows.includes('diagnose_chain_health'));
  assert.ok(flows.includes('dero://mcp/safety-boundary'));

  const compositesResource = JSON.parse(await readResourceText('dero://mcp/composites', 'application/json')) as Json;
  const catalog = compositesResource.composites as Array<{ name: string; when_to_call: string; error_codes: string[] }>;
  assert.equal(catalog.length, 11);
  assert.deepEqual(catalog.map((entry) => entry.name).sort(), [...COMPOSITE_TOOLS].sort());
  assert.ok(catalog.every((entry) => entry.when_to_call.length > 0 && entry.error_codes.length > 0));

  // ---------------------------------------------------------------------
  // Prompts: get all five and assert their rendered messages.
  // ---------------------------------------------------------------------

  const promptText = async (name: string, args?: Record<string, string>): Promise<string> => {
    const result = await client.getPrompt({ name, arguments: args });
    assert.equal(result.messages.length, 1, `${name} renders one message`);
    assert.equal(result.messages[0].role, 'user');
    const content = result.messages[0].content as { type: string; text?: string };
    assert.equal(content.type, 'text');
    assert.equal(typeof content.text, 'string');
    return content.text as string;
  };

  const healthPrompt = await promptText('network_health_check', { reference_topoheight: '123456' });
  assert.ok(healthPrompt.includes('diagnose_chain_health'));
  assert.ok(healthPrompt.includes('reference_topoheight=123456'), 'string prompt argument is coerced to a number');

  const healthPromptNoRef = await promptText('network_health_check', {});
  assert.ok(healthPromptNoRef.includes('external comparison is still needed'));

  const scid = `${'0'.repeat(63)}1`;
  const inspectPrompt = await promptText('inspect_smart_contract', { scid });
  assert.ok(inspectPrompt.includes(`scid="${scid}"`));
  assert.ok(inspectPrompt.includes('explain_smart_contract'));

  const txHash = 'ab'.repeat(32);
  const tracePrompt = await promptText('trace_transaction', { tx_hash: txHash });
  assert.ok(tracePrompt.includes(`tx_hash="${txHash}"`));
  assert.ok(tracePrompt.includes('trace_transaction_with_context'));

  const docsPrompt = await promptText('find_dero_docs_for_intent', {
    intent: 'deploy a TELA app', product_hint: 'tela',
  });
  assert.ok(docsPrompt.includes('recommend_docs_path'));
  assert.ok(docsPrompt.includes('intent="deploy a TELA app"'));
  assert.ok(docsPrompt.includes('product_hint="tela"'));

  const deployPrompt = await promptText('estimate_deploy_for_contract', {
    sc_source: DVM_SOURCE, include_breakdown: 'false',
  });
  assert.ok(deployPrompt.includes('estimate_deploy_cost'));
  assert.ok(deployPrompt.includes('include_breakdown=false'));
  assert.ok(deployPrompt.includes(`Source (${DVM_SOURCE.length} chars)`));

  await assert.rejects(
    client.getPrompt({ name: 'network_health_check', arguments: { reference_topoheight: 'not-a-number' } }),
    /Invalid arguments for prompt network_health_check/,
    'non-numeric prompt argument is rejected by the schema'
  );

  assert.deepEqual(methods, [], 'resources and prompts are served without daemon calls');
} finally {
  await manager.shutdownAll();
  closeDb();
  await new Promise<void>((resolveClose, reject) => daemon.close((error) => error ? reject(error) : resolveClose()));
  rmSync(dataDir, { recursive: true, force: true });
}

process.exit(0);
