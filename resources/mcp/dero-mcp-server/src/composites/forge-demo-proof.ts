/**
 * `dero_forge_demo_proof` — composite #7.
 *
 * Builds a `deroproof…` display object for a chosen transaction, ring slot,
 * and amount. The string is constructed locally from public chain data — no
 * wallet, no keys, no broadcast. On an unpatched explorer it shows
 * **Verified ✓** for the chosen amount; on the chain, nothing changes.
 *
 * Purpose: defensive demonstration of the integrity-page Part 3 forge math
 * (`docs/integrity/inflation-claim`, Part 3). When an AI agent is asked
 * "does this deroproof string prove the chain minted coins?", the agent can
 * forge an equivalent string here and show, on real chain inputs, that
 * **Verified** is a display-layer fact about the pasted object — not a
 * consensus statement about coins moving.
 *
 * Math (same equation `proof.Prove()` checks at `proof/proof.go:88-95`):
 *
 *   blinder = C[slot] − amount × G
 *   forged_string = bech32("deroproof", version || blinder_compressed || CBOR({HH: 0…0, VU: amount}))
 *
 * Self-check: amount × G + blinder == C[slot]. If this fails, the encoded
 * string would not verify and we never return it.
 *
 * Read-only invariant: this tool computes a string and returns it. It does
 * NOT touch a wallet, broadcast a transaction, or mutate any chain state.
 * Annotation `readOnlyHint: true` is preserved.
 */

import { z } from 'zod'

import {
  G,
  add,
  deroCompressHex,
  deroDecompress,
  negate,
  pointsEqual,
  scalarMult,
  uint64ToSignedScalar,
} from '../bn254.js'
import {
  enrichWithFlaggedArtifacts,
  relatedDocsFor,
  type DeroCitation,
} from '../citations.js'
import { encodeForgeProofString } from '../proof-decode.js'
import { getRingCommitment, parseTransaction, type ParsedTransaction } from '../tx-parse.js'
import {
  runChain,
  stepLatencies,
  stepValue,
  type ChainStep,
  type DeroDaemonRpc,
} from './_shared.js'

const ATOMIC = 100_000n
const UINT64_MOD = 1n << 64n

export const forgeDemoProofInputSchema = {
  tx_hash: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'tx_hash must be 64 hex characters')
    .optional()
    .describe(
      'TX hash to forge against. Daemon fetches the TX hex + ring members. Mutually exclusive with tx_hex.',
    ),
  tx_hex: z
    .string()
    .min(2)
    .max(100_000, 'tx_hex exceeds 50KB (100k hex chars); real DERO txs are well under 10KB')
    .optional()
    .describe(
      'Raw TX bytes as hex (skip the daemon round-trip). Mutually exclusive with tx_hash. When provided, ring_receiver_address is omitted from the response (the hex carries publickey pointers, not full addresses).',
    ),
  ring_slot: z
    .number()
    .int()
    .nonnegative()
    .default(0)
    .describe('Which ring slot 0..ring_size-1 the forged proof should resolve to. Defaults to 0.'),
  amount_dero: z
    .string()
    .regex(
      /^-?\d+(\.\d{1,5})?$/,
      'amount_dero must be a signed decimal with at most 5 fractional digits (e.g. "-1", "1000000", "-2200000.00181")',
    )
    .default('-1')
    .describe(
      'Target display amount in signed DERO (5 fractional digits = atomic precision). Negative values demonstrate the uint64 wraparound. Default "-1".',
    ),
} as const

export type ForgeDemoProofInput = {
  tx_hash?: string
  tx_hex?: string
  ring_slot?: number
  amount_dero?: string
}

type TransactionResult = {
  txs?: Array<{
    valid_block?: string
    block_height?: number
    ring?: string[][]
  }>
  txs_as_hex?: string[]
}

