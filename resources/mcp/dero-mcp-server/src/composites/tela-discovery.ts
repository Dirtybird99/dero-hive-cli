/**
 * TELA discovery tools — turn a dURL or a browse request into on-chain SCIDs,
 * powered by the lightweight in-process indexer in src/gnomon.ts.
 *
 * - dero_durl_to_scid: "what's the SCID for vault.tela" → SCID(s) + metadata.
 * - dero_tela_list_apps: "what TELA apps exist" → the discovered catalog.
 *
 * Read-only. The first call triggers a ~10s cold-start scan of the newest
 * chain SCIDs (cached ~10 min after). For a registered DERO NAME like
 * "quickbrownfox" (no dot, not a dURL), use dero_name_to_address instead.
 */

import { z } from 'zod'
import { attachCitations, type DeroDaemonRpc } from './_shared.js'
import { getDiscoveryIndex, resolveDurl, normalizeDurl, type TelaApp } from '../gnomon.js'

export const deroDurlToScidInputSchema = {
  durl: z
    .string()
    .min(1)
    .describe('A TELA dURL to resolve, e.g. "vault.tela" or "dero://feed.tela". NOT a registered DERO name (use dero_name_to_address for names like "quickbrownfox").'),
} as const

type DurlToScidInput = { durl: string }

function appView(a: TelaApp) {
  return { scid: a.scid, durl: a.durl, name: a.name, install_height: a.height, doc_count: a.doc_count }
}

export async function deroDurlToScid(rpc: DeroDaemonRpc, args: DurlToScidInput) {
  const query = args.durl.trim()
  const matches = await resolveDurl(rpc, query)

  if (matches.length === 0) {
    // Honest miss: distinguish "looks like a name, not a dURL" from "not found".
    const looksLikeName = !query.includes('.') && !query.includes('/')
    const hint = looksLikeName
      ? `"${query}" looks like a registered DERO name, not a TELA dURL. Use dero_name_to_address to resolve a name to an address.`
      : `No indexed TELA app advertises the dURL "${query}". It may not exist, or the discovery scan may not reach it (TELA apps in the newest chain SCIDs are indexed; very old or just-deployed apps can be missed). Try dero_tela_list_apps to browse what is indexed.`
    return attachCitations(
      {
        query,
        normalized: normalizeDurl(query),
        found: false,
        match_count: 0,
        hint,
      },
      'dero_durl_to_scid',
    )
  }

  // dURLs are non-unique. Newest = canonical primary; disclose the rest.
  const [primary, ...others] = matches
  return attachCitations(
    {
      query,
      normalized: normalizeDurl(query),
      found: true,
      match_count: matches.length,
      scid: primary.scid,
      primary: appView(primary),
      // Only present when more than one contract claims this dURL.
      collision: others.length > 0,
      other_candidates: others.map(appView),
      narrative:
        matches.length === 1
          ? `dURL "${query}" resolves to SCID ${primary.scid} ("${primary.name ?? 'unnamed'}"). Inspect it with tela_inspect.`
          : `dURL "${query}" is claimed by ${matches.length} contracts (dURLs are NOT unique). Returning the newest (install height ${primary.height}, SCID ${primary.scid}) as primary; ${others.length} other candidate(s) are listed under other_candidates. Verify which you intend before trusting it.`,
    },
    'dero_durl_to_scid',
  )
}

export const deroTelaListAppsInputSchema = {
  query: z
    .string()
    .optional()
    .describe('Optional case-insensitive filter matched against dURL and name (e.g. "chess", "vault").'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe('Max apps to return (default 50, max 200).'),
} as const

type TelaListInput = { query?: string; limit?: number }

export async function deroTelaListApps(rpc: DeroDaemonRpc, args: TelaListInput) {
  const index = await getDiscoveryIndex(rpc)
  const limit = Math.max(1, Math.min(args.limit ?? 50, 200))
  const q = args.query?.toLowerCase().trim()

  let apps = index.apps
  if (q) {
    apps = apps.filter(
      (a) =>
        (a.durl ?? '').toLowerCase().includes(q) || (a.name ?? '').toLowerCase().includes(q),
    )
  }
  const total = apps.length
  const shown = apps.slice(0, limit)

  return attachCitations(
    {
      query: args.query ?? null,
      total_matched: total,
      returned: shown.length,
      truncated: total > shown.length,
      apps: shown.map(appView),
      index_meta: {
        apps_indexed: index.apps.length,
        scanned_scids: index.scanned,
        registry_total: index.registry_total,
        newest_height: index.newest_height,
      },
      narrative: q
        ? `${total} indexed TELA app(s) match "${args.query}"${total > shown.length ? ` (showing ${shown.length})` : ''}. Resolve a dURL with dero_durl_to_scid or inspect a SCID with tela_inspect.`
        : `${index.apps.length} TELA app(s) indexed from the newest ${index.scanned} of ${index.registry_total} on-chain contracts${total > shown.length ? ` (showing ${shown.length})` : ''}. Use the query filter to narrow, dero_durl_to_scid to resolve a dURL, or tela_inspect to inspect a SCID.`,
    },
    'dero_tela_list_apps',
  )
}
