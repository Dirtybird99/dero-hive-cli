import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DERO_DOC_PRODUCTS,
  type DeroDocProduct,
  type DeroDocsPage,
  type DocsIndexFile,
  DOCS_STOPWORDS,
  indexDocsFromRoot,
  normalizeSlug,
  pathExists,
  resolveDeroDocsRoot,
  tokenizeForSearch,
} from './docs-parse.js'

export { DERO_DOC_PRODUCTS, type DeroDocProduct, resolveDeroDocsRoot } from './docs-parse.js'

const CACHE_TTL_MS = 15000

type DocsSource =
  | { kind: 'bundled'; indexPath: string }
  | { kind: 'filesystem'; root: string }

type LoadedDocs = {
  source: DocsSource
  pages: DeroDocsPage[]
}

let pageCache: { key: string; loadedAt: number; data: LoadedDocs } | null = null
// Search model is keyed to the same cache window as the pages; rebuilt lazily
// on first search after a (re)load so non-search callers don't pay for it.
let searchModelCache: { key: string; loadedAt: number; model: SearchModel } | null = null

function bundledIndexPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  // dist/docs.js -> ../data/docs-index.json
  return path.resolve(here, '../data/docs-index.json')
}

async function loadBundledPages(indexPath: string): Promise<DeroDocsPage[] | null> {
  if (!(await pathExists(indexPath))) return null
  const raw = await fs.readFile(indexPath, 'utf8')
  const parsed = JSON.parse(raw) as DocsIndexFile
  if (!parsed?.pages?.length) return null
  return parsed.pages
}

async function resolveDocsSource(): Promise<DocsSource | null> {
  const overrideRoot = process.env.DERO_DOCS_ROOT?.trim()
  if (overrideRoot) {
    const derodPages = path.join(overrideRoot, 'derod-main', 'pages')
    if (await pathExists(derodPages)) {
      return { kind: 'filesystem', root: overrideRoot }
    }
  }

  const bundledPath = bundledIndexPath()
  if (await pathExists(bundledPath)) {
    return { kind: 'bundled', indexPath: bundledPath }
  }

  return null
}

async function loadPages(): Promise<LoadedDocs> {
  const source = await resolveDocsSource()
  if (!source) {
    throw new Error(
      'DERO docs unavailable. Bundled docs index missing and DERO_DOCS_ROOT is unset or invalid.',
    )
  }

  const cacheKey = source.kind === 'bundled' ? `bundled:${source.indexPath}` : `fs:${source.root}`
  if (pageCache && pageCache.key === cacheKey && Date.now() - pageCache.loadedAt < CACHE_TTL_MS) {
    return pageCache.data
  }

  let pages: DeroDocsPage[]
  if (source.kind === 'bundled') {
    const bundled = await loadBundledPages(source.indexPath)
    if (!bundled) {
      throw new Error('DERO bundled docs index is missing or empty.')
    }
    pages = bundled
  } else {
    pages = await indexDocsFromRoot(source.root)
  }

  const data: LoadedDocs = { source, pages }
  pageCache = { key: cacheKey, loadedAt: Date.now(), data }
  return data
}

function sourceMeta(source: DocsSource) {
  if (source.kind === 'bundled') {
    return { docs_source: 'bundled' as const, bundled_index: path.basename(source.indexPath) }
  }
  return { docs_source: 'filesystem' as const, docs_root: source.root }
}

type SearchArgs = {
  query: string
  product?: DeroDocProduct
  section?: string
  limit?: number
}

// ---------------- BM25F search model ----------------
//
// Field-weighted BM25 over the shared tokenizer (tokenizeForSearch). Replaces
// the old binary-substring scorePage. The model (per-page field token maps,
// per-field average lengths, corpus document frequencies) is derived in-process
// from the existing index fields — NO index-format change — and cached
// alongside the pages so the ~80ms build cost is paid once per cache window.
//
// Parameters are tuned by empirical sweep against the bundled 147-page corpus
// and the 6 confirmed failure cases, then frozen. They are CI-guarded by
// scripts/check-docs-ranking.ts — do NOT tune any constant here without
// re-running `npm run check:docs-ranking`.

