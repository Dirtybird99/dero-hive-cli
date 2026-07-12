/**
 * `tela_get_doc_content` — fetch a TELA-DOC-1's actual file content.
 *
 * A TELA-DOC-1 stores its file (HTML/CSS/JS/...) inside a DVM-BASIC comment
 * block in the contract code, NOT in a stored variable. This tool fetches
 * DERO.GetSC (code=true), confirms the SCID is a DOC, and extracts the file
 * content via the shared extractTelaDocContent. Large files are chunked with
 * offset pagination (mirrors dero_docs_get_page).
 *
 * TELA-CLI gzips files (a `.gz` filename), storing them base64-encoded. This
 * tool transparently base64-decodes + gunzips such content (Node's built-in
 * zlib, no new dependency) and returns the real plaintext file — so an agent
 * never has to shell out to decompress.
 *
 * Read-only; one RPC call. We surface the content verbatim and report the
 * author signature's presence — we do NOT claim to have verified it (the
 * server performs no signature check), only that the contract carries one.
 */

import { z } from 'zod'
import zlib from 'node:zlib'
import { Buffer } from 'node:buffer'
import { attachCitations, type DeroDaemonRpc, type DeroGetScResult } from './_shared.js'
import { classifyTela, parseTelaDoc, extractTelaDocContent } from '../tela-parse.js'

const SCID_HEX_REGEX = /^[0-9a-fA-F]{64}$/

// Per-call content cap, matching dero_docs_get_page's PAGE_CONTENT_CHUNK.
const DOC_CONTENT_CHUNK = 60000

/**
 * TELA-CLI stores gzipped DOC files as base64-encoded gzip. Decode + gunzip
 * back to the plaintext file. Defensive: returns null (caller keeps the raw
 * content) if the bytes are not actually base64'd gzip, so a mislabeled or
 * truncated file never throws.
 */
function decompressGzipBase64(content: string): string | null {
  try {
    const buf = Buffer.from(content.trim(), 'base64')
    // gzip magic bytes 0x1f 0x8b — bail early if absent (not really gzip).
    if (buf.length < 2 || buf[0] !== 0x1f || buf[1] !== 0x8b) return null
    return zlib.gunzipSync(buf).toString('utf8')
  } catch {
    return null
  }
}

export const telaGetDocContentInputSchema = {
  scid: z
    .string()
    .regex(SCID_HEX_REGEX, 'Expected 64-character hex Smart Contract ID')
    .describe('64-char hex Smart Contract ID of a TELA-DOC-1 file contract'),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Byte offset into the extracted file content; use next_offset to paginate large files'),
  topoheight: z.number().int().optional().describe('Optional topo height; omit for latest committed state'),
} as const

type TelaGetDocContentInput = { scid: string; offset?: number; topoheight?: number }

export async function telaGetDocContent(rpc: DeroDaemonRpc, args: TelaGetDocContentInput) {
  const params: Record<string, unknown> = { scid: args.scid, code: true, variables: true }
  if (args.topoheight !== undefined) params.topoheight = args.topoheight

  const raw = (await rpc<DeroGetScResult>('DERO.GetSC', params)) ?? {}
  const code = typeof raw.code === 'string' ? raw.code : ''
  const stringkeys =
    raw.stringkeys && typeof raw.stringkeys === 'object'
      ? (raw.stringkeys as Record<string, unknown>)
      : undefined

  const { kind } = classifyTela(stringkeys, code)
  if (kind !== 'tela_doc') {
    // Not a DOC — guide the agent rather than returning empty content.
    const hint =
      kind === 'tela_index'
        ? 'This SCID is a TELA-INDEX-1 manifest, not a DOC. Use tela_inspect to list its DOC SCIDs, then call this tool on a DOC.'
        : 'This SCID is not a TELA-DOC-1 contract. Use tela_inspect or explain_smart_contract to identify it.'
    throw new Error(`INVALID_INPUT: ${hint}`)
  }

  const doc = parseTelaDoc(stringkeys, code)
  const extracted = extractTelaDocContent(code)

  const responseTopoheight =
    typeof args.topoheight === 'number' && Number.isFinite(args.topoheight) ? args.topoheight : null

  // A `.gz` filename means TELA-CLI stored the file as base64'd gzip.
  // Transparently decompress to the plaintext file so the agent reads real
  // HTML/JS/CSS, not a compressed blob. If decompression fails (not actually
  // gzip), fall back to the raw content and flag it.
  const rawExtracted = extracted.content ?? ''
  const looksGzipped = !!doc.filename && /\.gz$/i.test(doc.filename)
  let decompressed = false
  let decompressFailed = false
  let full = rawExtracted
  let displayFilename = doc.filename
  if (looksGzipped && extracted.embedded && rawExtracted) {
    const out = decompressGzipBase64(rawExtracted)
    if (out !== null) {
      full = out
      decompressed = true
      // Surface the real filename (strip the .gz the user never sees).
      displayFilename = doc.filename!.replace(/\.gz$/i, '')
    } else {
      decompressFailed = true
    }
  }

  const total = full.length
  const offset = Math.max(0, Math.min(args.offset ?? 0, total))
  const end = Math.min(offset + DOC_CONTENT_CHUNK, total)
  const truncated = end < total

  const note = extracted.note
    ? extracted.note
    : decompressed
      ? `File was gzip-compressed on-chain (stored as ${doc.filename}); transparently decompressed to plaintext here.`
      : decompressFailed
        ? `Filename is ${doc.filename} but the content did not decode as base64 gzip; returning raw bytes.`
        : undefined

  const payload = {
    scid: args.scid,
    topoheight: responseTopoheight,
    filename: displayFilename,
    stored_filename: doc.filename,
    doc_type: doc.doc_type,
    sub_dir: doc.sub_dir,
    content_embedded: extracted.embedded,
    content: extracted.embedded ? full.slice(offset, end) : null,
    content_offset: extracted.embedded ? offset : null,
    content_length: total,
    content_truncated: truncated,
    next_offset: truncated ? end : null,
    compressed: looksGzipped,
    decompressed,
    signature: doc.signature,
    signature_note:
      'The contract carries an author signature (fileCheckC/S). This tool reports its presence but does NOT cryptographically verify it.',
    note,
    narrative: extracted.embedded
      ? `Fetched ${total} bytes of "${displayFilename ?? 'file'}" (${doc.doc_type ?? 'unknown type'}) from TELA-DOC-1 ${args.scid}.${decompressed ? ' Gzip content was decompressed to plaintext.' : ''}${truncated ? ` Returning bytes ${offset}–${end}; paginate with next_offset.` : ''}`
      : `TELA-DOC-1 ${args.scid} ("${doc.filename ?? 'file'}") has no inline file content (${extracted.note ?? 'DocShard, STATIC, or external'}).`,
  }

  return attachCitations(payload, 'tela_get_doc_content')
}
