/**
 * Lightweight, in-process TELA discovery — a tiny "Gnomon" that resolves a
 * dURL (e.g. "vault.tela") to its on-chain SCID(s), WITHOUT a separate Gnomon
 * indexer service, a bundled Go binary, or a multi-hundred-MB database.
 *
 * How it works (validated live against mainnet, 2026-06-12):
 *   1. The GnomonSC registry contract (a05395bb…) stores every known SCID with
 *      its install height — fetched in ONE DERO.GetSC call (~5s, 50k SCIDs).
 *   2. TELA is a recent platform: 100% of indexed TELA apps live in the newest
 *      ~1,500 SCIDs (measured: scanning ranks 1,500–5,000 found ZERO more).
 *      So we read only the newest N contracts (default 3,000 for headroom),
 *      classify each via the shared tela-parse, and keep the TELA-INDEX apps.
 *   3. The result is a small { dURL → apps } map, cached in-process with a TTL.
 *      A refresh only re-scans SCIDs newer than the last-seen height.
 *
 * Cold start: ~10s once (1,500–3,000 concurrent GetSC reads), then instant from
 * cache. Pure Node; reuses the existing rpc closure and tela-parse. No Go.
 *
 * Scope: TELA-INDEX discovery only (apps + their dURLs). It does NOT index
 * tokens/NFAs/arbitrary contracts — that is the full Gnomon's job and is not
 * what dURL→SCID resolution needs.
 */

import { classifyTela, parseTelaIndex } from './tela-parse.js'

// Mainnet GnomonSC registry — the on-chain contract that lists every SCID and
// its install height. (structures/globals.go MAINNET_GNOMON_SCID.)
export const GNOMON_REGISTRY_SCID =
  'a05395bb0cf77adc850928b0db00eb5ca7a9ccbafd9a38d021c8d299ad5ce1a4'

// How many newest SCIDs to scan for TELA apps. Measured live (2026-06-12): all
// 107 indexed TELA apps sat in the newest ~1,500 SCIDs; scanning ranks
// 1,500–5,000 found ZERO more. 2,000 gives comfortable headroom for growth at
// a ~14s cold start (vs ~22s at 3,000 for no extra apps). Override via
// DERO_GNOMON_SCAN_DEPTH; the incremental refresh keeps it current afterward.
const DEFAULT_SCAN_DEPTH = 2000
// Concurrent GetSC reads during a scan. 25 measured at ~150 reads/s, 0 errors
// against the public node — polite default. Override via DERO_GNOMON_CONCURRENCY.
const DEFAULT_CONCURRENCY = 25
// In-process cache TTL. Discovery is not real-time; 10 min keeps it fresh
// without rescanning on every call.
const CACHE_TTL_MS = 10 * 60 * 1000

export type DeroDaemonRpc = <T = unknown>(method: string, params?: unknown) => Promise<T>

export type TelaApp = {
  scid: string
  durl: string | null
  name: string | null
  height: number
  doc_count: number
}

export type DiscoveryIndex = {
  apps: TelaApp[]
  /** Lowercased, dero://-stripped dURL → apps (a dURL can map to several). */
  byDurl: Map<string, TelaApp[]>
  scanned: number
  registry_total: number
  newest_height: number
  built_at: number
}

type RegistryEntry = { scid: string; height: number }

let cache: DiscoveryIndex | null = null
let inflight: Promise<DiscoveryIndex> | null = null

