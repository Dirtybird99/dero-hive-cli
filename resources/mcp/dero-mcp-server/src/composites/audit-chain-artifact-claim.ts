/**
 * `audit_chain_artifact_claim` — composite #6.
 *
 * Given a chain artifact (block topoheight, block hash, TX hash, and/or
 * proof string), return a single verdict-shaped response that combines:
 *   - the canonical chain facts (block reward, txcount, TX acceptance, …)
 *   - a check against the flagged-artifact registry (false-claim citations)
 *   - a narrative the agent can relay verbatim
 *   - curated `related_docs` (rebuttal pages when flagged, generic when clean)
 *
 * Use case: a user asks an AI "what's going on with DERO block 1,081,893?"
 * or pastes a `deroproof…` string. Instead of returning raw RPC numbers
 * with no framing — which can read as "agreement with whatever framing the
 * user implied" under hostile readership — this composite returns a
 * factual verdict + the rebuttal context.
 *
 * Pairs with the silent enrichment in `citations.ts`: that fires when an
 * agent queries primitives directly; this composite is for when an agent
 * (or user) explicitly wants to audit an artifact end-to-end.
 *
 * Failure model:
 *   - Validates that at least one artifact field is provided. Throws
 *     `INVALID_INPUT` otherwise — handled by `withStructuredErrors`.
 *   - Daemon calls are non-required (kept independent so the verdict still
 *     lands even if the daemon is offline). Their failures degrade
 *     `chain_facts` to null and surface in `_diagnostics`.
 *   - Proof-string decoding errors are caught and surfaced under
 *     `proof_decode.error` rather than throwing — the verdict still lands.
 */

import { z } from 'zod'
import {
  enrichWithFlaggedArtifacts,
  flaggedArtifactsForInput,
  relatedDocsFor,
  type DeroCitation,
  type FlaggedArtifact,
} from '../citations.js'
import { decodeDeroBech32, interpretValueTransfer } from '../proof-decode.js'
import { forgeDemoProof, type ForgeDemoProofResult } from './forge-demo-proof.js'
import {
  runChain,
  stepLatencies,
  stepValue,
  type ChainStep,
  type DeroDaemonRpc,
} from './_shared.js'

export const auditChainArtifactClaimInputSchema = {
  topoheight: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Topological height of a block to audit.'),
  block_hash: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'block_hash must be 64 hex characters')
    .optional()
    .describe('64-char hex block hash to audit.'),
  tx_hash: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'tx_hash must be 64 hex characters')
    .optional()
    .describe('64-char hex transaction hash to audit.'),
  proof_string: z
    .string()
    .min(8)
    .optional()
    .describe('Optional `deroproof…` / DERO bech32 string to also decode and check.'),
  include_forge_demo: z
    .boolean()
    .optional()
    .describe(
      'When true AND tx_hash is provided, also forge a fresh demo proof for the same TX (via dero_forge_demo_proof) and embed it under `forge_demo`. Closes the rebuttal loop in one tool call. Default false.',
    ),
} as const

export type AuditChainArtifactClaimInput = {
  topoheight?: number
  block_hash?: string
  tx_hash?: string
  proof_string?: string
  include_forge_demo?: boolean
}

type BlockHeaderResult = {
  block_header?: {
    topoheight?: number
    height?: number
    hash?: string
    timestamp?: number
    reward?: number
    txcount?: number
  }
  status?: string
}

type TransactionResult = {
  txs?: Array<{
    in_pool?: boolean
    valid_block?: string
    block_height?: number
  }>
  txs_as_hex?: string[]
}

type AuditVerdict = 'cited_in_false_claim' | 'clean'

type AuditChainFacts = {
  block_header?: BlockHeaderResult['block_header']
  transaction_status?: {
    accepted: boolean
    in_pool: boolean
    block_height: number | null
    valid_block: string | null
  }
}

type AuditProofDecode = {
  hrp?: string
  is_proof?: boolean
  value_transfer_uint64?: string
  value_interpretation?: ReturnType<typeof interpretValueTransfer>
  error?: string
}

