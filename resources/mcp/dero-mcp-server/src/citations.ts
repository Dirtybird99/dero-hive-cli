/**
 * Citation helper for DERO MCP tool responses.
 *
 * The wedge for this server is the combination of live chain reads and the
 * in-process bundled docs index (145+ pages across derod, tela, hologram,
 * deropay). Citations let agents link their responses back to authoritative
 * docs without a second tool call, and they give downstream composite tools
 * a uniform shape to compose.
 *
 * Design contract:
 *   - One shape, used by primitives and composites alike.
 *   - URLs are produced by the same builder used by `dero_docs_*` so the
 *     citation always points at the same canonical page the agent would
 *     reach via dero_docs_get_page.
 *   - The slug is duplicated as `page_id` to give composites a stable join
 *     key across tools (mirrors the FoodNearMe COMPOSITES.md citation pattern).
 *   - The map of related docs per tool is hand-maintained and validated by
 *     `scripts/check-citations.ts` (added alongside this helper) so a docs
 *     reorganization cannot silently produce 404 citations in production.
 */

import { DOC_BASE_URLS, type DeroDocProduct } from './docs-parse.js'

export type DeroCitation = {
  /** Always `'dero_docs'` for now; future sources (e.g. `'dero_chain'`) can extend this. */
  source: 'dero_docs'
  product: DeroDocProduct
  slug: string
  title: string
  canonical_url: string
  /** Alias of `slug` so composites can use a single join key across tools. */
  page_id: string
}

function buildCanonicalUrl(product: DeroDocProduct, slug: string): string {
  const trimmed = slug.replace(/^\/+|\/+$/g, '')
  if (!trimmed) return `${DOC_BASE_URLS[product]}/`
  // .md mirror suffix points agents at the LLM-canonical Markdown surface.
  // All four ecosystem sites (derod, tela, hologram, deropay) now ship the
  // App Router .md mirror route, so the suffix applies universally.
  return `${DOC_BASE_URLS[product]}/${trimmed}.md`
}

/**
 * Build a DeroCitation pointing at one bundled docs page.
 *
 * The title is required (not derived from the bundled index) so this helper
 * stays synchronous and zero-IO. It must match the docs page title; the
 * citation guard validates this against the bundled index in CI.
 */
export function buildDeroCitation(
  product: DeroDocProduct,
  slug: string,
  title: string,
): DeroCitation {
  return {
    source: 'dero_docs',
    product,
    slug,
    title,
    canonical_url: buildCanonicalUrl(product, slug),
    page_id: slug,
  }
}

/**
 * Map of MCP tool name → hand-curated related docs pages.
 *
 * Keep this list tight — only add entries when a tool's response is
 * meaningfully improved by linking the agent at a specific page. The CI
 * guard verifies every slug resolves against the bundled docs index, so any
 * docs reorganization will fail the build before it ships.
 *
 * Adding a tool here:
 *   1. Use `dero_docs_search` to find the right slug(s).
 *   2. Add an entry with product + slug + exact page title.
 *   3. Run `npm run check:citations` to confirm slugs resolve.
 */
type RelatedDocsEntry = { product: DeroDocProduct; slug: string; title: string }

