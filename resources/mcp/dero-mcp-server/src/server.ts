import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { deroJsonRpc, jsonRpcEndpoint } from './rpc.js'
import {
  DERO_DOC_PRODUCTS,
  getDeroDocPage,
  listDeroDocs,
  searchDeroDocs,
} from './docs.js'
import { DERO_TOOL_NAMES, TOOL_DESCRIPTIONS } from './tool-descriptions.js'
import { enrichWithFlaggedArtifacts, relatedDocsFor } from './citations.js'
import { decodeDeroBech32, interpretValueTransfer } from './proof-decode.js'
import {
  auditChainArtifactClaim,
  auditChainArtifactClaimInputSchema,
} from './composites/audit-chain-artifact-claim.js'
import {
  forgeDemoProof,
  forgeDemoProofInputSchema,
} from './composites/forge-demo-proof.js'
import {
  diagnoseChainHealth,
  diagnoseChainHealthInputSchema,
} from './composites/diagnose-chain-health.js'
import {
  explainSmartContract,
  explainSmartContractInputSchema,
} from './composites/explain-smart-contract.js'
import {
  recommendDocsPath,
  recommendDocsPathInputSchema,
} from './composites/recommend-docs-path.js'
import {
  estimateDeployCost,
  estimateDeployCostInputSchema,
} from './composites/estimate-deploy-cost.js'
import {
  traceTransactionWithContext,
  traceTransactionWithContextInputSchema,
} from './composites/trace-transaction-with-context.js'
import { capRawScVariables } from './composites/_shared.js'
import { telaInspect, telaInspectInputSchema } from './composites/tela-inspect.js'
import {
  telaGetDocContent,
  telaGetDocContentInputSchema,
} from './composites/tela-get-doc-content.js'
import {
  deroDurlToScid,
  deroDurlToScidInputSchema,
  deroTelaListApps,
  deroTelaListAppsInputSchema,
} from './composites/tela-discovery.js'

const scRpcArgSchema = z.object({
  name: z.string(),
  datatype: z.enum(['S', 'U', 'H']),
  value: z.union([z.string(), z.number()]),
})

const hex64Schema = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, 'Expected 64-character hex string')

const deroAddressSchema = z
  .string()
  .regex(/^(dero1|deto1)[0-9a-z]+$/i, 'Expected DERO address starting with dero1 or deto1')

const NAME_REGISTRY_SCID = '0000000000000000000000000000000000000000000000000000000000000001'

export const DERO_RESOURCE_URIS = [
  'dero://mcp/server-info',
  'dero://mcp/safety-boundary',
  'dero://mcp/example-flows',
  'dero://mcp/composites',
] as const

export const DERO_PROMPT_NAMES = [
  'network_health_check',
  'inspect_smart_contract',
  'trace_transaction',
  'find_dero_docs_for_intent',
  'estimate_deploy_for_contract',
] as const

const deroDocProductSchema = z.enum(DERO_DOC_PRODUCTS)

function toolText(data: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
      },
    ],
  }
}

type StructuredToolError = {
  code: string
  hint: string
  retryable: boolean
}

function classifyToolError(error: unknown): StructuredToolError {
  const message = error instanceof Error ? error.message : String(error)

  // Generic `INVALID_INPUT: <reason>` prefix used by composites that validate
  // their own argument shape (audit_chain_artifact_claim, dero_forge_demo_proof).
  // The composite's own `<reason>` is preserved verbatim in `_meta.error.raw`.
  if (message.startsWith('INVALID_INPUT:')) {
    return {
      code: 'INVALID_INPUT',
      hint: message.slice('INVALID_INPUT:'.length).trim() || 'Re-check the tool input shape against the tool description.',
      retryable: false,
    }
  }

  if (message.includes('Provide either hash or height')) {
    return {
      code: 'INVALID_INPUT',
      hint: 'Pass exactly one of "hash" or "height".',
      retryable: false,
    }
  }

  if (message.startsWith('INVALID_BECH32:')) {
    return {
      code: 'INVALID_BECH32',
      hint:
        'Confirm the string starts with one of dero/deto/deroi/detoi/deroproof, includes the "1" separator, and is uniformly cased (BIP-0173 forbids mixed case). See integrity/payload-vs-transaction-proofs for proof anatomy.',
      retryable: false,
    }
  }

  if (
    message.includes('DERO docs unavailable') ||
    message.includes('bundled docs index is missing')
  ) {
    return {
      code: 'DOCS_UNAVAILABLE',
      hint: 'Bundled docs index is missing from this install. Reinstall dero-mcp-server or set DERO_DOCS_ROOT for local dev override.',
      retryable: false,
    }
  }

  if (message.includes('DERO docs search requires a non-empty query')) {
    return {
      code: 'INVALID_INPUT',
      hint: 'Pass a non-empty "query" string for dero_docs_search.',
      retryable: false,
    }
  }

  if (message.includes('DERO docs get page requires a non-empty slug')) {
    return {
      code: 'INVALID_INPUT',
      hint: 'Pass a non-empty "slug" for dero_docs_get_page.',
      retryable: false,
    }
  }

  if (message.includes('Doc page not found')) {
    return {
      code: 'DOC_NOT_FOUND',
      hint: 'Use dero_docs_search or dero_docs_list to discover valid slugs, then retry.',
      retryable: false,
    }
  }

  if (message.includes('No DERO docs matched intent')) {
    return {
      code: 'NO_DOCS_MATCH',
      hint: 'Rephrase the intent (drop verbs, use product nouns like "TELA app" or "DVM contract"), then retry. You can also pass product_hint to bias the search.',
      retryable: false,
    }
  }

  if (message.includes('DERO transaction not found')) {
    return {
      code: 'TX_NOT_FOUND',
      hint: 'The daemon has no record of that tx hash on this chain. Verify the hash is correct (64 hex chars), check whether you queried the right network (mainnet vs testnet), and if the tx is freshly broadcast wait a few seconds for mempool propagation and retry.',
      retryable: true,
    }
  }

  if (message.includes('RPC error -32601')) {
    return {
      code: 'RPC_METHOD_NOT_FOUND',
      hint: 'Your daemon may be outdated or not a Stargate endpoint. Verify DERO_DAEMON_URL.',
      retryable: false,
    }
  }

  if (message.includes('RPC error -32602')) {
    return {
      code: 'RPC_INVALID_PARAMS',
      hint: 'Verify argument names and types for this tool.',
      retryable: false,
    }
  }

  if (message.includes('RPC error -32098')) {
    return {
      code: 'INVALID_INPUT',
      hint: 'The DVM compiler rejected the contract source. Inspect _meta.error.raw for the exact compile error (often points at a line, symbol, or missing keyword). Common causes: missing `End Function`, missing return type (`Uint64`/`String`), unbalanced parens, or sending a function body instead of a full contract.',
      retryable: false,
    }
  }

  const httpMatch = message.match(/HTTP (\d{3})/)
  if (httpMatch) {
    const status = Number(httpMatch[1])
    return {
      code: 'RPC_HTTP_ERROR',
      hint:
        status >= 500
          ? 'Daemon is reachable but errored; retry after checking node health.'
          : 'Check DERO_DAEMON_URL and ensure /json_rpc is accessible.',
      retryable: status >= 500,
    }
  }

  if (
    message.toLowerCase().includes('fetch failed') ||
    message.toLowerCase().includes('network') ||
    message.toLowerCase().includes('econnrefused') ||
    message.toLowerCase().includes('aborted')
  ) {
    return {
      code: 'RPC_UNREACHABLE',
      hint: 'Confirm daemon is running and reachable, then rerun `npm run doctor`.',
      retryable: true,
    }
  }

  if (message.includes('Invalid JSON from node')) {
    return {
      code: 'RPC_INVALID_RESPONSE',
      hint: 'Daemon returned malformed JSON. Check reverse proxies or node health.',
      retryable: true,
    }
  }

  return {
    code: 'TOOL_EXECUTION_ERROR',
    hint: 'Retry once, then inspect daemon logs and tool input values.',
    retryable: false,
  }
}

