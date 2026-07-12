/**
 * Shared TELA contract parser — the single source of truth for classifying and
 * decoding TELA-INDEX-1 / TELA-DOC-1 contracts from a raw `DERO.GetSC` payload.
 *
 * Three composites consume this module (tela_inspect, tela_get_doc_content, and
 * the TELA-aware branch of explain_smart_contract), so the detection heuristic
 * and the file-content extraction live here exactly once — the three surfaces
 * can never disagree on what a SCID is or where a DOC's bytes are.
 *
 * Pure and dependency-free (no rpc, no citations, no narrative): trivially
 * unit-testable offline against fixtures. Every function is null-tolerant and
 * NEVER throws — a malformed or non-TELA contract degrades to `not_tela` or a
 * partial parse with `parse_notes`, never an exception.
 *
 * On-chain schema (from the civilware/tela `parse.go` spec, last updated
 * 2025-10-22). NOT yet validated against a live mainnet SCID — hence the
 * defensive posture. See data/docs-index.json tela/tela-index-specification and
 * tela/tela-doc-specification for the authoritative field list.
 */

export type TelaKind = 'tela_index' | 'tela_doc' | 'not_tela'

export type TelaClassification = {
  kind: TelaKind
  /** Which marker signals fired (e.g. 'key:dURL', 'code:docType'). For diagnostics. */
  markers: string[]
  /** True when BOTH index and doc markers were present (precedence → tela_index). */
  collision: boolean
}

export type TelaDocRef = {
  position: number
  key: string
  scid: string
  is_entrypoint: boolean
  /** True when the stored value is not a 64-char hex SCID (kept raw, flagged). */
  malformed: boolean
}

export type TelaIndexParsed = {
  name: string | null
  description: string | null
  icon: string | null
  durl: string | null
  mods: string[]
  docs: TelaDocRef[]
  doc_count: number
  commit: number | null
  version_history: { commit: number; txid: string }[]
  current_commit_hash: string | null
  owner: string | null
  tela_version: string | null
  likes: number | null
  dislikes: number | null
  /** Per-wallet ratings summary (voters + raw values), or null if none. */
  ratings: { voters: number; values: number[] } | null
  /** GetSC does not expose ringsize, so updateability cannot be derived. */
  updateable: 'unknown'
  updateable_note: string
  parse_notes: string[]
}

export type TelaDocParsed = {
  filename: string | null
  description: string | null
  icon: string | null
  durl: string | null
  doc_type: string | null
  sub_dir: string | null
  signature: { present: boolean; file_check_c_present: boolean; file_check_s_present: boolean }
  content_embedded: boolean
  code_size_bytes: number
  immutable: true
  parse_notes: string[]
}

export type TelaDocContent = {
  content: string | null
  embedded: boolean
  note?: string
}

const SCID_HEX = /^[0-9a-fA-F]{64}$/
const DOC_KEY = /^DOC(\d+)$/

const UPDATEABLE_NOTE =
  'Updateability depends on the install ringsize (ringsize 2 = owner-updateable, ' +
  '> 2 = permanently immutable), which DERO.GetSC does not expose. Cannot be ' +
  'determined from chain state here; check the install transaction ringsize.'

/**
 * DERO.GetSC returns stored STRING-key values hex-encoded. A TELA app's
 * var_header_name "Crypto hammer" comes back as "43727970746f2068616d6d6572",
 * and a DOC SCID comes back as the 128-char hex encoding of its 64-char hex
 * string. This decodes such values back to text.
 *
 * Defensive: only decodes when the value is even-length hex that decodes to
 * printable UTF-8 (no control chars / replacement chars); otherwise returns the
 * value unchanged. So already-plain values, short counters, and binary blobs
 * pass through untouched and we never throw or corrupt a value.
 */
