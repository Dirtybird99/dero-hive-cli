/**
 * `tela_inspect` — foundation TELA chain tool.
 *
 * Given a SCID, fetch DERO.GetSC (code + variables) once and parse it as a
 * TELA-INDEX-1 app manifest, a TELA-DOC-1 file contract, or report not_tela.
 * Reads the RAW (uncapped) stringkeys directly via the shared tela-parse
 * module so a large INDEX's full DOC1..DOCn list enumerates (extractScSurface
 * would cap at 50 and silently drop entries).
 *
 * Read-only; one RPC call. Never throws on a non-TELA contract — returns
 * kind:'not_tela' with a forensic hint, which is a SUCCESS, not an error.
 */

import { z } from 'zod'
import { attachCitations, type DeroDaemonRpc, type DeroGetScResult } from './_shared.js'
import {
  classifyTela,
  parseTelaIndex,
  parseTelaDoc,
  type TelaIndexParsed,
  type TelaDocParsed,
} from '../tela-parse.js'

const SCID_HEX_REGEX = /^[0-9a-fA-F]{64}$/

export const telaInspectInputSchema = {
  scid: z
    .string()
    .regex(SCID_HEX_REGEX, 'Expected 64-character hex Smart Contract ID')
    .describe('64-char hex Smart Contract ID of a TELA-INDEX-1 or TELA-DOC-1 contract'),
  topoheight: z
    .number()
    .int()
    .optional()
    .describe('Optional topo height; omit for the latest committed state'),
} as const

type TelaInspectInput = { scid: string; topoheight?: number }

function asStringkeys(raw: DeroGetScResult): Record<string, unknown> | undefined {
  return raw.stringkeys && typeof raw.stringkeys === 'object'
    ? (raw.stringkeys as Record<string, unknown>)
    : undefined
}

function indexNarrative(scid: string, topoheight: number | null, idx: TelaIndexParsed): string {
  const at = `topoheight ${topoheight ?? 'tip'}`
  const name = idx.name ?? '(unnamed)'
  const durl = idx.durl ? ` (${idx.durl})` : ''
  const docWord = idx.doc_count === 1 ? 'file' : 'files'
  const entry = idx.docs.find((d) => d.is_entrypoint)
  const entryNote = entry
    ? ` Entrypoint DOC1 → ${entry.scid}.`
    : ' No DOC1 entrypoint found (the app may not render).'
  const modNote = idx.mods.length ? ` MODs: ${idx.mods.join(', ')}.` : ''
  const commitNote =
    idx.commit !== null ? ` At commit ${idx.commit} (${idx.version_history.length} version(s) on chain).` : ''
  return `SCID ${scid} at ${at} is a TELA-INDEX-1 app manifest "${name}"${durl}, referencing ${idx.doc_count} ${docWord}.${entryNote}${modNote}${commitNote} ${idx.updateable_note}`
}

function docNarrative(scid: string, topoheight: number | null, doc: TelaDocParsed): string {
  const at = `topoheight ${topoheight ?? 'tip'}`
  const name = doc.filename ?? '(unnamed file)'
  const type = doc.doc_type ?? 'unknown type'
  const sub = doc.sub_dir ? ` under ${doc.sub_dir}` : ''
  const sig = doc.signature.present ? 'signed by its author' : 'missing a complete signature'
  const embed = doc.content_embedded
    ? 'Its file content is embedded in the contract code (fetch it with tela_get_doc_content).'
    : 'Its file content is NOT embedded inline (DocShard, STATIC, or external).'
  return `SCID ${scid} at ${at} is a TELA-DOC-1 file contract for "${name}"${sub} (${type}), ${sig}. ${embed} This contract is immutable.`
}

export async function telaInspect(rpc: DeroDaemonRpc, args: TelaInspectInput) {
  const params: Record<string, unknown> = { scid: args.scid, code: true, variables: true }
  if (args.topoheight !== undefined) params.topoheight = args.topoheight

  // Required call. Failure propagates through withStructuredErrors.
  const raw = (await rpc<DeroGetScResult>('DERO.GetSC', params)) ?? {}
  const code = typeof raw.code === 'string' ? raw.code : ''
  const stringkeys = asStringkeys(raw)
  const uintVariables =
    raw.uint64keys && typeof raw.uint64keys === 'object'
      ? (raw.uint64keys as Record<string, unknown>)
      : undefined

  const responseTopoheight =
    typeof args.topoheight === 'number' && Number.isFinite(args.topoheight) ? args.topoheight : null

  const { kind, markers, collision } = classifyTela(stringkeys, code)

  let payload: Record<string, unknown>

  if (kind === 'tela_index') {
    const index = parseTelaIndex(stringkeys, uintVariables)
    payload = {
      scid: args.scid,
      topoheight: responseTopoheight,
      kind,
      index,
      collision,
      has_code: code.length > 0,
      raw_code_length: code.length,
      narrative: indexNarrative(args.scid, responseTopoheight, index),
    }
  } else if (kind === 'tela_doc') {
    const doc = parseTelaDoc(stringkeys, code)
    payload = {
      scid: args.scid,
      topoheight: responseTopoheight,
      kind,
      doc,
      has_code: code.length > 0,
      raw_code_length: code.length,
      narrative: docNarrative(args.scid, responseTopoheight, doc),
    }
  } else {
    const allKeys = stringkeys ? Object.keys(stringkeys) : []
    payload = {
      scid: args.scid,
      topoheight: responseTopoheight,
      kind: 'not_tela',
      reason:
        code.length === 0
          ? 'SCID returned no on-chain code (unknown contract, or never deployed).'
          : 'Contract code/state lacks TELA-INDEX-1 or TELA-DOC-1 marker keys (dURL/DOC1 or docType/fileCheck).',
      observed: {
        stringkey_sample: allKeys.slice(0, 20),
        stringkeys_total: allKeys.length,
        has_code: code.length > 0,
        markers,
      },
      narrative: `SCID ${args.scid} at topoheight ${responseTopoheight ?? 'tip'} is not a TELA contract. ${code.length === 0 ? 'It returned no code.' : 'Its stored keys do not match the TELA-INDEX-1 or TELA-DOC-1 schema.'} Use explain_smart_contract for a general DVM analysis.`,
    }
  }

  const withCitations = attachCitations(payload, 'tela_inspect')

  // Elevate the spec matching the detected kind to citation position 0.
  const primarySlug = kind === 'tela_doc' ? 'tela/tela-doc-specification' : 'tela/tela-index-specification'
  if (withCitations.related_docs && withCitations.related_docs.length > 0) {
    const i = withCitations.related_docs.findIndex((d) => d.slug === primarySlug)
    if (i > 0) {
      const [picked] = withCitations.related_docs.splice(i, 1)
      withCitations.related_docs.unshift(picked)
    }
  }

  return withCitations
}