const SEARCH_FIELDS = ['title', 'slug', 'headings', 'description', 'body'] as const
type SearchField = (typeof SEARCH_FIELDS)[number]

// Field boosts: title/slug/headings/description are short, high-signal;
// description was previously unscored dead weight and is now a first-class field.
const FIELD_BOOST: Record<SearchField, number> = {
  title: 10,
  slug: 5,
  headings: 4,
  description: 3,
  body: 1,
}

// Per-field length-normalization strength. b_body=0.7 crushes the 75k-char
// Captain archive's substring advantage; short fields barely vary so they get
// light normalization (heavy norm there only adds noise).
const FIELD_B: Record<SearchField, number> = {
  title: 0.2,
  slug: 0.2,
  headings: 0.2,
  description: 0.2,
  body: 0.7,
}

const BM25_K1 = 1.2

// IDF gate + weights for the field-presence floor (restores the must-not-
// regress query: rewards an on-topic title/heading match for a discriminating
// term, which pure tf-saturation under-weights). Only fires for terms rarer
// than the gate, so corpus-ubiquitous terms like `dero` add no floor.
const PRESENCE_IDF_GATE = 0.25
const PRESENCE_WEIGHT: Partial<Record<SearchField, number>> = {
  title: 3.0,
  headings: 1.5,
  slug: 1.8,
}

type PageFields = Record<SearchField, Map<string, number>>
type PageModel = { page: DeroDocsPage; fields: PageFields; len: Record<SearchField, number> }
type SearchModel = {
  pages: PageModel[]
  avgLen: Record<SearchField, number>
  idf: Map<string, number>
  n: number
}

