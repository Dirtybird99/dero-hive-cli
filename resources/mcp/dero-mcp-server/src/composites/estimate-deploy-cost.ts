/**
 * `estimate_deploy_cost` — Phase C composite #4.
 *
 * Wedge: `dero_get_gas_estimate` returns raw `gascompute` and
 * `gasstorage` numbers. Agents have to know that the first is DVM
 * execution cost and the second is on-chain byte cost — and have to
 * separately call `dero_get_sc` to understand what they are about to
 * deploy. This composite returns the estimate, the parsed contract
 * surface (functions / stringkeys / uint64keys), a plain-text
 * breakdown explaining what each number means, and the curated
 * "Create, Deploy & Use a Smart Contract" docs page as a citation.
 *
 * Design contract § 4. Sequencing rule: SHIP
 * FOURTH. Numeric semantics; relies on `extractScSurface` (composite
 * #2) being stable. Must not ship before composite #2 because the
 * surface enrichment proves out the reuse path planned in the design
 * doc.
 *
 * Failure model:
 *   - DVM compile failure (daemon returns `RPC error -32098`) → the
 *     classifier branch in `withStructuredErrors` surfaces this as
 *     `INVALID_INPUT` with an actionable hint. The daemon's exact
 *     compile message stays in `_meta.error.raw`.
 *   - Invalid signer address → daemon usually emits `RPC error
 *     -32602` (RPC_INVALID_PARAMS); existing classifier branch
 *     handles it.
 *   - Daemon returns a non-"OK" status with 0/0 numbers → return
 *     the estimate as-is and set `breakdown: null`. NEVER fabricate
 *     a breakdown when the numbers are 0/0 with a non-success
 *     status; the agent must see the daemon's exact status string.
 */

import { z } from 'zod'
import {
  attachCitations,
  extractScSurface,
  type DeroDaemonRpc,
} from './_shared.js'

const DERO_ADDRESS_REGEX = /^(dero1|deto1)[0-9a-z]+$/i

export const estimateDeployCostInputSchema = {
  sc: z
    .string()
    .min(1)
    .describe(
      'DVM-BASIC contract source to deploy. MUST be the full contract (Function ... End Function blocks), not a function body alone.',
    ),
  signer: z
    .string()
    .regex(DERO_ADDRESS_REGEX, 'Expected DERO address starting with dero1 or deto1')
    .optional()
    .describe('Optional dero1.../deto1... signer for the eventual deploy tx.'),
  include_breakdown: z
    .boolean()
    .optional()
    .describe('Default true. Set false to return raw estimate numbers only.'),
} as const

type EstimateInput = {
  sc: string
  signer?: string
  include_breakdown?: boolean
}

type GasEstimateResult = {
  gascompute?: number | string
  gasstorage?: number | string
  status?: string
  [k: string]: unknown
}

type EstimateBreakdown = {
  compute_note: string
  storage_note: string
  total_units: number
}

/**
 * Pure function: turn a (gascompute, gasstorage) pair into a
 * plain-language breakdown. Returns `null` when either number is
 * unavailable or non-numeric, OR when the daemon returned 0/0 with a
 * non-"OK" status (in which case fabricating a breakdown would
 * mislead the agent — the design contract is explicit on this).
 *
 * The DVM denominates gas in atomic units (the daemon docs call them
 * "gas units"). Converting to DERO requires the fee-per-gas table,
 * which is itself a separate query. We deliberately do NOT convert
 * here and instead surface the raw unit total plus a note pointing
 * the agent at the docs.
 */
export function buildBreakdown(
  gascompute: number | string | undefined,
  gasstorage: number | string | undefined,
  status: string | undefined,
): EstimateBreakdown | null {
  const compute = typeof gascompute === 'number' ? gascompute : Number(gascompute)
  const storage = typeof gasstorage === 'number' ? gasstorage : Number(gasstorage)
  if (!Number.isFinite(compute) || !Number.isFinite(storage)) return null
  if (compute === 0 && storage === 0 && status !== 'OK') return null
  return {
    compute_note: `gascompute=${compute} — DVM execution cost (units the daemon charges for running the contract's Initialize and any reachable functions during the deploy). Higher when the contract has more code paths.`,
    storage_note: `gasstorage=${storage} — on-chain byte cost (units the daemon charges for storing the contract code blob and its initial state). Roughly proportional to source length.`,
    total_units: compute + storage,
  }
}

export async function estimateDeployCost(rpc: DeroDaemonRpc, args: EstimateInput) {
  const params: Record<string, unknown> = { sc: args.sc }
  if (args.signer) params.signer = args.signer

  // Required call. DVM compile failures throw RPC error -32098 which
  // the classifier branch in src/server.ts maps to INVALID_INPUT.
  const raw = (await rpc<GasEstimateResult>('DERO.GetGasEstimate', params)) ?? {}

  const gascompute =
    typeof raw.gascompute === 'number' || typeof raw.gascompute === 'string'
      ? Number(raw.gascompute)
      : null
  const gasstorage =
    typeof raw.gasstorage === 'number' || typeof raw.gasstorage === 'string'
      ? Number(raw.gasstorage)
      : null
  const status = typeof raw.status === 'string' ? raw.status : null

  const includeBreakdown = args.include_breakdown !== false
  const breakdown = includeBreakdown ? buildBreakdown(raw.gascompute, raw.gasstorage, raw.status ?? undefined) : null

  // Wedge enrichment: parse the SC source the user just submitted so
  // the agent can show "you're about to deploy X functions" alongside
  // the gas numbers. Reuses extractScSurface from composite #2, with
  // the user-provided `sc` shaped as a DeroGetScResult so the same
  // extractor can run unchanged.
  const surface = extractScSurface({ code: args.sc })

  return attachCitations(
    {
      estimate: {
        gascompute,
        gasstorage,
        status,
      },
      breakdown,
      signer_used: args.signer ?? null,
      include_breakdown: includeBreakdown,
      sc_surface: {
        functions: surface.functions,
        stringkeys: surface.stringkeys,
        uint64keys: surface.uint64keys,
        raw_code_length: surface.raw_code_length,
        function_count: surface.functions.length,
      },
    },
    'estimate_deploy_cost',
  )
}
