import { promises as fs } from 'node:fs'
import path from 'node:path'

export const DERO_DOC_PRODUCTS = ['derod', 'tela', 'hologram', 'deropay'] as const
export type DeroDocProduct = (typeof DERO_DOC_PRODUCTS)[number]

export const DOC_SITE_DIRS: Record<DeroDocProduct, string> = {
  derod: 'derod-main',
  tela: 'tela-main',
  hologram: 'hologram-main',
  deropay: 'deropay-main',
}

export const DOC_BASE_URLS: Record<DeroDocProduct, string> = {
  derod: 'https://derod.org',
  tela: 'https://tela.derod.org',
  hologram: 'https://hologram.derod.org',
  deropay: 'https://pay.derod.org',
}

export type DeroDocsPage = {
  product: DeroDocProduct
  slug: string
  title: string
  description: string | null
  canonicalUrl: string
  sourcePath: string
  headings: string[]
  plainText: string
  lastUpdated: string | null
}

export type DocsIndexFile = {
  version: 1
  generated_at: string
  page_count: number
  pages: DeroDocsPage[]
}

// ---------------- Search tokenization ----------------
//
// One shared tokenizer for both indexing and queries so the two stay
// symmetric — a page and a query that mention the same concept must produce
// the same tokens. Used by the BM25F scorer in docs.ts. The tokenizer is the
// structural fix for the old substring scorer's failures: word-boundary
// matching (so `i` no longer matches inside "private", `vs` no longer matches
// "Claims vs. Evidence"), standard-name handling (so `TELA-INDEX-1` is a real
// searchable token), and a curated stoplist.

/**
 * Curated stoplist: closed-class English plus a few low-signal connectors.
 * Deliberately short. `vs` is LOAD-BEARING — it was literal-matching
 * comparison-titled pages ("Claims vs. Evidence") and ranking them top for
 * "dero vs monero". Do NOT add concept words like `new`/`start`/`about`:
 * the recommend_docs_path beginner-intent nudge depends on them surviving.
 * Any edit here must re-run `npm run check:docs-ranking`.
 */
export const DOCS_STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'and', 'the', 'or', 'but', 'if', 'then', 'else', 'of', 'to', 'in',
  'on', 'at', 'by', 'for', 'with', 'as', 'is', 'are', 'was', 'were', 'be',
  'been', 'being', 'it', 'its', 'this', 'that', 'these', 'those', 'i', 'me',
  'my', 'we', 'our', 'you', 'your', 'he', 'she', 'they', 'them', 'their',
  'do', 'does', 'did', 'done', 'have', 'has', 'had', 'can', 'could', 'should',
  'would', 'will', 'shall', 'may', 'might', 'must', 'how', 'what', 'when',
  'where', 'who', 'why', 'which', 'much', 'many', 'some', 'any', 'anyone',
  'see', 'get', 'got', 'so', 'than', 'too', 'very', 'just', 'into', 'from',
  'vs', 'versus', 'about',
])

/**
 * Standard-name shape: contains a digit (tela-index-1) or is a multi-part
 * hyphenated identifier (dvm-basic, account-based). For these we emit the
 * joined token AND the split parts so both "TELA-INDEX-1" and "tela index"
 * find the spec page.
 */
function isStandardName(chunk: string): boolean {
  return /\d/.test(chunk) || /^[a-z]+(?:-[a-z0-9]+)+$/.test(chunk)
}

/**
 * Tokenize text for search. Lowercase, word-boundary match keeping interior
 * hyphens, expand standard-names to joined + parts, drop length-1 noise
 * (except pure digits), and remove stopwords. Pure and deterministic.
 *
 * `keepStopwords` is used only by the query-path empty-fallback so a
 * pure-stopword query ("how to") still yields a non-empty, deterministic set.
 */
export function tokenizeForSearch(text: string, keepStopwords = false): string[] {
  const out: string[] = []
  const matches = (text || '').toLowerCase().match(/[a-z0-9][a-z0-9-]*/g) ?? []
  for (const rawChunk of matches) {
    const chunk = rawChunk.replace(/^-+|-+$/g, '')
    if (!chunk) continue
    const parts: string[] = []
    if (chunk.includes('-')) {
      if (isStandardName(chunk)) parts.push(chunk)
      for (const p of chunk.split('-')) if (p) parts.push(p)
    } else {
      parts.push(chunk)
    }
    for (const tok of parts) {
      // Drop length-1 noise (the `i`/`in`-substring problem) but keep digits.
      if (tok.length < 2 && !/^\d$/.test(tok)) continue
      if (!keepStopwords && DOCS_STOPWORDS.has(tok)) continue
      out.push(tok)
    }
  }
  return out
}