export const RELATED_DOCS_BY_TOOL: Record<string, readonly RelatedDocsEntry[]> = {
  dero_get_info: [
    {
      product: 'derod',
      slug: 'rpc-api/daemon-rpc-api',
      title: 'DERO Daemon RPC API: Complete Reference Guide | DERO Blockchain',
    },
    {
      product: 'derod',
      slug: 'basics/daemon',
      title: 'DERO Daemon: Backbone of the Privacy Blockchain | DERO Blockchain',
    },
  ],
  dero_get_sc: [
    {
      product: 'derod',
      slug: 'dvm/smart-contract-fundamentals',
      title: 'Smart Contract Fundamentals: Understanding DERO Contracts | DERO Blockchain',
    },
    {
      product: 'derod',
      slug: 'dvm/dero-virtual-machine',
      title: 'DERO Virtual Machine (DVM): Private Smart Contract Platform | DERO Blockchain',
    },
  ],
  dero_get_gas_estimate: [
    {
      product: 'derod',
      slug: 'rpc-api/daemon-rpc-api',
      title: 'DERO Daemon RPC API: Complete Reference Guide | DERO Blockchain',
    },
    {
      product: 'derod',
      slug: 'dvm/create-deploy-use-smart-contract',
      title: 'Create, Deploy & Use a Smart Contract on DERO | Step-by-Step Tutorial',
    },
  ],
  diagnose_chain_health: [
    {
      product: 'derod',
      slug: 'basics/daemon',
      title: 'DERO Daemon: Backbone of the Privacy Blockchain | DERO Blockchain',
    },
    {
      product: 'derod',
      slug: 'rpc-api/daemon-rpc-api',
      title: 'DERO Daemon RPC API: Complete Reference Guide | DERO Blockchain',
    },
  ],
  trace_transaction_with_context: [
    {
      product: 'derod',
      slug: 'rpc-api/daemon-rpc-api',
      title: 'DERO Daemon RPC API: Complete Reference Guide | DERO Blockchain',
    },
    {
      product: 'derod',
      slug: 'dvm/smart-contract-fundamentals',
      title: 'Smart Contract Fundamentals: Understanding DERO Contracts | DERO Blockchain',
    },
  ],
  estimate_deploy_cost: [
    {
      product: 'derod',
      slug: 'dvm/create-deploy-use-smart-contract',
      title: 'Create, Deploy & Use a Smart Contract on DERO | Step-by-Step Tutorial',
    },
    {
      product: 'derod',
      slug: 'dvm/dvm-basic',
      title: "DVM-BASIC: DERO's Smart Contract Language Guide | DERO Blockchain",
    },
  ],
  dero_decode_proof_string: [
    {
      product: 'derod',
      slug: 'integrity/payload-vs-transaction-proofs',
      title: 'Proof Types Explained: Transaction vs. Payload Proofs | DERO Blockchain',
    },
    {
      product: 'derod',
      slug: 'integrity/negative-transfer-protection',
      title: 'Negative Transfer Protection: Cryptographic Impossibility | DERO Blockchain',
    },
  ],
  audit_chain_artifact_claim: [
    {
      product: 'derod',
      slug: 'integrity/payload-vs-transaction-proofs',
      title: 'Proof Types Explained: Transaction vs. Payload Proofs | DERO Blockchain',
    },
    {
      product: 'derod',
      slug: 'integrity/negative-transfer-protection',
      title: 'Negative Transfer Protection: Cryptographic Impossibility | DERO Blockchain',
    },
  ],
  dero_forge_demo_proof: [
    {
      product: 'derod',
      slug: 'integrity/payload-vs-transaction-proofs',
      title: 'Proof Types Explained: Transaction vs. Payload Proofs | DERO Blockchain',
    },
    {
      product: 'derod',
      slug: 'integrity/negative-transfer-protection',
      title: 'Negative Transfer Protection: Cryptographic Impossibility | DERO Blockchain',
    },
    {
      product: 'derod',
      slug: 'integrity/range-proof-integrity',
      title: "Range Proof Integrity: How DERO's Bulletproof Binds Amounts | DERO Blockchain",
    },
  ],
  // Composite #2 (`explain_smart_contract`) curates all four DVM docs so its
  // heuristic can elevate whichever page best matches the detected surface
  // (token / registry / minimal / generic). The composite re-orders this
  // array at runtime; the static ordering here is the fallback when the
  // heuristic returns the same slug already at index 0 (the universal
  // "fundamentals" default).
  explain_smart_contract: [
    {
      product: 'derod',
      slug: 'dvm/smart-contract-fundamentals',
      title: 'Smart Contract Fundamentals: Understanding DERO Contracts | DERO Blockchain',
    },
    {
      product: 'derod',
      slug: 'dvm/dvm-basic',
      title: "DVM-BASIC: DERO's Smart Contract Language Guide | DERO Blockchain",
    },
    {
      product: 'derod',
      slug: 'dvm/dero-virtual-machine',
      title: 'DERO Virtual Machine (DVM): Private Smart Contract Platform | DERO Blockchain',
    },
    {
      product: 'derod',
      slug: 'dvm/create-deploy-use-smart-contract',
      title: 'Create, Deploy & Use a Smart Contract on DERO | Step-by-Step Tutorial',
    },
    // TELA specs: elevated when the classifier detects a tela_index / tela_doc
    // contract (the heuristic re-orders the matching spec to position 0).
    {
      product: 'tela',
      slug: 'tela/tela-index-specification',
      title: 'TELA-INDEX-1 Specification | Application Manifest Smart Contract Standard',
    },
    {
      product: 'tela',
      slug: 'tela/tela-doc-specification',
      title: 'TELA-DOC-1 Specification | Smart Contract Standard for File Storage',
    },
  ],
  // tela_inspect curates both specs (so the matching one elevates per kind),
  // plus dURL and Gnomon context for the builder.
  tela_inspect: [
    {
      product: 'tela',
      slug: 'tela/tela-index-specification',
      title: 'TELA-INDEX-1 Specification | Application Manifest Smart Contract Standard',
    },
    {
      product: 'tela',
      slug: 'tela/tela-doc-specification',
      title: 'TELA-DOC-1 Specification | Smart Contract Standard for File Storage',
    },
    {
      product: 'tela',
      slug: 'advanced-features/durl-explained',
      title: 'Understanding dURLs | Decentralized URL Identity & Resolution',
    },
    {
      product: 'tela',
      slug: 'tela-cli/gnomon-guide',
      title: 'Gnomon Indexer Deep-Dive Guide | TELA Content Discovery and Indexing',
    },
  ],
  tela_get_doc_content: [
    {
      product: 'tela',
      slug: 'tela/tela-doc-specification',
      title: 'TELA-DOC-1 Specification | Smart Contract Standard for File Storage',
    },
    {
      product: 'tela',
      slug: 'tela/tela-index-specification',
      title: 'TELA-INDEX-1 Specification | Application Manifest Smart Contract Standard',
    },
  ],
  dero_durl_to_scid: [
    {
      product: 'tela',
      slug: 'advanced-features/durl-explained',
      title: 'Understanding dURLs | Decentralized URL Identity & Resolution',
    },
    {
      product: 'tela',
      slug: 'tela-cli/gnomon-guide',
      title: 'Gnomon Indexer Deep-Dive Guide | TELA Content Discovery and Indexing',
    },
  ],
  dero_tela_list_apps: [
    {
      product: 'tela',
      slug: 'tela-cli/gnomon-guide',
      title: 'Gnomon Indexer Deep-Dive Guide | TELA Content Discovery and Indexing',
    },
    {
      product: 'tela',
      slug: 'tela/tela-index-specification',
      title: 'TELA-INDEX-1 Specification | Application Manifest Smart Contract Standard',
    },
  ],
} as const