function tokenizeField(field: SearchField, page: DeroDocsPage): string[] {
  switch (field) {
    case 'title':
      return tokenizeForSearch(page.title)
    case 'slug':
      return tokenizeForSearch(page.slug.replace(/\//g, ' '))
    case 'headings':
      return tokenizeForSearch(page.headings.join(' '))
    case 'description':
      return tokenizeForSearch(page.description ?? '')
    case 'body':
      return tokenizeForSearch(page.plainText)
  }
}

function buildSearchModel(pages: DeroDocsPage[]): SearchModel {
  const n = pages.length
  const totalLen: Record<SearchField, number> = { title: 0, slug: 0, headings: 0, description: 0, body: 0 }
  const df = new Map<string, number>()
  const pageModels: PageModel[] = []

  for (const page of pages) {
    const fields = {} as PageFields
    const len = {} as Record<SearchField, number>
    const pageTerms = new Set<string>()
    for (const field of SEARCH_FIELDS) {
      const toks = tokenizeField(field, page)
      const tf = new Map<string, number>()
      for (const t of toks) {
        tf.set(t, (tf.get(t) ?? 0) + 1)
        pageTerms.add(t)
      }
      fields[field] = tf
      len[field] = toks.length
      totalLen[field] += toks.length
    }
    for (const t of pageTerms) df.set(t, (df.get(t) ?? 0) + 1)
    pageModels.push({ page, fields, len })
  }

  const avgLen = {} as Record<SearchField, number>
  for (const field of SEARCH_FIELDS) avgLen[field] = n > 0 ? totalLen[field] / n : 0

  const idf = new Map<string, number>()
  for (const [term, dfreq] of df) {
    // BM25 probabilistic IDF, uncapped (capping regressed the rare
    // discriminator `monero` in the "dero vs monero" case).
    idf.set(term, Math.log(1 + (n - dfreq + 0.5) / (dfreq + 0.5)))
  }

  return { pages: pageModels, avgLen, idf, n }
}

function scorePageModel(pm: PageModel, queryTerms: string[], model: SearchModel): number {
  let score = 0
  for (const term of queryTerms) {
    const idf = model.idf.get(term)
    if (idf === undefined || idf <= 0) continue

    // Accumulate weighted, per-field length-normalized term frequency.
    let acc = 0
    for (const field of SEARCH_FIELDS) {
      const tf = pm.fields[field].get(term)
      if (!tf) continue
      const b = FIELD_B[field]
      const avg = model.avgLen[field] || 1
      const norm = 1 - b + b * (pm.len[field] / avg)
      acc += (FIELD_BOOST[field] * tf) / norm
    }
    if (acc <= 0) continue

    // BM25 saturation on the accumulated field tf.
    score += idf * ((acc * (BM25_K1 + 1)) / (acc + BM25_K1))

    // IDF-gated field-presence floor for discriminating terms.
    if (idf > PRESENCE_IDF_GATE) {
      let bonus = 0
      for (const field of SEARCH_FIELDS) {
        const w = PRESENCE_WEIGHT[field]
        if (w && pm.fields[field].has(term)) bonus += w
      }
      if (bonus > 0) score += bonus * Math.sqrt(idf)
    }
  }
  return score
}

/**
 * Tokenize a raw query into deduped search terms. Falls back to a
 * stopword-keeping tokenization when the query is all stopwords (e.g.
 * "how to") so the call stays deterministic and non-empty.
 */
function queryTerms(query: string): string[] {
  let terms = tokenizeForSearch(query)
  if (terms.length === 0) terms = tokenizeForSearch(query, true)
  return [...new Set(terms)]
}

// Pull a query-centered excerpt: a window around the first matching token, so
// the snippet shows why the page matched instead of always the page head.
function buildExcerpt(plainText: string, terms: string[]): string {
  const WINDOW = 420
  if (!plainText) return ''
  const lower = plainText.toLowerCase()
  let hit = -1
  for (const t of terms) {
    const i = lower.indexOf(t)
    if (i >= 0 && (hit < 0 || i < hit)) hit = i
  }
  if (hit < 0) return plainText.slice(0, WINDOW)
  const start = Math.max(0, hit - 120)
  const end = Math.min(plainText.length, start + WINDOW)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < plainText.length ? '…' : ''
  return prefix + plainText.slice(start, end) + suffix
}

/**
 * Lightweight docs-index freshness metadata for /health and dero_docs_list,
 * so an operator can see at a glance whether the live server is serving a
 * current bundle. Reads the bundled index header only; returns nulls when
 * docs come from a filesystem override or the index is unreadable.
 */
export async function docsIndexMeta(): Promise<{
  docs_generated_at: string | null
  docs_page_count: number | null
}> {
  try {
    const source = await resolveDocsSource()
    if (source?.kind !== 'bundled') return { docs_generated_at: null, docs_page_count: null }
    const raw = await fs.readFile(source.indexPath, 'utf8')
    const parsed = JSON.parse(raw) as DocsIndexFile
    return {
      docs_generated_at: parsed.generated_at ?? null,
      docs_page_count: parsed.page_count ?? parsed.pages?.length ?? null,
    }
  } catch {
    return { docs_generated_at: null, docs_page_count: null }
  }
}

export async function listDeroDocs(product?: DeroDocProduct) {
  const { source, pages } = await loadPages()
  const filtered = product ? pages.filter((page) => page.product === product) : pages

  return {
    ...sourceMeta(source),
    total: filtered.length,
    products: DERO_DOC_PRODUCTS,
    pages: filtered.map((page) => ({
      product: page.product,
      slug: page.slug,
      title: page.title,
      canonical_url: page.canonicalUrl,
      last_updated: page.lastUpdated,
    })),
  }
}

/**
 * Build-or-return the BM25F model for the currently-cached page set. Keyed to
 * the page cache's load timestamp so it rebuilds exactly when the pages do
 * (same 15s TTL window). IDF needs the FULL corpus, so the model always spans
 * every page; product/section filtering happens at score time.
 */
function getSearchModel(pages: DeroDocsPage[]): SearchModel {
  const key = pageCache?.key ?? 'unkeyed'
  const loadedAt = pageCache?.loadedAt ?? 0
  if (searchModelCache && searchModelCache.key === key && searchModelCache.loadedAt === loadedAt) {
    return searchModelCache.model
  }
  const model = buildSearchModel(pages)
  searchModelCache = { key, loadedAt, model }
  return model
}

export async function searchDeroDocs(args: SearchArgs) {
  const query = args.query.trim()
  if (!query) throw new Error('DERO docs search requires a non-empty query')

  const { source, pages } = await loadPages()
  const model = getSearchModel(pages)
  const terms = queryTerms(query)

  const normalizedSection = args.section ? normalizeSlug(args.section).toLowerCase() : null

  const scored = model.pages
    .filter((pm) => {
      if (args.product && pm.page.product !== args.product) return false
      if (normalizedSection) {
        const slug = pm.page.slug.toLowerCase()
        if (slug !== normalizedSection && !slug.startsWith(`${normalizedSection}/`)) return false
      }
      return true
    })
    .map((pm) => ({ page: pm.page, score: scorePageModel(pm, terms, model) }))
    .filter((entry) => entry.score > 0)
    // Tie-break lexicographically on product/slug for deterministic, CI-stable
    // ordering when scores are equal.
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      const ak = `${a.page.product}/${a.page.slug}`
      const bk = `${b.page.product}/${b.page.slug}`
      return ak < bk ? -1 : ak > bk ? 1 : 0
    })

  const limit = Math.max(1, Math.min(args.limit ?? 8, 25))
  const results = scored.slice(0, limit).map(({ page, score }) => ({
    product: page.product,
    slug: page.slug,
    title: page.title,
    description: page.description,
    canonical_url: page.canonicalUrl,
    headings: page.headings.slice(0, 5),
    excerpt: buildExcerpt(page.plainText, terms),
    score: Math.round(score * 100) / 100,
  }))

  return {
    ...sourceMeta(source),
    query,
    total_matches: scored.length,
    returned: results.length,
    results,
  }
}