/**
 * Slimmed-down embedded forge result. Strips the duplicate citations/context
 * note (the audit response already carries those at the top level) and
 * diagnostics. Keeps the math + the actual forged string + the receiver +
 * the self-check — the pieces that make this useful for the agent.
 */
export type EmbeddedForgeDemo =
  | {
      skipped: false
      forged_proof_string: string
      target_amount: ForgeDemoProofResult['target_amount']
      ring_slot: number
      ring_size: number
      ring_receiver_address: string | null
      math: ForgeDemoProofResult['math']
      self_check: ForgeDemoProofResult['self_check']
      explorer_display_amount: string
      demo_amount_source: 'flagged_artifact' | 'proof_string_v' | 'default'
    }
  | { skipped: true; reason: string }

export type AuditChainArtifactClaimResult = {
  verdict: AuditVerdict
  inputs: AuditChainArtifactClaimInput
  matched_artifacts: Array<{ id: string; matched_by: string[] }>
  context_note: string | null
  chain_facts: AuditChainFacts | null
  proof_decode: AuditProofDecode | null
  forge_demo: EmbeddedForgeDemo | null
  narrative: string
  related_docs: DeroCitation[]
  _diagnostics: {
    step_latencies: Record<string, number>
    halted_at: string | null
    total_ms: number
  }
}

/**
 * Build the human-readable narrative. Kept tight; agents are expected to
 * relay this verbatim to the user.
 */
function buildNarrative(
  verdict: AuditVerdict,
  inputs: AuditChainArtifactClaimInput,
  matched: FlaggedArtifact[],
  chainFacts: AuditChainFacts | null,
  proofDecode: AuditProofDecode | null,
  forgeDemo: EmbeddedForgeDemo | null,
): string {
  const parts: string[] = []

  if (verdict === 'cited_in_false_claim') {
    const ids = matched.map((a) => a.id).join(', ')
    parts.push(
      `The provided artifact(s) match ${matched.length} flagged false-claim record(s): ${ids}.`,
    )
  } else {
    parts.push('No matches found in the flagged false-claim registry for the provided artifact(s).')
  }

  if (chainFacts?.block_header) {
    const h = chainFacts.block_header
    // DERO is 5-decimal (1 DERO = 100,000 atomic units). Format via integer
    // math so all 5 fractional digits survive — toFixed(3) silently dropped
    // atomic precision, which matters on the inflation-claim audit path.
    const reward =
      typeof h.reward === 'number'
        ? `${Math.floor(h.reward / 100_000)}.${(h.reward % 100_000).toString().padStart(5, '0')}`
        : 'n/a'
    parts.push(
      `Block topoheight=${h.topoheight ?? '?'} hash=${(h.hash ?? '').slice(0, 16)}… reward=${reward} DERO txcount=${h.txcount ?? '?'}.`,
    )
  }

  if (chainFacts?.transaction_status) {
    const t = chainFacts.transaction_status
    if (t.accepted) {
      parts.push(
        `Transaction was accepted into block height=${t.block_height ?? '?'} — meaning all six sigma proofs and the range proof passed at every validating node.`,
      )
    } else if (t.in_pool) {
      parts.push('Transaction is currently in the mempool (unconfirmed).')
    } else {
      parts.push('Transaction was not found on this daemon (could be wrong network or non-existent).')
    }
  }

  if (proofDecode && !proofDecode.error) {
    if (proofDecode.value_interpretation) {
      const v = proofDecode.value_interpretation
      parts.push(
        `Proof string decoded successfully — embedded uint64=${v.uint64} (signed interpretation: ${v.dero} DERO${v.is_negative_wraparound ? '; this is a uint64 wraparound of a negative atomic value' : ''}).`,
      )
    } else {
      parts.push(`Bech32 string decoded successfully (hrp=${proofDecode.hrp}).`)
    }
  } else if (proofDecode?.error) {
    parts.push(`Proof-string decode failed: ${proofDecode.error}`)
  }

  if (forgeDemo && !forgeDemo.skipped) {
    parts.push(
      `For comparison, we forged a fresh proof for ring slot ${forgeDemo.ring_slot} targeting ${forgeDemo.target_amount.dero} DERO (display amount ${forgeDemo.explorer_display_amount}). It self-verifies under the same equation proof.Prove() uses — meaning an unpatched explorer would mark it Verified ✓ — yet nothing on-chain moved. The cited payload proof is the same kind of object.`,
    )
  }

  if (verdict === 'cited_in_false_claim') {
    parts.push('See related_docs for the technical rebuttal — the cited payload proof is a display object, not a consensus record.')
  }

  return parts.join(' ')
}

