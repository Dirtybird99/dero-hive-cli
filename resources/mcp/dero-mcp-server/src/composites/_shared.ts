/**
 * Shared utilities for DERO MCP composite tools.
 *
 * A composite tool stitches several primitives (daemon RPC reads + bundled
 * docs lookups) into one intent-shaped response. These utilities exist so
 * every composite handles failures, latency tracking, and citation
 * attachment the same way.
 *
 * Anything reused by more than one composite belongs here. Composite-local
 * helpers (e.g. narrative builders specific to one composite's response
 * shape) should live next to that composite, not in this file.
 *
 * See the composite design contract for which
 * utilities live here and the gate every composite must satisfy before it
 * lands on main.
 */

import { relatedDocsFor, type DeroCitation } from '../citations.js'

/**
 * One step in a composite's internal chain.
 *
 * `required: true` aborts the chain if the step throws (use for liveness
 * gates like `DERO.Ping`). `required: false` lets the chain continue with
 * a degraded payload (use for enrichments like a mempool snapshot).
 */
export type ChainStep<T = unknown> = {
  name: string
  required?: boolean
  fn: () => Promise<T>
}

export type ChainStepResult = {
  name: string
  ok: boolean
  value?: unknown
  error?: { message: string }
  latencyMs: number
}

export type ChainResult = {
  results: ChainStepResult[]
  haltedAt: string | null
  totalMs: number
}

/**
 * Run a chain of named primitive calls sequentially. Required-step
 * failures halt the chain and record `haltedAt`; non-required failures
 * are recorded and the chain continues. Step latencies are captured so
 * composites can attach diagnostics to a degraded response.
 */
export async function runChain(steps: readonly ChainStep[]): Promise<ChainResult> {
  const results: ChainStepResult[] = []
  const startedAt = performance.now()
  let haltedAt: string | null = null

  for (const step of steps) {
    const stepStart = performance.now()
    try {
      const value = await step.fn()
      results.push({
        name: step.name,
        ok: true,
        value,
        latencyMs: Math.round(performance.now() - stepStart),
      })
    } catch (error) {
      results.push({
        name: step.name,
        ok: false,
        error: { message: error instanceof Error ? error.message : String(error) },
        latencyMs: Math.round(performance.now() - stepStart),
      })
      if (step.required) {
        haltedAt = step.name
        break
      }
    }
  }

  return {
    results,
    haltedAt,
    totalMs: Math.round(performance.now() - startedAt),
  }
}

/**
 * Extract a single step's successful return value from a ChainResult.
 * Returns null when the step was skipped (chain halted earlier), failed,
 * or simply was not part of the chain.
 */
export function stepValue<T = unknown>(chain: ChainResult, name: string): T | null {
  const entry = chain.results.find((r) => r.name === name)
  if (!entry || !entry.ok) return null
  return entry.value as T
}

/**
 * Per-step latency map suitable for embedding in a composite's response
 * under a `_diagnostics` field. Lets agents and operators see which step
 * was slow without needing to instrument the host.
 */
export function stepLatencies(chain: ChainResult): Record<string, number> {
  const out: Record<string, number> = {}
  for (const r of chain.results) out[r.name] = r.latencyMs
  return out
}

/**
 * Attach curated `related_docs` citations to a composite's payload.
 * Mirrors how primitives attach citations so the response shape stays
 * uniform across primitives and composites. Returns the payload
 * unchanged when no curated docs are configured for the tool name.
 */
export function attachCitations<T extends Record<string, unknown>>(
  payload: T,
  toolName: string,
): T & { related_docs?: DeroCitation[] } {
  const related_docs = relatedDocsFor(toolName)
  if (!related_docs || related_docs.length === 0) return payload
  return { ...payload, related_docs }
}

/**
 * Shape used by the JSON-RPC `rpc` closure created in `src/server.ts`.
 * Re-declared here so composites can take it as a dependency without
 * importing from the server module (keeps the composite layer free of
 * `McpServer` coupling).
 */
export type DeroDaemonRpc = <T = unknown>(method: string, params?: unknown) => Promise<T>

// ---------------- Smart contract surface extraction ----------------
//
// Used by composite #2 (`explain_smart_contract`) and reused by
// composites #4 (`estimate_deploy_cost`) and #5
// (`trace_transaction_with_context`) — see composite design contract § shared
// utilities. Intentionally pure and dependency-free so it can be unit
// tested without a daemon.

/**
 * Loose representation of a `DERO.GetSC` response. Field names match the
 * daemon's actual JSON keys observed on the public node. `uint64keys` is
 * frequently absent (the daemon omits empty maps), so it is optional.
 */
export type DeroGetScResult = {
  code?: string
  status?: string
  balance?: number
  balances?: Record<string, number>
  stringkeys?: Record<string, unknown>
  uint64keys?: Record<string, unknown>
  [k: string]: unknown
}

export type DvmFunctionSignature = {
  name: string
  args: string[]
  returns: string
}