export function normalizeSlug(input: string): string {
  return input.trim().replace(/^\/+/, '').replace(/\/+$/, '')
}

function safeTitleFromSlug(slug: string): string {
  if (!slug) return 'Home'
  return slug
    .split('/')
    .at(-1)!
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath)
    return true
  } catch {
    return false
  }
}

export function parseFrontmatter(raw: string): Record<string, string> {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?/)
  if (!match) return {}

  const frontmatter: Record<string, string> = {}
  for (const line of match[1].split('\n')) {
    const keyValue = line.match(/^([A-Za-z0-9_]+):\s*(.+)$/)
    if (!keyValue) continue
    frontmatter[keyValue[1]] = keyValue[2].trim().replace(/^['"]|['"]$/g, '')
  }
  return frontmatter
}

export function stripFrontmatter(raw: string): string {
  return raw.replace(/^---\n[\s\S]*?\n---\n?/, '')
}

export function extractHeadings(markdown: string): string[] {
  const headings: string[] = []
  const headingRegex = /^#{1,3}\s+(.+)$/gm
  let match: RegExpExecArray | null = null
  while ((match = headingRegex.exec(markdown)) !== null) {
    headings.push(match[1].trim())
  }
  return headings
}

/**
 * Decode the HTML entities that survive MDX → plaintext: &amp;, &lt;, &gt;,
 * &quot;, &apos;, &#39;, and numeric entities. Without this, Captain quotes
 * containing `&amp;` (MDX-escaped `&`) reach MCP consumers as literal "&amp;".
 */
function decodeHtmlEntities(input: string): string {
  // Guard codepoints: String.fromCodePoint throws RangeError on values past
  // U+10FFFF, which would abort the whole doc index on one malformed entity.
  // Out-of-range entities pass through as their literal source text.
  const fromCp = (cp: number, raw: string) =>
    cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : raw
  return input
    .replace(/&#(\d+);/g, (m, code) => fromCp(Number(code), m))
    .replace(/&#x([0-9a-fA-F]+);/g, (m, hex) => fromCp(parseInt(hex, 16), m))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/**
 * Pull an attribute value out of a JSX opening-tag string. Handles
 * double-quoted and single-quoted forms; returns `undefined` if not present.
 */
function readJsxAttr(openTag: string, name: string): string | undefined {
  const match = openTag.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"|${name}\\s*=\\s*'([^']*)'`))
  return match?.[1] ?? match?.[2]
}

/**
 * Transform <CaptainNote> and <Quote> blocks into markdown blockquotes that
 * preserve attribution. Without this, the body text reaches MCP consumers
 * unattributed — "— Captain", date, channel, and source link are all rendered
 * by the React component and never appear in the MDX source.
 *
 * Output shape: `> {body}\n>\n> — {author}, {date}, {channel} ({source})`.
 * Runs before generic JSX stripping so the body survives.
 */
function shimAttributedQuotes(input: string): string {
  const pattern = /<(CaptainNote|Quote)\b([\s\S]*?)>([\s\S]*?)<\/\1>/g
  return input.replace(pattern, (_match, _tag, attrs, body) => {
    const author = readJsxAttr(attrs, 'author') ?? 'Captain'
    const date = readJsxAttr(attrs, 'date') ?? ''
    const channel = readJsxAttr(attrs, 'channel') ?? ''
    const source = readJsxAttr(attrs, 'source') ?? ''
    const codeRef = readJsxAttr(attrs, 'codeRef') ?? ''
    const bodyText = body.trim()
    const attribution = [`— ${author}`, date, channel].filter(Boolean).join(', ')
    const head = source ? `${attribution} (${source})` : attribution
    const tail = codeRef ? `${head}; verified · Release 142: ${codeRef}` : head
    return `\n\n> ${bodyText}\n>\n> ${tail}\n\n`
  })
}

export function mdxToPlainText(raw: string): string {
  return decodeHtmlEntities(
    shimAttributedQuotes(raw)
      // Keep fenced-code CONTENTS (curl/RPC/install examples are the most
      // valuable thing an agent can cite); drop only the ``` fence and the
      // optional language tag. Deleting the whole block silently stripped
      // every code example from every page.
      .replace(/```[\w-]*\n?([\s\S]*?)```/g, ' $1 ')
      .replace(/^import\s+.*$/gm, ' ')
      .replace(/<[^>]+>/gs, ' ')
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/`([^`]+)`/g, '$1'),
  )
    .replace(/\s+/g, ' ')
    .trim()
}

async function walkMdxFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await walkMdxFiles(fullPath)))
      continue
    }
    if (entry.isFile() && entry.name.endsWith('.mdx')) {
      files.push(fullPath)
    }
  }

  return files
}

function buildCanonicalUrl(product: DeroDocProduct, slug: string): string {
  if (!slug) return `${DOC_BASE_URLS[product]}/`
  // .md mirror suffix points agents at the LLM-canonical Markdown surface.
  // All four ecosystem sites (derod, tela, hologram, deropay) ship the App
  // Router .md mirror route as of 0.2.4.
  return `${DOC_BASE_URLS[product]}/${slug}.md`
}

/**
 * Normalize a frontmatter-supplied canonical URL so it carries the same
 * `.md` suffix as builder-generated URLs. Without this, any MDX page that
 * declared its own `canonicalUrl` in frontmatter would bypass the suffix
 * and point agents at the HTML version.
 */
function applyMdSuffix(_product: DeroDocProduct, url: string): string {
  // Don't double-suffix; preserve query/anchor if present.
  const [base, rest = ''] = url.split(/(?=[?#])/)
  if (/\.md$/.test(base) || /\.[a-z0-9]{2,5}$/i.test(base)) return url
  return `${base}.md${rest}`
}

export async function indexDocsFromRoot(root: string): Promise<DeroDocsPage[]> {
  const pages: DeroDocsPage[] = []

  for (const product of DERO_DOC_PRODUCTS) {
    const siteDir = DOC_SITE_DIRS[product]
    const pagesDir = path.join(root, siteDir, 'pages')
    if (!(await pathExists(pagesDir))) continue

    const files = await walkMdxFiles(pagesDir)
    for (const filePath of files) {
      const raw = await fs.readFile(filePath, 'utf8')
      const frontmatter = parseFrontmatter(raw)
      const content = stripFrontmatter(raw)
      const rel = path.relative(pagesDir, filePath).replace(/\\/g, '/')
      const slug = normalizeSlug(rel.replace(/\.mdx$/, '').replace(/\/index$/, '').replace(/^index$/, ''))
      const headings = extractHeadings(content)

      pages.push({
        product,
        slug,
        title: frontmatter.title || safeTitleFromSlug(slug),
        description: frontmatter.description || null,
        canonicalUrl: applyMdSuffix(product, frontmatter.canonicalUrl || buildCanonicalUrl(product, slug)),
        sourcePath: path.relative(root, filePath).replace(/\\/g, '/'),
        headings,
        plainText: mdxToPlainText(content),
        lastUpdated: frontmatter.lastUpdated || frontmatter.date || null,
      })
    }
  }

  pages.sort((a, b) => {
    if (a.product !== b.product) return a.product.localeCompare(b.product)
    return a.slug.localeCompare(b.slug)
  })

  return pages
}

export async function resolveDeroDocsRoot(customRoot?: string): Promise<string | null> {
  const explicit = customRoot ?? process.env.DERO_DOCS_ROOT
  if (explicit) {
    const derodPages = path.join(explicit, DOC_SITE_DIRS.derod, 'pages')
    return (await pathExists(derodPages)) ? explicit : null
  }

  const autoCandidates = [
    path.resolve(process.cwd(), '../dero-docs'),
    path.resolve(process.cwd(), '../../dero-docs'),
  ]

  for (const candidate of autoCandidates) {
    const derodPages = path.join(candidate, DOC_SITE_DIRS.derod, 'pages')
    if (await pathExists(derodPages)) return candidate
  }

  return null
}