/**
 * Resolve the hand-curated related docs list for a tool name and return it
 * as fully-built `DeroCitation` objects. Returns `undefined` when the tool
 * has no related docs configured.
 *
 * Use in tool handlers like:
 *   const related_docs = relatedDocsFor('dero_get_sc')
 *   return { ...rpcResult, ...(related_docs ? { related_docs } : {}) }
 */
export function relatedDocsFor(toolName: string): DeroCitation[] | undefined {
  const entries = RELATED_DOCS_BY_TOOL[toolName]
  if (!entries || entries.length === 0) return undefined
  return entries.map((entry) => buildDeroCitation(entry.product, entry.slug, entry.title))
}

// ─────────────────────────────────────────────────────────────────────────────
// Flagged chain artifacts — adversarial-context enrichment
//
// Some on-chain artifacts (specific blocks, TX hashes, proof strings) appear in
// publicly circulated false claims about DERO. When any tool returns data
// keyed on such an artifact, we silently attach a `context_note` and a curated
// `related_docs` list pointing at the integrity rebuttal pages.
//
// Design contract:
//   - Match purely on tool inputs (deterministic; no false positives from
//     downstream RPC payload changes).
//   - Same DeroCitation shape so composites can join on `page_id` like any
//     other related doc entry.
//   - Registry is hand-curated; CI guard (`scripts/check-citations.ts`)
//     validates every slug + title against the bundled docs index.
//   - Adding an entry: pick the most rebuttal-relevant pages from the
//     bundled index; keep `context_note` factual (no rhetoric) since hostile
//     readers will quote it.
// ─────────────────────────────────────────────────────────────────────────────