function decodeScValue(value: unknown): string | null {
  if (typeof value !== 'string') return value == null ? null : String(value)
  const v = value
  if (v.length === 0) return ''
  if (v.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(v)) return v
  try {
    const decoded = Buffer.from(v, 'hex').toString('utf8')
    // Reject if decoding produced control chars or U+FFFD (not real text).
    if (/[\u0000-\u0008\u000e-\u001f\ufffd]/.test(decoded)) return v
    return decoded
  } catch {
    return v
  }
}

/** Null-tolerant, hex-decoded string read from a stringkeys map. */
function readStr(stringkeys: Record<string, unknown> | undefined, key: string): string | null {
  if (!stringkeys || !(key in stringkeys)) return null
  return decodeScValue(stringkeys[key])
}

/** Null-tolerant non-negative integer read (number, numeric string, or decoded). */
function readUint(stringkeys: Record<string, unknown> | undefined, key: string): number | null {
  if (!stringkeys || !(key in stringkeys)) return null
  const raw = stringkeys[key]
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  const s = decodeScValue(raw)
  return s !== null && /^\d+$/.test(s) ? Number(s) : null
}

function keySet(map: Record<string, unknown> | undefined): Set<string> {
  return new Set(map ? Object.keys(map) : [])
}

/**
 * Classify a contract as TELA-INDEX-1, TELA-DOC-1, or not-TELA from BOTH the
 * raw stringkeys AND the raw code. Taking both signals is deliberate: the
 * stringkey-driven tool (tela_inspect) and the code-literal-driven tool
 * (explain_smart_contract) call this same function so they always agree.
 *
 * DOC is checked FIRST: its docType + fileCheckC/S pair is unique, and a DOC
 * also carries `dURL`, so it must be ruled out before the INDEX check (which
 * keys on dURL + DOC1/commit). Never throws; '' code → all .includes false.
 */
export function classifyTela(
  stringkeys: Record<string, unknown> | undefined,
  code: string,
): TelaClassification {
  const keys = keySet(stringkeys)
  const src = typeof code === 'string' ? code : ''
  const markers: string[] = []

  // --- TELA-DOC-1 markers (docType + a fileCheck signature value) ---
  const docKey = keys.has('docType')
  const docSigKey = keys.has('fileCheckC') || keys.has('fileCheckS')
  const docCode = src.includes('docType')
  const docSigCode = src.includes('fileCheckC') || src.includes('fileCheckS')
  if (docKey) markers.push('key:docType')
  if (docSigKey) markers.push('key:fileCheck')
  if (docCode) markers.push('code:docType')
  if (docSigCode) markers.push('code:fileCheck')
  const isDoc = (docKey || docCode) && (docSigKey || docSigCode)

  // --- TELA-INDEX-1 markers (dURL + DOC1/commit) ---
  const durlKey = keys.has('dURL')
  const durlCode = src.includes('dURL')
  const doc1Key = keys.has('DOC1')
  const doc1Code = /\bDOC1\b/.test(src)
  const commitKey = keys.has('commit')
  const commitCode = /\bcommit\b/.test(src)
  if (durlKey) markers.push('key:dURL')
  if (doc1Key) markers.push('key:DOC1')
  if (commitKey) markers.push('key:commit')
  const isIndex = (durlKey || durlCode) && (doc1Key || doc1Code || commitKey || commitCode)

  if (isDoc && isIndex) {
    // Both marker sets present — should not happen on a well-formed contract.
    // Precedence: INDEX (a DOC never carries DOC1/commit legitimately).
    return { kind: 'tela_index', markers, collision: true }
  }
  if (isDoc) return { kind: 'tela_doc', markers, collision: false }
  if (isIndex) return { kind: 'tela_index', markers, collision: false }
  return { kind: 'not_tela', markers, collision: false }
}

/**
 * Parse a TELA-INDEX-1 manifest from RAW (uncapped) stringkeys/uint64keys.
 * Reads the maps directly — NOT via extractScSurface, whose 50-key cap would
 * silently drop DOCn entries on a large manifest (~120 DOCs possible).
 */
