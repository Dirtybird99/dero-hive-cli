/**
 * `explain_smart_contract` — Phase C composite #2.
 *
 * Wedge-defining composite. Today an agent calls `dero_get_sc`, gets a
 * raw code blob with stringkeys/uint64keys/balances, and must know
 * DVM-BASIC syntax to interpret it. This composite extracts the
 * contract's function surface and stitches it to the right bundled DVM
 * docs page — something no generic chain MCP can replicate because no
 * other chain MCP ships the docs index in-process.
 *
 * Design contract § 2. Sequencing rule: SHIP
 * SECOND — establishes the SC-introspection pattern (`extractScSurface`)
 * that `trace_transaction_with_context` and `estimate_deploy_cost` reuse.
 *
 * Failure model:
 *   - `DERO.GetSC` failing entirely → handler throws so
 *     `withStructuredErrors` surfaces a structured error to the agent.
 *   - `DERO.GetSC` succeeds but returns no `code` → response carries
 *     `surface.has_code: false`, `functions: []`, narrative explains
 *     the SCID is unknown or has no on-chain code, and `_meta.error`
 *     style hint points at `dero_docs_search("smart contract")`.
 *   - Code present but `extractScSurface` finds zero functions →
 *     return surface with `functions: []` and a narrative noting
 *     parse-uncertainty. NEVER swallow the raw code; surface
 *     `raw_code_length` so the agent knows to fall back to `dero_get_sc`.
 */

import { z } from 'zod'
import {
  attachCitations,
  extractScSurface,
  type DeroDaemonRpc,
  type DeroGetScResult,
  type DeroScSurface,
} from './_shared.js'
import { classifyTela } from '../tela-parse.js'

const SCID_HEX_REGEX = /^[0-9a-fA-F]{64}$/

export const explainSmartContractInputSchema = {
  scid: z
    .string()
    .regex(SCID_HEX_REGEX, 'Expected 64-character hex Smart Contract ID')
    .describe('64-char hex Smart Contract ID'),
  topoheight: z
    .number()
    .int()
    .optional()
    .describe('Optional topo height; omit for latest tip'),
} as const

type ExplainInput = { scid: string; topoheight?: number }

// ---------------- Heuristic docs routing ----------------
//
// The four bundled DVM docs slugs we can route to. Validated by the
// citation CI guard via `RELATED_DOCS_BY_TOOL.explain_smart_contract`.
const DVM_DOC_FUNDAMENTALS = 'dvm/smart-contract-fundamentals'
const DVM_DOC_LANGUAGE = 'dvm/dvm-basic'
const DVM_DOC_DEPLOY = 'dvm/create-deploy-use-smart-contract'
const DVM_DOC_PLATFORM = 'dvm/dero-virtual-machine'
const TELA_DOC_INDEX_SPEC = 'tela/tela-index-specification'
const TELA_DOC_DOC_SPEC = 'tela/tela-doc-specification'

type ContractKind = 'tela_index' | 'tela_doc' | 'token' | 'registry' | 'minimal' | 'generic'

/**
 * Classify a contract from its surface + raw code so we can pick the
 * most relevant docs page as "primary". Pure function, deterministic,
 * unit-testable. Returns the classification AND the slug to elevate.
 */
export function classifyContractAndPickDoc(
  surface: DeroScSurface,
  code: string,
  rawStringkeys?: Record<string, unknown>,
): { kind: ContractKind; primarySlug: string } {
  // TELA detection FIRST: a TELA contract's InitializePrivate contains
  // `EXISTS("nameHdr")`, which the registry heuristic below would otherwise
  // misclassify as a name registry. classifyTela keys on the TELA-specific
  // markers (dURL/DOC1/docType/fileCheck) from both the raw stringkeys and the
  // code literals, so it correctly distinguishes a TELA app from a registry.
  const tela = classifyTela(rawStringkeys, code)
  if (tela.kind === 'tela_index') return { kind: 'tela_index', primarySlug: TELA_DOC_INDEX_SPEC }
  if (tela.kind === 'tela_doc') return { kind: 'tela_doc', primarySlug: TELA_DOC_DOC_SPEC }

  const functionNames = new Set(surface.functions.map((f) => f.name.toLowerCase()))
  const codeUpper = code.toUpperCase()

  const looksLikeToken =
    codeUpper.includes('SEND_ASSET_TO_ADDRESS') ||
    functionNames.has('mint') ||
    functionNames.has('burn') ||
    (functionNames.has('transfer') && functionNames.has('transferownership'))

  if (looksLikeToken) {
    return { kind: 'token', primarySlug: DVM_DOC_LANGUAGE }
  }

  const looksLikeRegistry =
    codeUpper.includes('EXISTS(') ||
    functionNames.has('register') ||
    functionNames.has('lookup') ||
    functionNames.has('reserve')

  if (looksLikeRegistry) {
    return { kind: 'registry', primarySlug: DVM_DOC_FUNDAMENTALS }
  }

  if (surface.functions.length <= 1) {
    return { kind: 'minimal', primarySlug: DVM_DOC_DEPLOY }
  }

  return { kind: 'generic', primarySlug: DVM_DOC_FUNDAMENTALS }
}