export type FlaggedArtifactMatcher =
  | { kind: 'topoheight'; value: number }
  | { kind: 'block_hash'; value: string }
  | { kind: 'tx_hash'; value: string }
  | { kind: 'proof_string'; value: string }

export type FlaggedArtifact = {
  /** Stable human-readable id for logs and downstream tooling. */
  id: string
  matchers: readonly FlaggedArtifactMatcher[]
  /** Short factual statement appended to responses that match this artifact. */
  context_note: string
  related_docs: readonly RelatedDocsEntry[]
  /**
   * The most rebuttal-relevant signed-DERO amount for `dero_forge_demo_proof`
   * to use when `audit_chain_artifact_claim` is called with
   * `include_forge_demo: true` and this artifact matches. For the 2022 claim
   * this is the report's headline amount — forging the same display number
   * for a non-receiver ring slot is the most direct demonstration that the
   * pasted string is a display object, not a consensus statement.
   */
  demo_amount_dero?: string
}

export const FLAGGED_CHAIN_ARTIFACTS: readonly FlaggedArtifact[] = [
  {
    id: '2022-inflation-claim',
    matchers: [
      { kind: 'topoheight', value: 1_081_893 },
      { kind: 'block_hash', value: 'b6bd914f7fb1c79788fe8676c277e58e7bb5a904317afb096b1d2793af9aed13' },
      { kind: 'tx_hash', value: '5bbe1b7eecfe3447cb045b1197a07a214b456968eda8a3d5a90f5fae9ce57e55' },
      {
        kind: 'proof_string',
        value:
          'deroproof1qyyj0cgu3htmkumr79sgca75vwsx8kx7zkrjg0nfez46w36qyx4kwq9zvfyyskpqvdpcfhkhk4m7y9d77ehyj7yhnnrv9z0tjr9m5fqe2yx9t27dwtdxy4j4r0llll7vcmaxwjcl8jzfq',
      },
    ],
    context_note:
      'This block/transaction/proof string appears in publicly circulated 2022 inflation claims. The cited payload proof is a user-supplied display object — not a consensus record — and the alleged negative-transfer mechanism cannot produce a verifying range proof. See related_docs for the technical rebuttal.',
    demo_amount_dero: '-2200000.00181',
    // TODO: once `integrity/inflation-claim` ships and the bundled docs index
    // refreshes, prepend it as the primary citation:
    //   { product: 'derod', slug: 'integrity/inflation-claim', title: '<exact bundled title>' }
    related_docs: [
      {
        product: 'derod',
        slug: 'integrity/negative-transfer-protection',
        title: 'Negative Transfer Protection: Cryptographic Impossibility | DERO Blockchain',
      },
      {
        product: 'derod',
        slug: 'integrity/payload-vs-transaction-proofs',
        title: 'Proof Types Explained: Transaction vs. Payload Proofs | DERO Blockchain',
      },
      {
        product: 'derod',
        slug: 'integrity/ring-member-behavior',
        title: 'Ring Member Behavior: Understanding Decoy Participation | DERO Blockchain',
      },
    ],
  },
] as const