function toolError(tool: string, error: unknown) {
  const structured = classifyToolError(error)
  const raw = error instanceof Error ? error.message : String(error)
  // `isError: true` flags the failure at the protocol level so MCP hosts and
  // agent frameworks that branch on the flag (before parsing content) see the
  // call as failed. The ok:false/_meta.error JSON body is unchanged and
  // remains the source of the structured error code/hint.
  return {
    ...toolText({
      ok: false,
      tool,
      _meta: {
        error: {
          ...structured,
          raw,
        },
      },
    }),
    isError: true as const,
  }
}

function withStructuredErrors<TArgs extends Record<string, unknown> | undefined>(
  tool: string,
  handler: (args: TArgs) => Promise<unknown>,
) {
  return async (args: TArgs) => {
    try {
      return toolText(await handler(args))
    } catch (error) {
      return toolError(tool, error)
    }
  }
}

/**
 * MCP tool annotation hint block applied to every tool in this server.
 *
 * - `readOnlyHint: true` lets MCP hosts (Cursor, Claude Desktop, OpenCode)
 *   auto-approve calls without per-invocation confirmation.
 * - `destructiveHint: false` makes the read-only promise explicit so hosts
 *   render a safe-call badge.
 * - `idempotentHint: false` because chain state advances between calls —
 *   identical inputs may return different blocks/heights/tx pools.
 * - `openWorldHint: false` because we hit a configured daemon endpoint only,
 *   not arbitrary external services.
 *
 * Any future wallet/write tools MUST use a different annotation block
 * (`readOnlyHint: false`, `destructiveHint: true`) and remain require-approval.
 */
const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const

/**
 * Helper that tags a tool config with the read-only annotation block.
 * Use for every primitive in this v0.1 server. Composites built on these
 * primitives are also read-only and should use this same helper.
 */
function readOnly<T extends Record<string, unknown>>(
  config: T,
): T & { annotations: typeof READ_ONLY_ANNOTATIONS } {
  return { ...config, annotations: READ_ONLY_ANNOTATIONS }
}