export type ForgeDemoProofResult = {
  forged_proof_string: string
  target_amount: {
    dero: string
    atoms_signed: string
    atoms_uint64: string
  }
  ring_slot: number
  ring_size: number
  ring_receiver_address: string | null
  math: {
    C_slot_hex: string
    amount_x_G_hex: string
    blinder_hex: string
  }
  self_check: {
    verified: boolean
    method: string
  }
  explorer_display_amount: string
  context_note: string | null
  related_docs: DeroCitation[]
  _diagnostics: {
    step_latencies: Record<string, number>
    halted_at: string | null
    total_ms: number
    tx_source: 'tx_hash' | 'tx_hex'
  }
}

/**
 * Parse a signed-decimal DERO string (e.g. "-2200000.00181") into:
 *   - signed atoms (bigint, may be negative)
 *   - uint64 (atoms mod 2^64)
 */
function parseAmount(amountDero: string): {
  signedAtoms: bigint
  uint64: bigint
  signedDeroNormalized: string
} {
  const negative = amountDero.startsWith('-')
  const unsigned = negative ? amountDero.slice(1) : amountDero
  const dot = unsigned.indexOf('.')
  const wholeStr = dot === -1 ? unsigned : unsigned.slice(0, dot)
  const fracStr = dot === -1 ? '' : unsigned.slice(dot + 1)
  const fracPadded = (fracStr + '00000').slice(0, 5)
  const whole = BigInt(wholeStr.length === 0 ? '0' : wholeStr)
  const frac = BigInt(fracPadded)
  const absAtoms = whole * ATOMIC + frac
  const signedAtoms = negative ? -absAtoms : absAtoms

  const uint64 = ((signedAtoms % UINT64_MOD) + UINT64_MOD) % UINT64_MOD

  // Normalize the input echo so callers see the canonical form (5 fractional digits).
  const normalized = `${negative && absAtoms > 0n ? '-' : ''}${whole.toString()}.${fracPadded}`
  return { signedAtoms, uint64, signedDeroNormalized: normalized }
}