// ---------------- Narrative ----------------
//
// Lives next to the composite (not in `_shared.ts`) because the shape is
// tightly coupled to composite #2's response. Pure function for testability.

function buildNarrative(
  scid: string,
  topoheight: number | null,
  surface: DeroScSurface,
  kind: ContractKind,
): string {
  if (!surface.has_code) {
    return `SCID ${scid} returned no on-chain code at topoheight ${topoheight ?? 'tip'}. Either the contract does not exist or it was deployed without code. Try dero_docs_search("smart contract") for installation context, or re-check the SCID.`
  }

  const fnCount = surface.functions.length
  const stringCount = surface.stringkeys.length
  const uint64Count = surface.uint64keys.length
  const balanceCount = Object.keys(surface.balances).length

  if (fnCount === 0) {
    return `Found ${surface.raw_code_length} bytes of code at SCID ${scid} (topoheight ${topoheight ?? 'tip'}) but no DVM-BASIC Function declarations were recognized by the parser. The raw code is still available via dero_get_sc; ${stringCount} stored string keys and ${uint64Count} uint64 keys are present, with ${balanceCount} asset balance(s).`
  }

  const kindPhrase: Record<ContractKind, string> = {
    tela_index: 'is a TELA-INDEX-1 application manifest (the on-chain entrypoint listing an app’s DOC files)',
    tela_doc: 'is a TELA-DOC-1 file contract (stores a single on-chain web-app file)',
    token: 'has a token-style surface (transfer/asset operations)',
    registry: 'has a registry-style surface (Register/Lookup/EXISTS pattern)',
    minimal: 'is a minimal contract (Initialize-only or single function)',
    generic: 'has a generic state-machine surface',
  }
  const fnList = surface.functions
    .slice(0, 6)
    .map((f) => (f.args.length > 0 ? `${f.name}(${f.args.length}-arg)` : `${f.name}()`))
    .join(', ')
  const more = fnCount > 6 ? ` (+${fnCount - 6} more)` : ''

  return `SCID ${scid} at topoheight ${topoheight ?? 'tip'} ${kindPhrase[kind]}. Exposes ${fnCount} function${fnCount === 1 ? '' : 's'}: ${fnList}${more}. State carries ${stringCount} string key${stringCount === 1 ? '' : 's'} and ${uint64Count} uint64 key${uint64Count === 1 ? '' : 's'}, with ${balanceCount} asset balance entr${balanceCount === 1 ? 'y' : 'ies'}. See the cited docs page for the DVM concept that best matches this surface.`
}

// ---------------- Handler ----------------

export async function explainSmartContract(rpc: DeroDaemonRpc, args: ExplainInput) {
  const params: Record<string, unknown> = {
    scid: args.scid,
    code: true,
    variables: true,
  }
  if (args.topoheight !== undefined) params.topoheight = args.topoheight

  // Required call. Failure propagates through withStructuredErrors.
  const raw = (await rpc<DeroGetScResult>('DERO.GetSC', params)) ?? {}
  const surface = extractScSurface(raw)
  const code = typeof raw.code === 'string' ? raw.code : ''
  // Pass the RAW (uncapped) stringkeys so TELA marker detection is not affected
  // by extractScSurface's 50-key cap.
  const rawStringkeys =
    raw.stringkeys && typeof raw.stringkeys === 'object'
      ? (raw.stringkeys as Record<string, unknown>)
      : undefined
  const { kind, primarySlug } = classifyContractAndPickDoc(surface, code, rawStringkeys)
  const responseTopoheight =
    typeof args.topoheight === 'number' && Number.isFinite(args.topoheight)
      ? args.topoheight
      : null

  const narrative = buildNarrative(args.scid, responseTopoheight, surface, kind)

  // Compose the payload, then attach static citations and re-order so the
  // heuristic's pick is first. Static citation order (in RELATED_DOCS_BY_TOOL)
  // ends up as the fallback order when the heuristic returns a slug already
  // at position 0.
  const payload = attachCitations(
    {
      scid: args.scid,
      topoheight: responseTopoheight,
      kind,
      surface: {
        functions: surface.functions,
        stringkeys: surface.stringkeys,
        uint64keys: surface.uint64keys,
        stringkeys_total: surface.stringkeys_total,
        uint64keys_total: surface.uint64keys_total,
        stringkeys_truncated: surface.stringkeys_truncated,
        uint64keys_truncated: surface.uint64keys_truncated,
        balances: surface.balances,
      },
      narrative,
      raw_code_length: surface.raw_code_length,
      has_code: surface.has_code,
    },
    'explain_smart_contract',
  )

  if (payload.related_docs && payload.related_docs.length > 0) {
    const idx = payload.related_docs.findIndex((d) => d.slug === primarySlug)
    if (idx > 0) {
      const [picked] = payload.related_docs.splice(idx, 1)
      payload.related_docs.unshift(picked)
    }
  }

  return payload
}