// Per-call content cap. Long pages (e.g. /captain at ~75k chars) need to be
// fetched in slices to stay LLM-context-friendly; callers paginate via offset
// using `content_truncated` + `next_offset` in the response.
const PAGE_CONTENT_CHUNK = 60000

export async function getDeroDocPage(params: {
  product?: DeroDocProduct
  slug: string
  offset?: number
}) {
  const slug = normalizeSlug(params.slug)
  if (!slug) throw new Error('DERO docs get page requires a non-empty slug')

  const { source, pages } = await loadPages()
  const target = pages.find((page) => {
    if (params.product && page.product !== params.product) return false
    return normalizeSlug(page.slug).toLowerCase() === slug.toLowerCase()
  })

  if (!target) {
    throw new Error(
      params.product
        ? `Doc page not found for product=${params.product} slug=${slug}`
        : `Doc page not found for slug=${slug}`,
    )
  }

  const total = target.plainText.length
  const offset = Math.max(0, Math.min(params.offset ?? 0, total))
  const end = Math.min(offset + PAGE_CONTENT_CHUNK, total)
  const truncated = end < total

  return {
    ...sourceMeta(source),
    product: target.product,
    slug: target.slug,
    title: target.title,
    description: target.description,
    canonical_url: target.canonicalUrl,
    last_updated: target.lastUpdated,
    headings: target.headings,
    content: target.plainText.slice(offset, end),
    content_offset: offset,
    content_length: total,
    content_truncated: truncated,
    next_offset: truncated ? end : null,
    source_path: target.sourcePath,
  }
}