export function parseTelaIndex(
  stringkeys: Record<string, unknown> | undefined,
  uint64keys: Record<string, unknown> | undefined,
): TelaIndexParsed {
  const notes: string[] = []
  const sk = stringkeys ?? {}

  // Real contracts store the name under var_header_name OR var_nameHdr.
  const name = readStr(sk, 'var_header_name') ?? readStr(sk, 'var_nameHdr')
  const durl = readStr(sk, 'dURL')
  if (!name) notes.push('Missing app name (var_header_name / var_nameHdr).')
  if (!durl) notes.push('Missing dURL (app identifier).')

  const modsRaw = readStr(sk, 'mods') ?? ''
  const mods = modsRaw
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean)

  // Enumerate ALL DOCn keys directly from the raw map, ordered by index.
  // Values are hex-encoded SCIDs (128 hex chars decoding to a 64-char hex
  // SCID), so decode first, then validate.
  const docs: TelaDocRef[] = []
  for (const key of Object.keys(sk)) {
    const m = DOC_KEY.exec(key)
    if (!m) continue
    const position = Number(m[1])
    const scid = decodeScValue(sk[key]) ?? ''
    const malformed = !SCID_HEX.test(scid)
    docs.push({ position, key, scid, is_entrypoint: position === 1, malformed })
  }
  docs.sort((a, b) => a.position - b.position)
  if (docs.length === 0) notes.push('No DOCn references found (INDEX has no files listed).')
  if (docs.some((d) => d.malformed)) notes.push('One or more DOC values are not 64-hex SCIDs.')

  // commit counter: prefer uint64keys, tolerate a numeric string in stringkeys.
  let commit: number | null = null
  const commitU = uint64keys?.['commit']
  if (typeof commitU === 'number') commit = commitU
  else if (typeof commitU === 'string' && /^\d+$/.test(commitU)) commit = Number(commitU)
  else {
    const commitS = sk['commit']
    if (typeof commitS === 'number') commit = commitS
    else if (typeof commitS === 'string' && /^\d+$/.test(commitS)) commit = Number(commitS)
  }

  // version_history: numbered keys "0","1","2"... → commit TXIDs, numeric
  // order. Real contracts store these in uint64keys (observed on feed.tela),
  // though the spec template shows stringkeys — scan BOTH so neither is missed.
  const uk = uint64keys ?? {}
  const version_history: { commit: number; txid: string }[] = []
  const seenCommits = new Set<number>()
  for (const map of [sk, uk]) {
    for (const key of Object.keys(map)) {
      if (!/^\d+$/.test(key)) continue
      const n = Number(key)
      if (seenCommits.has(n)) continue
      const txid = decodeScValue(map[key])
      if (txid) {
        version_history.push({ commit: n, txid })
        seenCommits.add(n)
      }
    }
  }
  version_history.sort((a, b) => a.commit - b.commit)

  // ratings: per-wallet keys map a voter address → "<rating>_<block>" (a TELA
  // convention). Summarize so an agent doesn't have to reverse-engineer it.
  const ratings: { voters: number; values: number[] } = { voters: 0, values: [] }
  for (const key of Object.keys(sk)) {
    if (!/^(dero1|deto1)[0-9a-z]+$/i.test(key)) continue
    const val = readStr(sk, key) ?? ''
    const m = /^(\d+)_/.exec(val)
    if (m) {
      ratings.voters += 1
      ratings.values.push(Number(m[1]))
    }
  }

  // Optional metadata seen on real INDEX contracts (not in the base spec).
  const tela_version = readStr(sk, 'telaVersion')
  const likes = readUint(sk, 'likes')
  const dislikes = readUint(sk, 'dislikes')

  return {
    name,
    description: readStr(sk, 'var_header_description'),
    icon: readStr(sk, 'var_header_icon'),
    durl,
    mods,
    docs,
    doc_count: docs.length,
    commit,
    version_history,
    current_commit_hash: readStr(sk, 'hash'),
    owner: readStr(sk, 'owner'),
    tela_version,
    likes,
    dislikes,
    ratings: ratings.voters > 0 ? ratings : null,
    updateable: 'unknown',
    updateable_note: UPDATEABLE_NOTE,
    parse_notes: notes,
  }
}