function envInt(name: string, fallback: number): number {
  const v = process.env[name]
  const n = v ? Number(v) : NaN
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

/** Normalize a dURL for matching: lowercase, trim, strip a leading dero://. */
export function normalizeDurl(durl: string): string {
  return durl.toLowerCase().trim().replace(/^dero:\/\//, '')
}

/**
 * Parse the GnomonSC registry's stringkeys into {scid, height} entries.
 * Keys are "<scid>" (bare), "<scid>height", "<scid>owner"; we take height.
 * Pure + exported for offline testing.
 */
export function parseRegistry(stringkeys: Record<string, unknown> | undefined): RegistryEntry[] {
  const heights = new Map<string, number>()
  for (const [k, v] of Object.entries(stringkeys ?? {})) {
    const m = /^([0-9a-f]{64})(height|owner)?$/i.exec(k)
    if (!m) continue
    const scid = m[1].toLowerCase()
    if (m[2] === 'height') {
      const h = Number(v)
      if (Number.isFinite(h)) heights.set(scid, h)
    } else if (!heights.has(scid)) {
      heights.set(scid, 0)
    }
  }
  return [...heights.entries()]
    .map(([scid, height]) => ({ scid, height }))
    .sort((a, b) => b.height - a.height) // newest first
}

/** Run an async mapper over items with bounded concurrency. */
async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  async function worker() {
    while (true) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/**
 * Build the discovery index: fetch the registry, scan the newest SCIDs, keep
 * TELA-INDEX apps. `minHeight` (optional) limits the scan to SCIDs installed
 * above a height (used for incremental refresh).
 */
async function buildIndex(rpc: DeroDaemonRpc, minHeight = 0): Promise<DiscoveryIndex> {
  const depth = envInt('DERO_GNOMON_SCAN_DEPTH', DEFAULT_SCAN_DEPTH)
  const concurrency = envInt('DERO_GNOMON_CONCURRENCY', DEFAULT_CONCURRENCY)

  const reg = await rpc<{ stringkeys?: Record<string, unknown> }>('DERO.GetSC', {
    scid: GNOMON_REGISTRY_SCID,
    code: false,
    variables: true,
  })
  const entries = parseRegistry(reg?.stringkeys)
  if (entries.length === 0) {
    throw new Error('GNOMON_UNAVAILABLE: registry returned no SCIDs (is this mainnet?)')
  }

  const candidates = entries.filter((e) => e.height > minHeight).slice(0, depth)

  const results = await mapConcurrent(candidates, concurrency, async ({ scid, height }) => {
    try {
      const r = await rpc<{
        code?: string
        stringkeys?: Record<string, unknown>
        uint64keys?: Record<string, unknown>
      }>('DERO.GetSC', { scid, code: true, variables: true })
      const code = typeof r.code === 'string' ? r.code : ''
      if (classifyTela(r.stringkeys, code).kind !== 'tela_index') return null
      const idx = parseTelaIndex(r.stringkeys, r.uint64keys)
      return { scid, durl: idx.durl, name: idx.name, height, doc_count: idx.doc_count } as TelaApp
    } catch {
      return null // a single bad read never sinks the whole scan
    }
  })

  const apps = results.filter((a): a is TelaApp => a !== null).sort((a, b) => b.height - a.height)
  const byDurl = new Map<string, TelaApp[]>()
  for (const app of apps) {
    if (!app.durl) continue
    const key = normalizeDurl(app.durl)
    const list = byDurl.get(key) ?? []
    list.push(app)
    byDurl.set(key, list)
  }

  return {
    apps,
    byDurl,
    scanned: candidates.length,
    registry_total: entries.length,
    newest_height: entries[0]?.height ?? 0,
    built_at: Date.now(),
  }
}

/**
 * Get the discovery index, using the in-process cache when fresh. Concurrent
 * callers during a cold start share one in-flight build (no thundering herd).
 * `forceRefresh` rebuilds; otherwise a stale cache triggers an incremental
 * rescan of only newer SCIDs merged into the prior result.
 */
export async function getDiscoveryIndex(
  rpc: DeroDaemonRpc,
  opts: { forceRefresh?: boolean } = {},
): Promise<DiscoveryIndex> {
  const now = Date.now()
  if (!opts.forceRefresh && cache && now - cache.built_at < CACHE_TTL_MS) {
    return cache
  }
  if (inflight) return inflight

  inflight = (async () => {
    try {
      // Incremental: if we have a prior index and aren't forcing, only scan
      // SCIDs newer than what we last saw, then merge.
      if (cache && !opts.forceRefresh) {
        const delta = await buildIndex(rpc, cache.newest_height)
        const merged = mergeIndices(cache, delta)
        cache = merged
        return merged
      }
      cache = await buildIndex(rpc, 0)
      return cache
    } finally {
      inflight = null
    }
  })()
  return inflight
}

/** Merge a fresh delta scan into a prior index (delta apps take precedence). */
function mergeIndices(prev: DiscoveryIndex, delta: DiscoveryIndex): DiscoveryIndex {
  const seen = new Set(delta.apps.map((a) => a.scid))
  const apps = [...delta.apps, ...prev.apps.filter((a) => !seen.has(a.scid))].sort(
    (a, b) => b.height - a.height,
  )
  const byDurl = new Map<string, TelaApp[]>()
  for (const app of apps) {
    if (!app.durl) continue
    const key = normalizeDurl(app.durl)
    const list = byDurl.get(key) ?? []
    list.push(app)
    byDurl.set(key, list)
  }
  return {
    apps,
    byDurl,
    scanned: prev.scanned + delta.scanned,
    registry_total: delta.registry_total,
    newest_height: Math.max(prev.newest_height, delta.newest_height),
    built_at: Date.now(),
  }
}

/**
 * Resolve a dURL to its TELA app(s). dURLs are NOT unique (re-deploys, forks,
 * squatters), so we return ALL matches sorted newest-first; the caller marks
 * the newest as the canonical primary and discloses the collision.
 */
export async function resolveDurl(rpc: DeroDaemonRpc, durl: string): Promise<TelaApp[]> {
  const index = await getDiscoveryIndex(rpc)
  return (index.byDurl.get(normalizeDurl(durl)) ?? []).slice().sort((a, b) => b.height - a.height)
}

/** Reset the in-process cache (test helper). */
export function _resetGnomonCache(): void {
  cache = null
  inflight = null
}