/**
 * Input shape passed by tool handlers. Optional fields let each tool pass
 * only the inputs it actually has (e.g. dero_get_block_header_by_topo_height
 * only knows about topoheight; dero_get_transaction only knows about
 * tx_hashes). String comparisons are case-insensitive on hex values.
 */
export type FlaggedArtifactQuery = {
  topoheight?: number
  block_hash?: string
  tx_hash?: string
  tx_hashes?: readonly string[]
  proof_string?: string
}

/** Normalize a hex value for case-insensitive comparison. Non-hex strings pass through unchanged. */
function normalizeHex(value: string): string {
  return value.trim().toLowerCase()
}

/**
 * Return all flagged artifacts whose matchers fire against the given inputs.
 *
 * Multiple matches return multiple artifacts (rare today; would happen if the
 * same TX got cited in multiple false claims). Tool handlers should merge all
 * matches into a single response.
 */
export function flaggedArtifactsForInput(
  query: FlaggedArtifactQuery,
): FlaggedArtifact[] {
  const matches: FlaggedArtifact[] = []

  const queryBlockHash = query.block_hash ? normalizeHex(query.block_hash) : undefined
  const queryTxHashes: string[] = []
  if (query.tx_hash) queryTxHashes.push(normalizeHex(query.tx_hash))
  if (query.tx_hashes) for (const h of query.tx_hashes) queryTxHashes.push(normalizeHex(h))
  const queryProof = query.proof_string?.trim()

  for (const artifact of FLAGGED_CHAIN_ARTIFACTS) {
    const hit = artifact.matchers.some((m) => {
      switch (m.kind) {
        case 'topoheight':
          return query.topoheight !== undefined && query.topoheight === m.value
        case 'block_hash':
          return queryBlockHash !== undefined && queryBlockHash === normalizeHex(m.value)
        case 'tx_hash':
          return queryTxHashes.includes(normalizeHex(m.value))
        case 'proof_string':
          return queryProof !== undefined && queryProof === m.value
      }
    })
    if (hit) matches.push(artifact)
  }
  return matches
}

/**
 * Build the response-side enrichment for matched artifacts: a context note
 * (joined if multiple match) plus prepended citations for each match.
 *
 * `baseRelatedDocs` is the tool's existing relatedDocsFor() output (or undefined).
 * Returns `undefined` when no artifacts match — caller should noop in that case.
 *
 * Usage in a tool handler:
 *   const enrichment = enrichWithFlaggedArtifacts(
 *     { topoheight: args.topoheight },
 *     relatedDocsFor('dero_get_block_header_by_topo_height'),
 *   )
 *   return { ...result, ...(enrichment ?? {}) }
 */
export function enrichWithFlaggedArtifacts(
  query: FlaggedArtifactQuery,
  baseRelatedDocs: DeroCitation[] | undefined,
): { context_note: string; related_docs: DeroCitation[] } | undefined {
  const matches = flaggedArtifactsForInput(query)
  if (matches.length === 0) return undefined

  const context_note = matches.map((a) => a.context_note).join('\n\n')

  // Prepend artifact citations (de-duped against baseline by canonical_url).
  const seen = new Set<string>()
  const merged: DeroCitation[] = []
  for (const artifact of matches) {
    for (const entry of artifact.related_docs) {
      const cite = buildDeroCitation(entry.product, entry.slug, entry.title)
      if (!seen.has(cite.canonical_url)) {
        merged.push(cite)
        seen.add(cite.canonical_url)
      }
    }
  }
  if (baseRelatedDocs) {
    for (const cite of baseRelatedDocs) {
      if (!seen.has(cite.canonical_url)) {
        merged.push(cite)
        seen.add(cite.canonical_url)
      }
    }
  }
  return { context_note, related_docs: merged }
}