/**
 * Parse a TELA-DOC-1 file contract. Reads header vars from stringkeys and
 * determines whether the file content is embedded in the code (via
 * extractTelaDocContent). Never exposes the raw signature values.
 */
export function parseTelaDoc(
  stringkeys: Record<string, unknown> | undefined,
  code: string,
): TelaDocParsed {
  const notes: string[] = []
  const sk = stringkeys ?? {}
  const src = typeof code === 'string' ? code : ''

  const filename = readStr(sk, 'var_header_name')
  const doc_type = readStr(sk, 'docType')
  if (!filename) notes.push('Missing var_header_name (DOC filename).')
  if (!doc_type) notes.push('Missing docType.')

  const cPresent = typeof sk['fileCheckC'] === 'string'
  const sPresent = typeof sk['fileCheckS'] === 'string'
  if (!cPresent || !sPresent) notes.push('Incomplete cryptographic signature (fileCheckC/fileCheckS).')

  const extracted = extractTelaDocContent(src)
  if (!extracted.embedded && extracted.note) notes.push(extracted.note)

  return {
    filename,
    description: readStr(sk, 'var_header_description'),
    icon: readStr(sk, 'var_header_icon'),
    durl: readStr(sk, 'dURL'),
    doc_type,
    sub_dir: readStr(sk, 'subDir'),
    signature: {
      present: cPresent && sPresent,
      file_check_c_present: cPresent,
      file_check_s_present: sPresent,
    },
    content_embedded: extracted.embedded,
    code_size_bytes: src.length,
    immutable: true,
    parse_notes: notes,
  }
}

/**
 * Extract a TELA-DOC-1's file content from the contract code. The DOC template
 * stores the file inside a DVM-BASIC `/* ... *\/` comment block that follows the
 * `End Function` of InitializePrivate. We locate the LAST `End Function`, then
 * the first `/*` after it, then the matching closing `*\/`.
 *
 * Defensive against the documented gotcha (a user file containing `*\/`
 * mid-content breaks deployment, so well-formed on-chain content has none — but
 * a corrupt/old contract might): we take content up to the FINAL `*\/` so a
 * stray mid-content `*\/` truncates rather than throws, and flag it via note.
 * Never throws.
 */
export function extractTelaDocContent(code: string): TelaDocContent {
  const src = typeof code === 'string' ? code : ''
  if (!src) return { content: null, embedded: false, note: 'Contract has no code.' }

  // Find the comment block after the last End Function.
  const efIdx = src.toLowerCase().lastIndexOf('end function')
  const searchFrom = efIdx >= 0 ? efIdx : 0
  const open = src.indexOf('/*', searchFrom)
  if (open < 0) {
    return {
      content: null,
      embedded: false,
      note: 'No /* ... */ content block found after End Function (DocShard, STATIC, or external-content DOC).',
    }
  }
  const close = src.lastIndexOf('*/')
  if (close <= open + 2) {
    return { content: null, embedded: false, note: 'Content comment block is unterminated or empty.' }
  }

  const content = src.slice(open + 2, close)
  // A stray */ before the final one would have been swallowed by the lastIndexOf
  // span; flag if the content still contains one (corrupt contract).
  const note = content.includes('*/')
    ? 'Content contains a */ sequence; on-chain content may be malformed or truncated.'
    : undefined
  return { content: content.replace(/^\n+|\n+$/g, ''), embedded: true, note }
}
