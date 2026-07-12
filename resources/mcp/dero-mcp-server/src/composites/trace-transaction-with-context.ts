/**
 * `trace_transaction_with_context` — Phase C composite #5 (final).
 *
 * Wedge: `dero_get_transaction` returns the raw tx record (block,
 * ring, signer, code, balances) but leaves the agent to figure out
 * confirmation state, classify the tx kind, and separately fetch
 * any SC context. This composite combines all of that in one call
 * and stitches the right docs page as a citation.
 *
 * Design contract § 5. Sequencing rule: SHIP
 * LAST — highest fan-out + failure-mode count of all Phase C
 * composites.
 *
 * Implementation notes (recorded honestly so the design doc and
 * shipped surface stay in sync):
 *
 *   - SC INSTALL detection works directly off the tx record: when
 *     `tx.code` is non-empty the tx_hash itself IS the resulting
 *     SCID and the embedded code is the deployed source. We run
 *     `extractScSurface` on `tx.code` directly — no second
 *     `DERO.GetSC` call is needed for installs.
 *   - SC INVOCATION arg/entrypoint decoding requires walking the
 *     binary tx blob (`txs_as_hex`) with DERO's tx codec. That
 *     codec is not yet bundled in this MCP, so the composite does
 *     NOT fabricate decoded args. It surfaces `raw_tx_hex_length`
 *     so the agent knows the binary is available via
 *     `dero_get_transaction` if a downstream wallet wants to
 *     decode it.
 *   - TX_NOT_FOUND is signalled by the daemon as an EMPTY record
 *     (`block_height: 0, in_pool: false, code: ''`) — it does
 *     not throw. The composite detects this and throws a
 *     classifier-friendly message so `withStructuredErrors`
 *     surfaces `_meta.error.code = TX_NOT_FOUND`.
 *
 * Failure model:
 *   - `DERO.GetTransaction` throws → propagates via
 *     `withStructuredErrors` (RPC_UNREACHABLE / RPC_INVALID_PARAMS
 *     classifier branches handle the daemon-side cases).
 *   - Daemon returns empty record for the hash → composite throws
 *     `'DERO transaction not found: ...'` → classifier returns
 *     `TX_NOT_FOUND` with a retry hint.
 *   - Tx found but SC surface extraction degraded for the install
 *     case → record the surface as-is (`has_code: false`,
 *     `functions: []`) and let the narrative explain. Never abort.
 */

import { z } from 'zod'
import {
  attachCitations,
  extractScSurface,
  runChain,
  stepLatencies,
  stepValue,
  type ChainStep,
  type DeroDaemonRpc,
  type DeroScSurface,
} from './_shared.js'

const HEX64_REGEX = /^[0-9a-fA-F]{64}$/
const NATIVE_DERO_SCID = '0000000000000000000000000000000000000000000000000000000000000000'

export const traceTransactionWithContextInputSchema = {
  tx_hash: z
    .string()
    .regex(HEX64_REGEX, 'Expected 64-character hex transaction hash')
    .describe('64-char hex transaction hash'),
  decode: z
    .boolean()
    .optional()
    .describe('Pass decode_as_json=1 to the daemon. Default true. Decoded JSON view is informational; the raw hex always comes back.'),
  include_sc_context: z
    .boolean()
    .optional()
    .describe(
      'When true (default), runs the SC-install surface extraction inline when the tx contains contract code. SC invocation arg decoding is NOT performed in either mode; see module docs.',
    ),
} as const

type TraceInput = {
  tx_hash: string
  decode?: boolean
  include_sc_context?: boolean
}

type RingArrayShape = unknown[]

type DeroTxRecord = {
  tx_hash?: string
  block_height?: number
  in_pool?: boolean
  valid_block?: string
  invalid_block?: string[] | null
  ring?: RingArrayShape[]
  signer?: string
  code?: string
  codenow?: string
  balance?: number
  balancenow?: number
  reward?: number
  ignored?: boolean
  output_indices?: unknown
  as_hex?: string
  [k: string]: unknown
}