/**
 * Execute the audit. Composes (in this order):
 *   1. Flagged-artifact match against the inputs.
 *   2. Optional `DERO.GetBlockHeaderByTopoHeight` / `DERO.GetBlockHeaderByHash`.
 *   3. Optional `DERO.GetTransaction` for accepted/pool status.
 *   4. Optional proof-string decode.
 *   5. Optional forge-demo (when `include_forge_demo: true` and tx_hash present).
 *   6. Narrative + related_docs assembly.
 */
export async function auditChainArtifactClaim(
  rpc: DeroDaemonRpc,
  input: AuditChainArtifactClaimInput,
): Promise<AuditChainArtifactClaimResult> {
  if (
    input.topoheight === undefined &&
    !input.block_hash &&
    !input.tx_hash &&
    !input.proof_string
  ) {
    throw new Error(
      'INVALID_INPUT: provide at least one of topoheight, block_hash, tx_hash, or proof_string',
    )
  }

  // ─── 1. Flagged-artifact match ────────────────────────────────────────────
  const matched = flaggedArtifactsForInput({
    topoheight: input.topoheight,
    block_hash: input.block_hash,
    tx_hash: input.tx_hash,
    proof_string: input.proof_string,
  })

  // ─── 2-3. Chain primitives (only the ones the inputs cover) ───────────────
  const steps: ChainStep[] = []
  if (input.topoheight !== undefined) {
    const topo = input.topoheight
    steps.push({
      name: 'block_header_by_topo',
      fn: () => rpc<BlockHeaderResult>('DERO.GetBlockHeaderByTopoHeight', { topoheight: topo }),
    })
  } else if (input.block_hash) {
    const hash = input.block_hash
    steps.push({
      name: 'block_header_by_hash',
      fn: () => rpc<BlockHeaderResult>('DERO.GetBlockHeaderByHash', { hash }),
    })
  }
  if (input.tx_hash) {
    const tx = input.tx_hash
    steps.push({
      name: 'get_transaction',
      fn: () => rpc<TransactionResult>('DERO.GetTransaction', { txs_hashes: [tx] }),
    })
  }
  const chain = await runChain(steps)

  // ─── 4. Proof-string decode ───────────────────────────────────────────────
  let proofDecode: AuditProofDecode | null = null
  if (input.proof_string) {
    try {
      const decoded = decodeDeroBech32(input.proof_string)
      const valueInterp =
        decoded.value_transfer_uint64 !== undefined
          ? interpretValueTransfer(decoded.value_transfer_uint64)
          : undefined
      proofDecode = {
        hrp: decoded.hrp,
        is_proof: decoded.is_proof,
        ...(decoded.value_transfer_uint64 !== undefined
          ? { value_transfer_uint64: decoded.value_transfer_uint64.toString() }
          : {}),
        ...(valueInterp ? { value_interpretation: valueInterp } : {}),
      }
    } catch (error) {
      proofDecode = {
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  // ─── 5. Optional forge-demo (closes the rebuttal loop in one call) ───────
  let forge_demo: EmbeddedForgeDemo | null = null
  if (input.include_forge_demo) {
    if (!input.tx_hash) {
      forge_demo = {
        skipped: true,
        reason: 'include_forge_demo requires tx_hash (forging needs the TX commitments)',
      }
    } else {
      // Pick the most rebuttal-relevant demo amount:
      //   - matched flagged artifact's pinned amount (e.g. -2.2M for 2022 claim)
      //   - else reuse the cited proof_string V if we successfully decoded one
      //   - else default to -1 DERO
      let demoAmount = '-1'
      let demoSource: 'flagged_artifact' | 'proof_string_v' | 'default' = 'default'
      const flaggedAmount = matched.find((a) => typeof a.demo_amount_dero === 'string')
        ?.demo_amount_dero
      if (flaggedAmount) {
        demoAmount = flaggedAmount
        demoSource = 'flagged_artifact'
      } else if (proofDecode?.value_interpretation?.dero) {
        demoAmount = proofDecode.value_interpretation.dero
        demoSource = 'proof_string_v'
      }
      try {
        const forged = await forgeDemoProof(rpc, {
          tx_hash: input.tx_hash,
          ring_slot: 0,
          amount_dero: demoAmount,
        })
        forge_demo = {
          skipped: false,
          forged_proof_string: forged.forged_proof_string,
          target_amount: forged.target_amount,
          ring_slot: forged.ring_slot,
          ring_size: forged.ring_size,
          ring_receiver_address: forged.ring_receiver_address,
          math: forged.math,
          self_check: forged.self_check,
          explorer_display_amount: forged.explorer_display_amount,
          demo_amount_source: demoSource,
        }
      } catch (error) {
        forge_demo = {
          skipped: true,
          reason: `forge failed: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
    }
  }

  // ─── 6. Assemble chain_facts payload ─────────────────────────────────────
  const blockHeaderTopo = stepValue<BlockHeaderResult>(chain, 'block_header_by_topo')
  const blockHeaderHash = stepValue<BlockHeaderResult>(chain, 'block_header_by_hash')
  const txResult = stepValue<TransactionResult>(chain, 'get_transaction')

  const chainFacts: AuditChainFacts | null = (() => {
    const header = blockHeaderTopo?.block_header ?? blockHeaderHash?.block_header
    let txStatus: AuditChainFacts['transaction_status']
    if (txResult?.txs && txResult.txs.length > 0) {
      const t = txResult.txs[0]
      const accepted = !!t.valid_block && t.valid_block !== ''
      txStatus = {
        accepted,
        in_pool: !!t.in_pool,
        block_height: typeof t.block_height === 'number' ? t.block_height : null,
        valid_block: t.valid_block ?? null,
      }
    }
    if (!header && !txStatus) return null
    return {
      ...(header ? { block_header: header } : {}),
      ...(txStatus ? { transaction_status: txStatus } : {}),
    }
  })()

  // ─── 7. Verdict + narrative + related_docs ────────────────────────────────
  const verdict: AuditVerdict = matched.length > 0 ? 'cited_in_false_claim' : 'clean'
  const enrichment = enrichWithFlaggedArtifacts(
    {
      topoheight: input.topoheight,
      block_hash: input.block_hash,
      tx_hash: input.tx_hash,
      proof_string: input.proof_string,
    },
    relatedDocsFor('audit_chain_artifact_claim'),
  )
  const related_docs =
    enrichment?.related_docs ?? relatedDocsFor('audit_chain_artifact_claim') ?? []
  const context_note = enrichment?.context_note ?? null

  const matched_artifacts = matched.map((a) => ({
    id: a.id,
    matched_by: a.matchers
      .filter((m) => {
        if (m.kind === 'topoheight') return input.topoheight === m.value
        if (m.kind === 'block_hash') {
          return !!input.block_hash && input.block_hash.toLowerCase() === m.value.toLowerCase()
        }
        if (m.kind === 'tx_hash') {
          return !!input.tx_hash && input.tx_hash.toLowerCase() === m.value.toLowerCase()
        }
        if (m.kind === 'proof_string') return input.proof_string === m.value
        return false
      })
      .map((m) => m.kind),
  }))

  const narrative = buildNarrative(verdict, input, matched, chainFacts, proofDecode, forge_demo)

  return {
    verdict,
    inputs: input,
    matched_artifacts,
    context_note,
    chain_facts: chainFacts,
    proof_decode: proofDecode,
    forge_demo,
    narrative,
    related_docs,
    _diagnostics: {
      step_latencies: stepLatencies(chain),
      halted_at: chain.haltedAt,
      total_ms: chain.totalMs,
    },
  }
}