export type DeroScSurface = {
  functions: DvmFunctionSignature[]
  stringkeys: string[]
  uint64keys: string[]
  stringkeys_total: number
  uint64keys_total: number
  stringkeys_truncated: boolean
  uint64keys_truncated: boolean
  balances: Record<string, number | string>
  raw_code_length: number
  has_code: boolean
}

/**
 * Maximum number of state-variable keys surfaced per map. Real contracts
 * like the on-chain name service hold tens of thousands of stringkeys
 * (22,619 at time of writing), and an uncapped dump blows past every MCP
 * host's token limit — turning the canonical `0000…0001` example into an
 * unusable wall. The first N sorted keys are a deterministic, useful
 * sample; `*_total` and `*_truncated` keep the response honest.
 */
export const SURFACE_KEY_CAP = 50

/** Sort keys, take the first `SURFACE_KEY_CAP`, and report the full count. */
function capKeys(map: Record<string, unknown> | undefined): {
  keys: string[]
  total: number
  truncated: boolean
} {
  const all = map ? Object.keys(map).sort() : []
  return {
    keys: all.slice(0, SURFACE_KEY_CAP),
    total: all.length,
    truncated: all.length > SURFACE_KEY_CAP,
  }
}

/**
 * Bound a raw `DERO.GetSC` variable map (`stringkeys` / `uint64keys`) for the
 * `dero_get_sc` primitive, which returns the daemon payload verbatim. A map
 * over `SURFACE_KEY_CAP` entries is replaced by a sorted sample plus
 * `<field>_total` / `<field>_truncated` siblings so the response stays under
 * host token limits without losing the count signal. Maps at or under the cap
 * pass through untouched (no markers added). Returns the patch to spread onto
 * the result; the field is deleted and re-added as a sample when truncated.
 */
export function capRawScVariables(
  result: Record<string, unknown>,
  field: 'stringkeys' | 'uint64keys',
): void {
  const map = result[field]
  if (!map || typeof map !== 'object') return
  const entries = Object.entries(map as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )
  if (entries.length <= SURFACE_KEY_CAP) return
  result[field] = Object.fromEntries(entries.slice(0, SURFACE_KEY_CAP))
  result[`${field}_total`] = entries.length
  result[`${field}_truncated`] = true
}

// DVM-BASIC function declaration:
//   Function Name(arg Type, ...) Uint64|String
//
// Anchored with `/m` so each line of source is examined independently.
// Tolerant of leading whitespace and varied spacing inside the parens.
const DVM_FUNCTION_REGEX =
  /^[ \t]*Function[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*\(([^)]*)\)[ \t]*(Uint64|String)\b/gm

function parseDvmFunctions(code: string): DvmFunctionSignature[] {
  const out: DvmFunctionSignature[] = []
  const seen = new Set<string>()
  for (const match of code.matchAll(DVM_FUNCTION_REGEX)) {
    const name = match[1]
    if (seen.has(name)) continue
    seen.add(name)
    const argsRaw = (match[2] ?? '').trim()
    const returns = match[3] ?? ''
    const args =
      argsRaw.length === 0
        ? []
        : argsRaw
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
    out.push({ name, args, returns })
  }
  return out
}

/**
 * Convert a raw DERO.GetSC payload into a stable, agent-friendly surface.
 *
 * Behavior:
 *  - Returns `functions: []` when `code` is missing or the regex finds
 *    no Function declarations. Never throws on malformed code.
 *  - Sorts `stringkeys` / `uint64keys` alphabetically and caps each at
 *    `SURFACE_KEY_CAP` for deterministic, bounded output — large registries
 *    would otherwise overflow MCP host token limits. `*_total` /
 *    `*_truncated` report what was elided.
 *  - `balances` is passed through unchanged so callers can render asset
 *    balances; native DERO balance lives under `balance` on the raw
 *    payload and is left for callers to decide whether to surface.
 */
export function extractScSurface(raw: DeroGetScResult | null | undefined): DeroScSurface {
  const code = typeof raw?.code === 'string' ? raw.code : ''
  const functions = code.length > 0 ? parseDvmFunctions(code) : []
  const stringkeys = capKeys(raw?.stringkeys)
  const uint64keys = capKeys(raw?.uint64keys)
  const balances: Record<string, number | string> = {}
  if (raw?.balances && typeof raw.balances === 'object') {
    for (const [scid, amount] of Object.entries(raw.balances)) {
      if (typeof amount === 'number' || typeof amount === 'string') {
        balances[scid] = amount
      }
    }
  }
  return {
    functions,
    stringkeys: stringkeys.keys,
    uint64keys: uint64keys.keys,
    stringkeys_total: stringkeys.total,
    uint64keys_total: uint64keys.total,
    stringkeys_truncated: stringkeys.truncated,
    uint64keys_truncated: uint64keys.truncated,
    balances,
    raw_code_length: code.length,
    has_code: code.length > 0,
  }
}