type DeroGetTransactionResult = {
  txs_as_hex?: string[]
  txs?: DeroTxRecord[]
  status?: string
}

type ConfirmationStatus = 'confirmed' | 'mempool' | 'unknown'
type TxKind = 'sc_install' | 'transfer_or_invocation' | 'coinbase' | 'unknown'

function classifyConfirmation(tx: DeroTxRecord): ConfirmationStatus {
  if (tx.in_pool === true) return 'mempool'
  if (typeof tx.block_height === 'number' && tx.block_height > 0) return 'confirmed'
  return 'unknown'
}

function classifyKind(tx: DeroTxRecord): TxKind {
  if (typeof tx.code === 'string' && tx.code.length > 0) return 'sc_install'
  if (typeof tx.reward === 'number' && tx.reward > 0 && (!tx.ring || tx.ring.length === 0)) {
    return 'coinbase'
  }
  if (Array.isArray(tx.ring) && tx.ring.length > 0) return 'transfer_or_invocation'
  return 'unknown'
}

function ringStats(tx: DeroTxRecord): { groups: number | null; first_group_size: number | null } {
  if (!Array.isArray(tx.ring) || tx.ring.length === 0) {
    return { groups: null, first_group_size: null }
  }
  const groups = tx.ring.length
  const first = tx.ring[0]
  const firstSize = Array.isArray(first) ? first.length : null
  return { groups, first_group_size: firstSize }
}

function isEmptyTxRecord(tx: DeroTxRecord | undefined): boolean {
  if (!tx) return true
  const noBlock = !tx.block_height || tx.block_height === 0
  const noPool = tx.in_pool !== true
  const noCode = !tx.code || tx.code.length === 0
  const noRing = !Array.isArray(tx.ring) || tx.ring.length === 0
  return noBlock && noPool && noCode && noRing
}

function buildNarrative(
  txHash: string,
  confirmation: ConfirmationStatus,
  kind: TxKind,
  blockHeight: number | null,
  scInstallSurface: DeroScSurface | null,
  ringGroups: number | null,
  rawHexLen: number,
  scLookupFailed: boolean,
): string {
  const parts: string[] = []

  if (confirmation === 'mempool') {
    parts.push(`Tx ${txHash} is in the mempool (not yet confirmed). It may still be reorganized or dropped; treat the result as provisional.`)
  } else if (confirmation === 'confirmed') {
    parts.push(`Tx ${txHash} is confirmed at block height ${blockHeight ?? 'unknown'}.`)
  } else {
    parts.push(`Tx ${txHash} confirmation status is unknown — the daemon returned a record but did not mark it confirmed or in mempool.`)
  }

  if (kind === 'sc_install') {
    if (scInstallSurface && scInstallSurface.has_code) {
      const fnCount = scInstallSurface.functions.length
      const sampleFns = scInstallSurface.functions
        .slice(0, 4)
        .map((f) => f.name)
        .join(', ')
      parts.push(
        `Tx is a smart-contract INSTALL: the tx_hash is the resulting SCID. The deployed source carries ${fnCount} function${fnCount === 1 ? '' : 's'}${sampleFns ? ` (${sampleFns}${fnCount > 4 ? ', …' : ''})` : ''}. The composite parsed the surface inline from the embedded code; no second dero_get_sc call was needed.`,
      )
    } else if (scLookupFailed) {
      parts.push('Tx is a smart-contract INSTALL but the surface extractor failed to parse the embedded code. Fall back to dero_get_sc with the tx_hash as SCID for the raw payload.')
    }
  } else if (kind === 'coinbase') {
    parts.push('Tx is a coinbase (mining reward) — no ring members, signer is the miner address.')
  } else if (kind === 'transfer_or_invocation') {
    parts.push(
      `Tx is a transfer or SC invocation. ${ringGroups ? `${ringGroups} input ring group${ringGroups === 1 ? '' : 's'} present.` : ''} SC invocation arg decoding is not surfaced by the daemon's JSON response; the ${rawHexLen}-char raw hex blob is available via dero_get_transaction if a wallet-side decoder is needed.`,
    )
  }

  return parts.join(' ')
}