/** Format a uint64 as the unpatched-explorer display amount (whole.fractional with 5 digits). */
function formatExplorerDisplay(uint64: bigint): string {
  const whole = uint64 / ATOMIC
  const frac = uint64 % ATOMIC
  // Group thousands in the whole-part for readability.
  const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${wholeStr}.${frac.toString().padStart(5, '0')} DERO`
}

/**
 * Execute the forge. Composes:
 *   1. (optional) daemon fetch of TX hex + ring members
 *   2. parse TX → extract C[ring_slot]
 *   3. compute blinder = C[slot] − amount × G
 *   4. self-check: amount × G + blinder == C[slot]
 *   5. encode forged proof string + assemble narrative + citations
 */
export async function forgeDemoProof(
  rpc: DeroDaemonRpc,
  input: ForgeDemoProofInput,
): Promise<ForgeDemoProofResult> {
  if (input.tx_hash && input.tx_hex) {
    throw new Error('INVALID_INPUT: provide exactly one of tx_hash or tx_hex (not both)')
  }
  if (!input.tx_hash && !input.tx_hex) {
    throw new Error('INVALID_INPUT: provide either tx_hash or tx_hex')
  }
  const ringSlot = input.ring_slot ?? 0
  const amountDero = input.amount_dero ?? '-1'

  // ─── 1. Fetch TX (optional daemon round-trip) ─────────────────────────────
  let txHex: string
  let receiverAddress: string | null = null
  const txSource: 'tx_hash' | 'tx_hex' = input.tx_hash ? 'tx_hash' : 'tx_hex'

  const steps: ChainStep[] = []
  if (input.tx_hash) {
    const hash = input.tx_hash
    steps.push({
      name: 'get_transaction',
      required: true,
      fn: () =>
        rpc<TransactionResult>('DERO.GetTransaction', {
          txs_hashes: [hash],
          decode_as_json: 1,
        }),
    })
  }
  const chain = await runChain(steps)

  if (input.tx_hash) {
    const txResult = stepValue<TransactionResult>(chain, 'get_transaction')
    if (!txResult || !txResult.txs_as_hex || txResult.txs_as_hex.length === 0) {
      throw new Error(
        `daemon did not return TX hex for ${input.tx_hash} (chain halted at ${chain.haltedAt ?? '?'})`,
      )
    }
    txHex = txResult.txs_as_hex[0]
    const ring = txResult.txs?.[0]?.ring?.[0]
    if (ring && ringSlot >= 0 && ringSlot < ring.length) {
      receiverAddress = ring[ringSlot]
    }
  } else {
    txHex = input.tx_hex as string
  }

  // ─── 2. Parse TX → extract C[ring_slot] ──────────────────────────────────
  let tx: ParsedTransaction
  try {
    tx = parseTransaction(txHex)
  } catch (err) {
    throw new Error(
      `tx-parse failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  const stmt = tx.payloads[0].statement
  if (ringSlot >= stmt.ring_size) {
    throw new Error(
      `INVALID_INPUT: ring_slot ${ringSlot} >= ring_size ${stmt.ring_size}`,
    )
  }
  const Cslot = getRingCommitment(tx, ringSlot)

  // ─── 3. Forge math ────────────────────────────────────────────────────────
  const { signedAtoms, uint64, signedDeroNormalized } = parseAmount(amountDero)
  const amountG = scalarMult(G, uint64ToSignedScalar(uint64))
  const blinder = add(Cslot, negate(amountG))

  // ─── 4. Self-check (mirror of proof.Prove() inner loop) ──────────────────
  const reconstructed = add(amountG, blinder)
  const verified = pointsEqual(reconstructed, Cslot)
  if (!verified) {
    // Should be impossible by construction — bail loud rather than emit a string
    // that would fail an explorer check.
    throw new Error(
      'self-check FAILED: amount × G + blinder != C[slot] — bn254 math regression',
    )
  }

  // ─── 5. Encode forged proof string ────────────────────────────────────────
  const blinderHex = deroCompressHex(blinder)
  const blinderBytes = new Uint8Array(33)
  for (let i = 0; i < 33; i++) blinderBytes[i] = parseInt(blinderHex.slice(i * 2, i * 2 + 2), 16)
  const forgedString = encodeForgeProofString(blinderBytes, uint64)

  // ─── 6. Citations + context_note enrichment ───────────────────────────────
  const enrichment = enrichWithFlaggedArtifacts(
    {
      ...(input.tx_hash ? { tx_hash: input.tx_hash } : {}),
    },
    relatedDocsFor('dero_forge_demo_proof'),
  )
  const related_docs =
    enrichment?.related_docs ?? relatedDocsFor('dero_forge_demo_proof') ?? []
  const context_note =
    enrichment?.context_note ??
    'This is a forged display object built locally from public chain data — no wallet, no keys, no broadcast. On unpatched explorers it shows Verified ✓ for the chosen amount; on the chain, nothing changed. See related_docs for the technical rebuttal.'

  return {
    forged_proof_string: forgedString,
    target_amount: {
      dero: signedDeroNormalized,
      atoms_signed: signedAtoms.toString(),
      atoms_uint64: uint64.toString(),
    },
    ring_slot: ringSlot,
    ring_size: stmt.ring_size,
    ring_receiver_address: receiverAddress,
    math: {
      C_slot_hex: stmt.C_hex[ringSlot],
      amount_x_G_hex: deroCompressHex(amountG),
      blinder_hex: blinderHex,
    },
    self_check: {
      verified: true,
      method:
        'Reconstructed amount × G + blinder and confirmed equal to C[slot] — same equation proof.Prove() uses (proof/proof.go:88-95).',
    },
    explorer_display_amount: formatExplorerDisplay(uint64),
    context_note,
    related_docs,
    _diagnostics: {
      step_latencies: stepLatencies(chain),
      halted_at: chain.haltedAt,
      total_ms: chain.totalMs,
      tx_source: txSource,
    },
  }
}