export function createDeroMcpServer(daemonBaseUrl: string): McpServer {
  const endpoint = jsonRpcEndpoint(daemonBaseUrl)
  const rpc = async <T>(method: string, params?: unknown) =>
    deroJsonRpc<T>(endpoint, method, params)
  const server = new McpServer({
    name: 'dero-daemon-mcp',
    version: '0.4.8',
  })

  server.registerTool(
    'dero_daemon_ping',
    readOnly({
      description: TOOL_DESCRIPTIONS.dero_daemon_ping,
    }),
    withStructuredErrors('dero_daemon_ping', async () => rpc<string>('DERO.Ping')),
  )

  server.registerTool(
    'dero_daemon_echo',
    readOnly({
      description: TOOL_DESCRIPTIONS.dero_daemon_echo,
      inputSchema: {
        words: z.array(z.string()).describe('Strings to echo back'),
      },
    }),
    withStructuredErrors('dero_daemon_echo', async ({ words }) => rpc<string>('DERO.Echo', words)),
  )

  server.registerTool(
    'dero_get_info',
    readOnly({
      description: TOOL_DESCRIPTIONS.dero_get_info,
    }),
    withStructuredErrors('dero_get_info', async () => {
      const result = (await rpc<Record<string, unknown>>('DERO.GetInfo')) ?? {}
      const related_docs = relatedDocsFor('dero_get_info')
      return { ...result, ...(related_docs ? { related_docs } : {}) }
    }),
  )

  server.registerTool(
    'dero_get_height',
    readOnly({
      description: TOOL_DESCRIPTIONS.dero_get_height,
    }),
    withStructuredErrors('dero_get_height', async () => rpc('DERO.GetHeight')),
  )

  server.registerTool(
    'dero_get_block_count',
    readOnly({
      description: TOOL_DESCRIPTIONS.dero_get_block_count,
    }),
    withStructuredErrors('dero_get_block_count', async () => rpc('DERO.GetBlockCount')),
  )

  server.registerTool(
    'dero_get_last_block_header',
    readOnly({
      description: TOOL_DESCRIPTIONS.dero_get_last_block_header,
    }),
    withStructuredErrors('dero_get_last_block_header', async () => rpc('DERO.GetLastBlockHeader')),
  )

  server.registerTool(
    'dero_get_block',
    readOnly({
      description: TOOL_DESCRIPTIONS.dero_get_block,
      inputSchema: {
        hash: hex64Schema
          .optional()
          .describe('64-char hex block hash'),
        height: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe('Block height'),
      },
    }),
    withStructuredErrors('dero_get_block', async (args) => {
      if (!args.hash && args.height === undefined) {
        throw new Error('Provide either hash or height')
      }
      const params: Record<string, unknown> = {}
      if (args.hash) params.hash = args.hash
      if (args.height !== undefined) params.height = args.height
      const result = (await rpc<Record<string, unknown>>('DERO.GetBlock', params)) ?? {}
      const enrichment = enrichWithFlaggedArtifacts(
        { block_hash: args.hash },
        relatedDocsFor('dero_get_block'),
      )
      return { ...result, ...(enrichment ?? {}) }
    }),
  )

  server.registerTool(
    'dero_get_block_header_by_topo_height',
    readOnly({
      description: TOOL_DESCRIPTIONS.dero_get_block_header_by_topo_height,
      inputSchema: {
        topoheight: z
          .number()
          .int()
          .nonnegative()
          .describe('Topological height'),
      },
    }),
    withStructuredErrors('dero_get_block_header_by_topo_height', async ({ topoheight }) => {
      const result = (await rpc<Record<string, unknown>>('DERO.GetBlockHeaderByTopoHeight', { topoheight })) ?? {}
      const enrichment = enrichWithFlaggedArtifacts(
        { topoheight },
        relatedDocsFor('dero_get_block_header_by_topo_height'),
      )
      return { ...result, ...(enrichment ?? {}) }
    }),
  )

  server.registerTool(
    'dero_get_block_header_by_hash',
    readOnly({
      description: TOOL_DESCRIPTIONS.dero_get_block_header_by_hash,
      inputSchema: {
        hash: hex64Schema.describe('Block top hash (hex)'),
      },
    }),
    withStructuredErrors('dero_get_block_header_by_hash', async ({ hash }) => {
      const result = (await rpc<Record<string, unknown>>('DERO.GetBlockHeaderByHash', { hash })) ?? {}
      const enrichment = enrichWithFlaggedArtifacts(
        { block_hash: hash },
        relatedDocsFor('dero_get_block_header_by_hash'),
      )
      return { ...result, ...(enrichment ?? {}) }
    }),
  )

  server.registerTool(
    'dero_get_tx_pool',
    readOnly({
      description: TOOL_DESCRIPTIONS.dero_get_tx_pool,
    }),
    withStructuredErrors('dero_get_tx_pool', async () => rpc('DERO.GetTxPool')),
  )

  server.registerTool(
    'dero_get_random_address',
    readOnly({
      description: TOOL_DESCRIPTIONS.dero_get_random_address,
      inputSchema: {
        scid: hex64Schema
          .optional()
          .describe('Optional asset smart-contract id (hex)'),
      },
    }),
    withStructuredErrors('dero_get_random_address', async (args) =>
      rpc(
        'DERO.GetRandomAddress',
        args.scid != null ? { scid: args.scid } : undefined,
      )),
  )

  server.registerTool(
    'dero_get_transaction',
    readOnly({
      description: TOOL_DESCRIPTIONS.dero_get_transaction,
      inputSchema: {
        txs_hashes: z
          .array(hex64Schema)
          .min(1)
          .describe('List of transaction hashes (hex)'),
        decode_as_json: z
          .number()
          .int()
          .optional()
          .describe('Optional: decode each tx as JSON when non-zero'),
      },
    }),
    withStructuredErrors('dero_get_transaction', async ({ txs_hashes, decode_as_json }) => {
      const params: Record<string, unknown> = { txs_hashes }
      if (decode_as_json !== undefined) params.decode_as_json = decode_as_json
      const result = (await rpc<Record<string, unknown>>('DERO.GetTransaction', params)) ?? {}
      const enrichment = enrichWithFlaggedArtifacts(
        { tx_hashes: txs_hashes },
        relatedDocsFor('dero_get_transaction'),
      )
      return { ...result, ...(enrichment ?? {}) }
    }),
  )

  server.registerTool(
    'dero_get_encrypted_balance',
    readOnly({
      description: TOOL_DESCRIPTIONS.dero_get_encrypted_balance,
      inputSchema: {
        address: deroAddressSchema.describe('DERO address (dero1… or deto1…)'),
        topoheight: z
          .number()
          .int()
          .describe('Use -1 for latest chain tip'),
        scid: hex64Schema.optional().describe('Asset SCID hex; omit for native DERO'),
      },
    }),
    withStructuredErrors('dero_get_encrypted_balance', async ({ address, topoheight, scid }) => {
      const params: Record<string, unknown> = { address, topoheight }
      if (scid) params.scid = scid
      return rpc('DERO.GetEncryptedBalance', params)
    }),
  )

  server.registerTool(
    'dero_get_sc',
    readOnly({
      description: TOOL_DESCRIPTIONS.dero_get_sc,
      inputSchema: {
        scid: hex64Schema.describe('64-char hex Smart Contract ID'),
        code: z
          .boolean()
          .optional()
          .describe('Include contract source (default true)'),
        variables: z
          .boolean()
          .optional()
          .describe('Include stored variables (default true)'),
        topoheight: z
          .number()
          .int()
          .optional()
          .describe('Topo height; omit or use -1 for latest'),
      },
    }),
    withStructuredErrors('dero_get_sc', async ({ scid, code, variables, topoheight }) => {
      const params: Record<string, unknown> = {
        scid,
        code: code ?? true,
        variables: variables ?? true,
      }
      if (topoheight !== undefined) params.topoheight = topoheight
      const result = (await rpc<Record<string, unknown>>('DERO.GetSC', params)) ?? {}
      // Large registries (e.g. the name service's 22k+ stringkeys) would
      // overflow host token limits if returned verbatim; cap the raw maps and
      // mark what was elided. See capRawScVariables / SURFACE_KEY_CAP.
      capRawScVariables(result, 'stringkeys')
      capRawScVariables(result, 'uint64keys')
      const related_docs = relatedDocsFor('dero_get_sc')
      return { ...result, ...(related_docs ? { related_docs } : {}) }
    }),
  )

  server.registerTool(
    'dero_get_gas_estimate',
    readOnly({
      description: TOOL_DESCRIPTIONS.dero_get_gas_estimate,
      inputSchema: {
        transfers: z
          .array(z.record(z.unknown()))
          .optional()
          .describe('Optional transfer list'),
        sc: z.string().optional().describe('SC source to deploy'),
        sc_rpc: z
          .array(scRpcArgSchema)
          .optional()
          .describe('SC invocation arguments (entrypoint, SC_ID, etc.)'),
        signer: z
          .string()
          .optional()
          .describe('Signer address used for estimation'),
      },
    }),
    withStructuredErrors('dero_get_gas_estimate', async (args) => {
      const params: Record<string, unknown> = {}
      if (args.transfers) params.transfers = args.transfers
      if (args.sc) params.sc = args.sc
      if (args.sc_rpc) params.sc_rpc = args.sc_rpc
      if (args.signer) params.signer = args.signer
      const result = (await rpc<Record<string, unknown>>('DERO.GetGasEstimate', params)) ?? {}
      const related_docs = relatedDocsFor('dero_get_gas_estimate')
      return { ...result, ...(related_docs ? { related_docs } : {}) }
    }),
  )

  server.registerTool(
    'dero_name_to_address',
    readOnly({
      description: TOOL_DESCRIPTIONS.dero_name_to_address,
      inputSchema: {
        name: z.string().min(1).describe('Registered name'),
        topoheight: z
          .number()
          .int()
          .describe('Use -1 for latest'),
      },
    }),
    withStructuredErrors('dero_name_to_address', async ({ name, topoheight }) =>
      rpc('DERO.NameToAddress', { name, topoheight })),
  )

  server.registerTool(
    'dero_get_block_template',
    readOnly({
      description: TOOL_DESCRIPTIONS.dero_get_block_template,
      inputSchema: {
        wallet_address: deroAddressSchema.describe('Miner payout DERO address'),
        block: z
          .boolean()
          .optional()
          .describe('Include block blob'),
        miner: z.string().optional().describe('Optional miner id / label'),
      },
    }),
    withStructuredErrors('dero_get_block_template', async ({ wallet_address, block, miner }) => {
      const params: Record<string, unknown> = { wallet_address }
      if (block !== undefined) params.block = block
      if (miner) params.miner = miner
      return rpc('DERO.GetBlockTemplate', params)
    }),
  )

  server.registerTool(
    'dero_decode_proof_string',
    readOnly({
      description: TOOL_DESCRIPTIONS.dero_decode_proof_string,
      inputSchema: {
        proof_string: z
          .string()
          .min(8)
          .describe(
            'Full bech32 string with HRP, e.g. "deroproof1qyy…" or "dero1abc…". Whitespace is trimmed.',
          ),
      },
    }),
    withStructuredErrors('dero_decode_proof_string', async ({ proof_string }) => {
      let decoded: ReturnType<typeof decodeDeroBech32>
      try {
        decoded = decodeDeroBech32(proof_string)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`INVALID_BECH32: ${message}`)
      }
      const decodedJson = {
        hrp: decoded.hrp,
        mainnet: decoded.mainnet,
        is_proof: decoded.is_proof,
        public_key_hex: decoded.public_key_hex,
        arguments: decoded.arguments,
      }
      const value_interpretation =
        decoded.value_transfer_uint64 !== undefined
          ? interpretValueTransfer(decoded.value_transfer_uint64)
          : undefined
      // Try flagged-artifact enrichment first; fall back to the generic
      // per-tool related_docs when the input is not a known adversarial string.
      const enrichment = enrichWithFlaggedArtifacts(
        { proof_string },
        relatedDocsFor('dero_decode_proof_string'),
      )
      const baseline = enrichment
        ? enrichment
        : { related_docs: relatedDocsFor('dero_decode_proof_string') ?? [] }
      return {
        decoded: decodedJson,
        ...(value_interpretation ? { value_interpretation } : {}),
        ...(baseline.related_docs?.length ? { related_docs: baseline.related_docs } : {}),
        ...(enrichment ? { context_note: enrichment.context_note } : {}),
      }
    }),
  )

  server.registerTool(
    'dero_docs_search',
    readOnly({
      description: TOOL_DESCRIPTIONS.dero_docs_search,
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe('Search text (e.g., "wallet rpc", "tela deployment", "deropay webhooks")'),
        product: deroDocProductSchema
          .optional()
          .describe('Optional docs product filter: derod | tela | hologram | deropay'),
        section: z
          .string()
          .optional()
          .describe('Optional section slug prefix (e.g., "rpc-api", "guides", "dero-pay")'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(25)
          .optional()
          .describe('Max matches (default 8, max 25)'),
      },
    }),
    withStructuredErrors('dero_docs_search', async ({ query, product, section, limit }) =>
      searchDeroDocs({ query, product, section, limit })),
  )

  server.registerTool(
    'dero_docs_get_page',
    readOnly({
      description: TOOL_DESCRIPTIONS.dero_docs_get_page,
      inputSchema: {
        slug: z
          .string()
          .min(1)
          .describe(
            'Doc slug relative to pages/ (e.g., "rpc-api/daemon-rpc-api", "tutorials/first-app", "dero-pay/quick-start")',
          ),
        product: deroDocProductSchema
          .optional()
          .describe('Optional product scope to disambiguate duplicate slugs'),
        offset: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            'Byte offset into the page plaintext. Use 0 (or omit) for the first chunk; pass next_offset from a prior response to continue reading a long page.',
          ),
      },
    }),
    withStructuredErrors('dero_docs_get_page', async ({ slug, product, offset }) =>
      getDeroDocPage({ slug, product, offset })),
  )

  server.registerTool(
    'dero_docs_list',
    readOnly({
      description: TOOL_DESCRIPTIONS.dero_docs_list,
      inputSchema: {
        product: deroDocProductSchema
          .optional()
          .describe('Optional docs product filter: derod | tela | hologram | deropay'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe('Max pages returned (default 120, max 500)'),
      },
    }),
    withStructuredErrors('dero_docs_list', async ({ product, limit }) => {
      const docsIndex = await listDeroDocs(product)
      const capped = Math.max(1, Math.min(limit ?? 120, 500))
      return {
        ...docsIndex,
        returned: Math.min(capped, docsIndex.pages.length),
        pages: docsIndex.pages.slice(0, capped),
      }
    }),
  )

  // ---------- Composite tools (Phase C) ----------
  // Composites chain read-only primitives and bundled docs into
  // intent-shaped responses. Each composite has a maintainer design contract
  // (input schema, internal chain, response shape, failure modes, flow test ID).

  server.registerTool(
    'diagnose_chain_health',
    readOnly({
      description: TOOL_DESCRIPTIONS.diagnose_chain_health,
      inputSchema: diagnoseChainHealthInputSchema,
    }),
    withStructuredErrors('diagnose_chain_health', async (args) =>
      diagnoseChainHealth(rpc, args ?? {}),
    ),
  )

  server.registerTool(
    'explain_smart_contract',
    readOnly({
      description: TOOL_DESCRIPTIONS.explain_smart_contract,
      inputSchema: explainSmartContractInputSchema,
    }),
    withStructuredErrors('explain_smart_contract', async (args) =>
      explainSmartContract(rpc, args),
    ),
  )

  server.registerTool(
    'tela_inspect',
    readOnly({
      description: TOOL_DESCRIPTIONS.tela_inspect,
      inputSchema: telaInspectInputSchema,
    }),
    withStructuredErrors('tela_inspect', async (args) => telaInspect(rpc, args)),
  )

  server.registerTool(
    'tela_get_doc_content',
    readOnly({
      description: TOOL_DESCRIPTIONS.tela_get_doc_content,
      inputSchema: telaGetDocContentInputSchema,
    }),
    withStructuredErrors('tela_get_doc_content', async (args) => telaGetDocContent(rpc, args)),
  )

  server.registerTool(
    'dero_durl_to_scid',
    readOnly({
      description: TOOL_DESCRIPTIONS.dero_durl_to_scid,
      inputSchema: deroDurlToScidInputSchema,
    }),
    withStructuredErrors('dero_durl_to_scid', async (args) => deroDurlToScid(rpc, args)),
  )

  server.registerTool(
    'dero_tela_list_apps',
    readOnly({
      description: TOOL_DESCRIPTIONS.dero_tela_list_apps,
      inputSchema: deroTelaListAppsInputSchema,
    }),
    withStructuredErrors('dero_tela_list_apps', async (args) => deroTelaListApps(rpc, args)),
  )

  server.registerTool(
    'recommend_docs_path',
    readOnly({
      description: TOOL_DESCRIPTIONS.recommend_docs_path,
      inputSchema: recommendDocsPathInputSchema,
    }),
    withStructuredErrors('recommend_docs_path', async (args) => recommendDocsPath(args)),
  )

  server.registerTool(
    'estimate_deploy_cost',
    readOnly({
      description: TOOL_DESCRIPTIONS.estimate_deploy_cost,
      inputSchema: estimateDeployCostInputSchema,
    }),
    withStructuredErrors('estimate_deploy_cost', async (args) => estimateDeployCost(rpc, args)),
  )

  server.registerTool(
    'trace_transaction_with_context',
    readOnly({
      description: TOOL_DESCRIPTIONS.trace_transaction_with_context,
      inputSchema: traceTransactionWithContextInputSchema,
    }),
    withStructuredErrors('trace_transaction_with_context', async (args) =>
      traceTransactionWithContext(rpc, args),
    ),
  )

  server.registerTool(
    'audit_chain_artifact_claim',
    readOnly({
      description: TOOL_DESCRIPTIONS.audit_chain_artifact_claim,
      inputSchema: auditChainArtifactClaimInputSchema,
    }),
    withStructuredErrors('audit_chain_artifact_claim', async (args) =>
      auditChainArtifactClaim(rpc, args ?? {}),
    ),
  )

  server.registerTool(
    'dero_forge_demo_proof',
    readOnly({
      description: TOOL_DESCRIPTIONS.dero_forge_demo_proof,
      inputSchema: forgeDemoProofInputSchema,
    }),
    withStructuredErrors('dero_forge_demo_proof', async (args) =>
      forgeDemoProof(rpc, args ?? {}),
    ),
  )

  server.registerResource(
    'dero_mcp_server_info',
    'dero://mcp/server-info',
    {
      description: 'Server metadata, tool list, resource list, and prompt names.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.toString(),
          mimeType: 'application/json',
          text: JSON.stringify(
            {
              name: 'dero-daemon-mcp',
              version: '0.4.8',
              mode: 'read-only',
              endpoint: endpoint,
              docs_products: DERO_DOC_PRODUCTS,
              docs_delivery: 'bundled-index',
              docs_dev_override_env: 'DERO_DOCS_ROOT',
              tools: DERO_TOOL_NAMES,
              resources: DERO_RESOURCE_URIS,
              prompts: DERO_PROMPT_NAMES,
            },
            null,
            2,
          ),
        },
      ],
    }),
  )

  server.registerResource(
    'dero_mcp_safety_boundary',
    'dero://mcp/safety-boundary',
    {
      description: 'Explicit read-only safety boundaries and escalation guidance for write actions.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.toString(),
          mimeType: 'application/json',
          text: JSON.stringify(
            {
              read_only: true,
              excluded_methods: [
                'transfer',
                'scinvoke',
                'DERO.SendRawTransaction',
                'DERO.SubmitBlock',
              ],
              reasoning: 'These methods can move funds or mutate chain state.',
              write_path: [
                'Use wallet RPC tooling (curl/XSWD/Engram) for writes.',
                'Use dero-mcp-server for live chain reads and analysis.',
              ],
            },
            null,
            2,
          ),
        },
      ],
    }),
  )

  server.registerResource(
    'dero_mcp_example_flows',
    'dero://mcp/example-flows',
    {
      description: 'Compact agent flow recipes for common DERO investigations. Composites are listed FIRST; primitives are the fallback path.',
      mimeType: 'text/markdown',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.toString(),
          mimeType: 'text/markdown',
          text: [
            '# DERO MCP Example Flows',
            '',
            'Prefer composites — each is one call replacing a primitive chain, and each returns a narrative + curated docs citations.',
            '',
            '## Composites (preferred)',
            '',
            '- **Network health**: call `diagnose_chain_health` (no args). Returns narrative + signals + citations in one shot.',
            `- **Inspect a contract**: call \`explain_smart_contract\` with the SCID. For example, the name registry: \`${NAME_REGISTRY_SCID}\`.`,
            '- **Trace a transaction**: call `trace_transaction_with_context` with the tx_hash. Handles SC install surface extraction inline.',
            '- **Find the right docs**: call `recommend_docs_path` with a natural-language intent (e.g. "deploy a TELA app"). Optional `product_hint` biases the score 1.5x toward that product.',
            '- **Pre-flight a deploy**: call `estimate_deploy_cost` with the DVM-BASIC source. Returns gas estimate + plain-text breakdown + parsed surface.',
            '',
            '## Primitive fallback paths (only when a composite is unavailable or returns _meta.error)',
            '',
            '- Network: `dero_daemon_ping` → `dero_get_info` → `dero_get_height` → `dero_get_tx_pool`',
            '- Contract: `dero_get_sc` (code=true, variables=true) then optionally `dero_docs_get_page`',
            '- Transaction: `dero_get_transaction` (decode_as_json=1) — does NOT decode SC invocation args',
            '- Docs: `dero_docs_search` (then `dero_docs_get_page` for full text)',
            '- Deploy estimate: `dero_get_gas_estimate`',
            '',
            '## Structured error codes (`_meta.error.code`) the agent should react to',
            '',
            '- `NO_DOCS_MATCH` (recommend_docs_path): rephrase the intent, retry. Not a hard failure.',
            '- `INVALID_INPUT` (estimate_deploy_cost): the daemon\'s raw -32098 compile message is in `_meta.error.raw`; surface it to the user.',
            '- `TX_NOT_FOUND` (trace_transaction_with_context): the daemon returned an empty record. Retryable=true (mempool propagation), but only after verifying the hash and network.',
            '',
            '## Read-only boundary',
            '',
            'No wallet writes. No raw tx submission. No contract invocation. See `dero://mcp/safety-boundary` and `dero://mcp/composites` for the full posture.',
          ].join('\n'),
        },
      ],
    }),
  )

  server.registerResource(
    'dero_mcp_composites',
    'dero://mcp/composites',
    {
      description: 'Catalog of the 11 composite tools — what each replaces, when to call it, what it returns, and which structured _meta.error codes it can emit. Read this when picking between a composite and a primitive.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.toString(),
          mimeType: 'application/json',
          text: JSON.stringify(
            {
              version: 1,
              note: 'Composites fuse one or more daemon-read primitives with bundled-docs lookups and emit a single narrative + curated related_docs. Always prefer the composite when its intent matches the user request.',
              composites: [
                {
                  name: 'diagnose_chain_health',
                  replaces: ['dero_daemon_ping', 'dero_get_info', 'dero_get_height', 'dero_get_tx_pool'],
                  when_to_call: 'User asks "is the chain healthy", "are we synced", "what is the network state", or any general daemon-status question.',
                  inputs: { include_tx_pool: 'optional boolean, default true' },
                  output_highlights: ['status (healthy | degraded | unreachable)', 'signals (e.g. healthy, stale-tip, lagging)', 'tip metadata', 'narrative', 'related_docs'],
                  error_codes: ['RPC_UNREACHABLE'],
                },
                {
                  name: 'explain_smart_contract',
                  replaces: ['dero_get_sc + manual parsing + dero_docs_search'],
                  when_to_call: 'User wants to UNDERSTAND a contract (functions, state shape, what DVM concept to read about). NOT for raw variable inspection — use dero_get_sc for that.',
                  inputs: { scid: '64-char hex SCID', topoheight: 'optional number' },
                  output_highlights: ['kind (tela_index | tela_doc | token | registry | minimal | generic)', 'surface (functions, stringkeys, uint64keys, balances)', 'narrative', '1-4 curated docs citations re-ranked for the contract pattern (TELA contracts cite the TELA spec)'],
                  error_codes: ['RPC_UNREACHABLE', 'RPC_INVALID_PARAMS'],
                },
                {
                  name: 'recommend_docs_path',
                  replaces: ['4x parallel dero_docs_search calls + manual ranking'],
                  when_to_call: 'User has a natural-language intent ("deploy a TELA app", "estimate gas") and needs to know which doc page to read. Bias-not-filter on product_hint.',
                  inputs: { intent: 'short natural-language string', product_hint: 'optional derod | tela | hologram | deropay', limit_per_product: 'optional number, default 2' },
                  output_highlights: ['recommended[] with score/boosted_score/rationale', 'summary_by_product', 'related_docs'],
                  error_codes: ['NO_DOCS_MATCH'],
                },
                {
                  name: 'estimate_deploy_cost',
                  replaces: ['dero_get_gas_estimate + manual surface extraction + manual interpretation of gascompute/gasstorage'],
                  when_to_call: 'User wants to deploy a contract and needs to know what it will cost. Read-only; nothing is submitted.',
                  inputs: { sc: 'DVM-BASIC source string', include_breakdown: 'optional boolean, default true' },
                  output_highlights: ['estimate (gascompute, gasstorage, total, status)', 'breakdown (compute_note, storage_note) | null', 'surface (functions, stringkeys, uint64keys)'],
                  error_codes: ['INVALID_INPUT (wraps daemon -32098 DVM compile errors; raw message in _meta.error.raw)', 'RPC_UNREACHABLE'],
                },
                {
                  name: 'trace_transaction_with_context',
                  replaces: ['dero_get_transaction + (for SC installs) dero_get_sc + manual classification'],
                  when_to_call: 'User asks "what is this tx", "is this confirmed", "what contract did this deploy", "what does this tx do".',
                  inputs: { tx_hash: '64-char hex', decode: 'optional boolean, default true', include_sc_context: 'optional boolean, default true' },
                  output_highlights: ['confirmation (status, block_height, valid_block, in_pool)', 'kind (sc_install | transfer_or_invocation | coinbase | unknown)', 'ring (groups, first_group_size)', 'sc_install (scid + parsed surface) | null', 'raw_tx_hex_length', 'narrative', 'related_docs'],
                  scope_note: 'SC invocation arg decoding is NOT performed (would require the binary tx codec). SC INSTALL surface extraction IS performed inline because the source is embedded in the tx record.',
                  error_codes: ['TX_NOT_FOUND (retryable=true; daemon returns empty record on unknown hashes)', 'RPC_UNREACHABLE'],
                },
                {
                  name: 'audit_chain_artifact_claim',
                  replaces: ['dero_get_info / dero_get_last_block_header / dero_decode_proof_string + manual claim verification'],
                  when_to_call: 'User asks to verify a chain-related claim end-to-end (e.g. the 2022 inflation claim) with cited daemon state and docs.',
                  inputs: { claim: 'claim text', include_forge_demo: 'optional boolean' },
                  output_highlights: ['verdict', 'cited daemon state', 'optional forged demo proof', 'related_docs'],
                  error_codes: ['INVALID_INPUT', 'RPC_UNREACHABLE'],
                },
                {
                  name: 'dero_forge_demo_proof',
                  replaces: ['manual bn254 + CBOR + bech32 proof-string construction'],
                  when_to_call: 'Generate a demo (display-layer) deroproof string for testing/teaching; never broadcasts or touches a wallet.',
                  inputs: { target_amount: 'optional', tx_hex: 'optional (max 100k)' },
                  output_highlights: ['forged_proof_string', 'self_check (verified)', 'context_note', 'related_docs'],
                  error_codes: ['INVALID_INPUT'],
                },
                {
                  name: 'tela_inspect',
                  replaces: ['dero_get_sc + manual TELA-INDEX-1/DOC-1 schema parsing'],
                  when_to_call: 'User references a TELA SCID or .tela app: "what is this TELA contract/app", "what files does it have", "is it an INDEX or DOC". Auto-detects the standard; reads RAW stringkeys so all DOCn enumerate (bypasses the 50-key surface cap).',
                  inputs: { scid: '64-char hex SCID', topoheight: 'optional number' },
                  output_highlights: ['kind (tela_index | tela_doc | not_tela)', 'index { name, durl, mods[], docs[], commit, version_history[] } | doc { filename, doc_type, signature, content_embedded }', 'narrative', 'related_docs'],
                  scope_note: 'Updateability/ringsize is NOT in DERO.GetSC, so it is honestly reported as unknown. not_tela is a SUCCESS (not an error) for non-TELA SCIDs.',
                  error_codes: ['RPC_UNREACHABLE', 'RPC_INVALID_PARAMS'],
                },
                {
                  name: 'tela_get_doc_content',
                  replaces: ['dero_get_sc + manual comment-block extraction from the contract code'],
                  when_to_call: 'User wants the actual file content (HTML/CSS/JS) a TELA-DOC-1 stores. Get DOC SCIDs from tela_inspect on an INDEX first.',
                  inputs: { scid: '64-char hex DOC SCID', offset: 'optional number (paginate large files)', topoheight: 'optional number' },
                  output_highlights: ['content (60k-char chunk; paginate via next_offset; .gz transparently decompressed)', 'filename, doc_type, sub_dir', 'compressed/decompressed flags', 'signature (presence only, not verified)', 'related_docs'],
                  error_codes: ['INVALID_INPUT (SCID is not a TELA-DOC-1; hint points to tela_inspect)', 'RPC_UNREACHABLE'],
                },
                {
                  name: 'dero_durl_to_scid',
                  replaces: ['running a separate Gnomon indexer to resolve a dURL to a SCID'],
                  when_to_call: 'User asks "what is the SCID for vault.tela" or gives a .tela dURL. For a registered NAME like "quickbrownfox" (no dot) use dero_name_to_address instead.',
                  inputs: { durl: 'TELA dURL e.g. "vault.tela" or "dero://feed.tela"' },
                  output_highlights: ['scid + primary { durl, name, install_height, doc_count }', 'collision + other_candidates[] when a dURL is non-unique (newest = primary)', 'found:false + hint on miss'],
                  scope_note: 'First call runs a ~10s in-process discovery scan of the newest chain contracts (cached after). dURLs are NOT unique — newest is primary, others disclosed.',
                  error_codes: ['RPC_UNREACHABLE'],
                },
                {
                  name: 'dero_tela_list_apps',
                  replaces: ['running a separate Gnomon indexer to browse TELA apps'],
                  when_to_call: 'User wants to explore/search what TELA apps exist on-chain, or find a SCID without knowing the exact dURL.',
                  inputs: { query: 'optional case-insensitive filter on durl/name', limit: 'optional number, default 50, max 200' },
                  output_highlights: ['apps[] { scid, durl, name, install_height, doc_count }', 'index_meta (apps_indexed, scanned_scids, registry_total, newest_height) for coverage transparency'],
                  error_codes: ['RPC_UNREACHABLE'],
                },
              ],
            },
            null,
            2,
          ),
        },
      ],
    }),
  )

  server.registerPrompt(
    'network_health_check',
    {
      description: 'Guide the model through a DERO daemon sync and health check using the diagnose_chain_health composite.',
      argsSchema: {
        // MCP prompt arguments arrive as strings (the SDK validates raw
        // string values against this schema with no coercion), so a plain
        // z.number() can never validate. Coerce the string to a number here.
        reference_topoheight: z.coerce
          .number()
          .int()
          .positive()
          .optional(),
      },
    },
    async ({ reference_topoheight }) => ({
      description: 'Prompt for sync health investigation (composite-first).',
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              'Check DERO daemon health using the MCP composite tools (one call replaces the old four-step chain).',
              '',
              '1) Call diagnose_chain_health with no arguments (or include_tx_pool=true if you specifically want mempool counts).',
              '2) Read the returned narrative aloud; it already summarizes ping latency, topoheight, stableheight, version, network, and mempool state.',
              '3) Inspect signals (e.g. "healthy", "stale-tip", "lagging") and surface any that are not "healthy".',
              '4) Quote the related_docs citations so the user knows where to read further.',
              reference_topoheight
                ? `5) Compare the returned topoheight against reference_topoheight=${reference_topoheight} and report the delta.`
                : '5) If no reference topoheight was provided, state that external comparison is still needed for final sync confidence.',
              '',
              'Fallback: only chain primitives manually (dero_daemon_ping → dero_get_info → dero_get_height → dero_get_tx_pool) if diagnose_chain_health is unavailable or returns _meta.error.',
            ].join('\n'),
          },
        },
      ],
    }),
  )

  server.registerPrompt(
    'inspect_smart_contract',
    {
      description: 'Inspect a DERO contract via the explain_smart_contract composite (function surface + classification + curated DVM docs).',
      argsSchema: {
        scid: hex64Schema,
      },
    },
    async ({ scid }) => ({
      description: 'Prompt for smart contract inspection (composite-first).',
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Investigate DERO smart contract ${scid} using the MCP composite tools.`,
              '',
              `1) Call explain_smart_contract with scid="${scid}". This single call returns the parsed function surface, a contract kind classification (token | registry | minimal | generic), a plain-language narrative, and 1-4 DVM docs citations ranked for the contract pattern.`,
              '2) Quote the narrative as-is — it already explains the likely data model, state keys, and where to read next.',
              '3) If the user wants raw state (variable values, balances), THEN call dero_get_sc with variables=true and code=true as a follow-up; explain why you needed the second call.',
              '4) If you want documentation for a DVM concept the contract uses, call dero_docs_get_page with the slug from one of the related_docs entries.',
              '',
              'Fallback: call dero_get_sc manually only if explain_smart_contract is unavailable or returns _meta.error.',
            ].join('\n'),
          },
        },
      ],
    }),
  )

  server.registerPrompt(
    'trace_transaction',
    {
      description: 'Trace one transaction via the trace_transaction_with_context composite (confirmation + kind classification + SC install surface).',
      argsSchema: {
        tx_hash: hex64Schema,
      },
    },
    async ({ tx_hash }) => ({
      description: 'Prompt for transaction tracing (composite-first).',
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Trace DERO transaction ${tx_hash} using the MCP composite tools.`,
              '',
              `1) Call trace_transaction_with_context with tx_hash="${tx_hash}". The response gives you confirmation status (confirmed | mempool | unknown), block height + valid_block, kind classification (sc_install | transfer_or_invocation | coinbase | unknown), ring stats, and — if the tx is a contract install — the parsed function surface inline (no second call needed).`,
              '2) Read the returned narrative aloud. Quote the related_docs citations.',
              '3) If confirmation is "mempool", explicitly note that the result is provisional and tell the user when to retry.',
              '4) If _meta.error.code is TX_NOT_FOUND, do NOT retry blindly — verify the hash, confirm the network (mainnet vs testnet), and only retry if the tx was just broadcast.',
              '5) Note: SC invocation arg decoding is NOT performed by the composite (would require the binary tx codec). If the tx is a non-install SC call and the user needs the entrypoint + args, surface that limitation and suggest a wallet-side decoder.',
              '',
              'Fallback: call dero_get_transaction manually only if trace_transaction_with_context is unavailable or returns an unhandled _meta.error.',
            ].join('\n'),
          },
        },
      ],
    }),
  )

  server.registerPrompt(
    'find_dero_docs_for_intent',
    {
      description: 'Find the right DERO documentation page(s) for a natural-language intent via the recommend_docs_path composite.',
      argsSchema: {
        intent: z.string().min(3, 'Provide a short intent like "deploy a TELA app" or "estimate gas"'),
        product_hint: z.enum(DERO_DOC_PRODUCTS).optional(),
      },
    },
    async ({ intent, product_hint }) => ({
      description: 'Prompt for routing an agent intent to the right DERO docs.',
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Find the best DERO documentation page(s) for the intent: "${intent}".`,
              '',
              `1) Call recommend_docs_path with intent="${intent}"${product_hint ? `, product_hint="${product_hint}" (this biases the score 1.5x toward that product; it does NOT filter the other three out)` : ' (no product_hint — all four DERO products will be searched in parallel)'}.`,
              '2) Read the top 2-3 recommendations to the user with their rationale strings; quote the canonical URLs.',
              '3) If the user wants the full content of any page, call dero_docs_get_page with the slug + product from the recommendation.',
              '4) If _meta.error.code is NO_DOCS_MATCH, rephrase the intent (drop verbs, use product nouns like "TELA app" or "DVM contract") and call again. Do NOT just give up.',
              '',
              'Prefer this composite over chaining dero_docs_search yourself across four products.',
            ].join('\n'),
          },
        },
      ],
    }),
  )

  server.registerPrompt(
    'estimate_deploy_for_contract',
    {
      description: 'Run gas pre-flight for a DVM-BASIC contract source via the estimate_deploy_cost composite (numeric estimate + plain-text breakdown + parsed surface).',
      argsSchema: {
        sc_source: z.string().min(20, 'Provide DVM-BASIC contract source (at minimum: a Function/End Function block)'),
        // Prompt arguments are always strings, so a z.boolean() can never
        // validate. Accept the string 'true' | 'false' and interpret below.
        include_breakdown: z.enum(['true', 'false']).optional(),
      },
    },
    async ({ sc_source, include_breakdown }) => ({
      description: 'Prompt for DVM deploy pre-flight (composite-first).',
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              'Run a deploy pre-flight (gas estimate) for the DVM-BASIC source the user supplied. This is read-only; nothing is submitted to chain.',
              '',
              `1) Call estimate_deploy_cost with the contract source as sc${include_breakdown === 'false' ? ' and include_breakdown=false (caller does NOT want the plain-text gas notes)' : ' (include_breakdown defaults to true)'}.`,
              '2) Quote estimate.gascompute, estimate.gasstorage, estimate.total, and the daemon\'s status string.',
              '3) If include_breakdown is true, read the breakdown.compute_note and breakdown.storage_note as plain-language explanations.',
              '4) Quote the parsed function surface (functions[].name) so the user can sanity-check the contract.',
              '5) If _meta.error.code is INVALID_INPUT, read the hint and the raw -32098 compile message from _meta.error.raw verbatim — that tells the user what to fix in the source.',
              '',
              `Source (${sc_source.length} chars) starts with: ${sc_source.slice(0, 120)}${sc_source.length > 120 ? '...' : ''}`,
              '',
              'Fallback: call dero_get_gas_estimate manually only if estimate_deploy_cost is unavailable.',
            ].join('\n'),
          },
        },
      ],
    }),
  )

  return server
}