export async function traceTransactionWithContext(rpc: DeroDaemonRpc, args: TraceInput) {
  const decode = args.decode !== false
  const includeScContext = args.include_sc_context !== false

  const params: Record<string, unknown> = {
    txs_hashes: [args.tx_hash],
    decode_as_json: decode ? 1 : 0,
  }

  const steps: ChainStep[] = [
    {
      name: 'get_transaction',
      required: true,
      fn: () => rpc<DeroGetTransactionResult>('DERO.GetTransaction', params),
    },
  ]

  const chain = await runChain(steps)
  const txResult = stepValue<DeroGetTransactionResult>(chain, 'get_transaction')
  const tx = txResult?.txs?.[0]
  const rawHexLen = (txResult?.txs_as_hex?.[0] ?? '').length

  if (!tx || isEmptyTxRecord(tx)) {
    // Daemon does not error on unknown hashes — it returns an empty record.
    // Throw a classifier-friendly message so withStructuredErrors emits
    // TX_NOT_FOUND.
    throw new Error(
      `DERO transaction not found: ${args.tx_hash}. The daemon returned an empty record (no block_height, no mempool entry, no code, no ring).`,
    )
  }

  const confirmation = classifyConfirmation(tx)
  const kind = classifyKind(tx)
  const { groups: ringGroups, first_group_size: firstRingSize } = ringStats(tx)

  let scInstallSurface: DeroScSurface | null = null
  let scLookupFailed = false
  if (includeScContext && kind === 'sc_install') {
    try {
      scInstallSurface = extractScSurface({ code: tx.code })
    } catch {
      scLookupFailed = true
      scInstallSurface = null
    }
  }

  const narrative = buildNarrative(
    args.tx_hash,
    confirmation,
    kind,
    typeof tx.block_height === 'number' ? tx.block_height : null,
    scInstallSurface,
    ringGroups,
    rawHexLen,
    scLookupFailed,
  )

  return attachCitations(
    {
      tx_hash: args.tx_hash,
      confirmation: {
        status: confirmation,
        block_height: typeof tx.block_height === 'number' ? tx.block_height : null,
        valid_block: typeof tx.valid_block === 'string' && tx.valid_block.length > 0 ? tx.valid_block : null,
        invalid_blocks: Array.isArray(tx.invalid_block) ? tx.invalid_block : [],
        in_pool: tx.in_pool === true,
      },
      kind,
      ring: {
        groups: ringGroups,
        first_group_size: firstRingSize,
      },
      reward: typeof tx.reward === 'number' ? tx.reward : null,
      signer_visible: typeof tx.signer === 'string' && tx.signer.length > 0,
      native_balance: {
        scid: NATIVE_DERO_SCID,
        at_tx: typeof tx.balance === 'number' ? tx.balance : null,
        current: typeof tx.balancenow === 'number' ? tx.balancenow : null,
      },
      sc_install: scInstallSurface
        ? {
            scid: args.tx_hash,
            surface: {
              functions: scInstallSurface.functions,
              stringkeys: scInstallSurface.stringkeys,
              uint64keys: scInstallSurface.uint64keys,
              balances: scInstallSurface.balances,
            },
            raw_code_length: scInstallSurface.raw_code_length,
            has_code: scInstallSurface.has_code,
          }
        : null,
      raw_tx_hex_length: rawHexLen,
      narrative,
      _diagnostics: {
        step_latency_ms: stepLatencies(chain),
        total_ms: chain.totalMs,
        halted_at: chain.haltedAt,
        decode_as_json: decode,
        include_sc_context: includeScContext,
        sc_install_surface_attempted: includeScContext && kind === 'sc_install',
        sc_install_surface_failed: scLookupFailed,
      },
    },
    'trace_transaction_with_context',
  )
}
