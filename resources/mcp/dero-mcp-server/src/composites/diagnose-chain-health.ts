/**
 * `diagnose_chain_health` — Phase C composite #1.
 *
 * Decorator-style composite that replaces four agent round-trips
 * (`DERO.Ping` + `DERO.GetInfo` + `DERO.GetHeight` + `DERO.GetTxPool`) and
 * the "what does this field mean?" docs lookup with a single narrative
 * response carrying chain metadata, mempool snapshot, narrative summary,
 * and curated docs citations.
 *
 * Design contract § 1 (lowest-risk composite, ships
 * first to prove the composite plumbing — shared utils + flow test pattern
 * + smoke assertions — end-to-end).
 *
 * Failure model:
 *   - `DERO.Ping` is the only required step. Its failure halts the chain
 *     and the handler throws so `withStructuredErrors` surfaces a
 *     structured `RPC_UNREACHABLE` error.
 *   - `DERO.GetInfo`, `DERO.GetHeight`, and `DERO.GetTxPool` are
 *     non-required. Their failures degrade `status` to `partial` and
 *     leave the corresponding response field null, but the composite
 *     still returns a useful payload.
 */

import { z } from 'zod'
import {
  attachCitations,
  runChain,
  stepLatencies,
  stepValue,
  type ChainStep,
  type DeroDaemonRpc,
} from './_shared.js'

export const diagnoseChainHealthInputSchema = {
  include_tx_pool: z
    .boolean()
    .optional()
    .describe('Include mempool snapshot in narrative and response. Default true.'),
} as const

type DiagnoseInput = { include_tx_pool?: boolean }

type DaemonInfo = {
  topoheight?: number
  stableheight?: number
  height?: number
  network?: string
  testnet?: boolean
  version?: string
  difficulty?: number | string
  total_supply?: number | string
  tx_pool_size?: number
}

/**
 * Mainnet derod returns `network: ""` and signals the chain via the
 * `testnet` boolean instead. Resolve a human-readable network label from
 * whichever field is populated — never fabricate "mainnet" from a blank
 * string alone, or a testnet node with an empty `network` would be
 * mislabeled. Returns null only when neither field tells us anything.
 */
function resolveNetwork(info: DaemonInfo): string | null {
  if (info.network && info.network.trim()) return info.network
  if (typeof info.testnet === 'boolean') return info.testnet ? 'testnet' : 'mainnet'
  return null
}

type DaemonHeight = {
  height?: number
  stableheight?: number
  topoheight?: number
}

type DaemonTxPool = {
  tx_hashes?: string[] | null
}

const LAG_DEPTH_LAGGING_THRESHOLD = 50

type DiagnoseStatus = 'healthy' | 'lagging' | 'partial' | 'unreachable'

type DiagnoseSignal = { key: string; value: string | number; note?: string }

/**
 * Pure function: turn the three RPC payloads (any of which may be null
 * if the corresponding step failed) into a status, narrative, and
 * machine-readable signals block. Kept inside this file because it is
 * tightly coupled to the response shape and is not reused elsewhere.
 */
function summarizeChainHealth(
  info: DaemonInfo | null,
  height: DaemonHeight | null,
  txPool: DaemonTxPool | null,
  txPoolRequested: boolean,
): { status: DiagnoseStatus; narrative: string; signals: DiagnoseSignal[] } {
  const signals: DiagnoseSignal[] = []

  if (!info || typeof info.topoheight !== 'number' || typeof info.stableheight !== 'number') {
    return {
      status: 'partial',
      narrative:
        'Daemon ping succeeded but chain info was unavailable; only liveness can be confirmed. Inspect daemon logs and retry.',
      signals,
    }
  }

  const lagDepth = info.topoheight - info.stableheight
  const network = resolveNetwork(info)
  signals.push({ key: 'topoheight', value: info.topoheight })
  signals.push({ key: 'stableheight', value: info.stableheight })
  signals.push({
    key: 'lag_depth',
    value: lagDepth,
    note: 'topoheight minus stableheight; values above 50 suggest the node is catching up',
  })
  if (network) signals.push({ key: 'network', value: network })
  if (info.version) signals.push({ key: 'version', value: info.version })

  if (height && typeof height.topoheight === 'number' && height.topoheight !== info.topoheight) {
    signals.push({
      key: 'topoheight_drift',
      value: height.topoheight - info.topoheight,
      note: 'GetHeight reported a different topoheight than GetInfo; values within +/-1 are normal between RPC calls',
    })
  }

  let status: DiagnoseStatus = 'healthy'
  const narrativeParts: string[] = []

  if (lagDepth > LAG_DEPTH_LAGGING_THRESHOLD) {
    status = 'lagging'
    narrativeParts.push(
      `Chain shows a lag depth of ${lagDepth} blocks between topoheight (${info.topoheight}) and stableheight (${info.stableheight}); typical depth is under ${LAG_DEPTH_LAGGING_THRESHOLD}, so the node may be catching up.`,
    )
  } else {
    narrativeParts.push(
      `Chain appears healthy on ${network ?? 'unknown network'} (version ${info.version ?? 'unknown'}): topoheight ${info.topoheight}, stableheight ${info.stableheight}, lag depth ${lagDepth}.`,
    )
  }

  if (!txPoolRequested) {
    narrativeParts.push('Mempool snapshot was skipped by request (include_tx_pool=false).')
  } else if (!txPool) {
    if (status === 'healthy') status = 'partial'
    narrativeParts.push('Mempool snapshot failed; mempool state is unknown for this report.')
  } else {
    const pending = Array.isArray(txPool.tx_hashes) ? txPool.tx_hashes.length : 0
    signals.push({ key: 'mempool_pending', value: pending })
    narrativeParts.push(
      pending === 0
        ? 'Mempool is empty.'
        : `Mempool has ${pending} pending transaction${pending === 1 ? '' : 's'}.`,
    )
  }

  return { status, narrative: narrativeParts.join(' '), signals }
}

export async function diagnoseChainHealth(rpc: DeroDaemonRpc, args: DiagnoseInput) {
  const includeTxPool = args.include_tx_pool !== false

  const steps: ChainStep[] = [
    { name: 'ping', required: true, fn: () => rpc<string>('DERO.Ping') },
    { name: 'info', required: false, fn: () => rpc<DaemonInfo>('DERO.GetInfo') },
    { name: 'height', required: false, fn: () => rpc<DaemonHeight>('DERO.GetHeight') },
    ...(includeTxPool
      ? [{ name: 'tx_pool', required: false, fn: () => rpc<DaemonTxPool>('DERO.GetTxPool') }]
      : []),
  ]

  const chain = await runChain(steps)

  if (chain.haltedAt === 'ping') {
    const pingResult = chain.results.find((r) => r.name === 'ping')
    const detail = pingResult?.error?.message ?? 'unknown error'
    // `withStructuredErrors` classifies this message into RPC_UNREACHABLE.
    throw new Error(`fetch failed: ${detail}`)
  }

  const info = stepValue<DaemonInfo>(chain, 'info')
  const height = stepValue<DaemonHeight>(chain, 'height')
  const txPool = includeTxPool ? stepValue<DaemonTxPool>(chain, 'tx_pool') : null

  const { status, narrative, signals } = summarizeChainHealth(info, height, txPool, includeTxPool)

  const chainData =
    info && typeof info.topoheight === 'number'
      ? {
          topoheight: info.topoheight,
          stableheight: info.stableheight ?? null,
          height: info.height ?? null,
          network: resolveNetwork(info),
          version: info.version ?? null,
          difficulty: info.difficulty ?? null,
          total_supply: info.total_supply ?? null,
        }
      : null

  const mempool = txPool
    ? {
        pending: Array.isArray(txPool.tx_hashes) ? txPool.tx_hashes.length : 0,
        sample: (txPool.tx_hashes ?? []).slice(0, 5),
      }
    : null

  return attachCitations(
    {
      status,
      narrative,
      signals,
      chain: chainData,
      mempool,
      _diagnostics: {
        step_latency_ms: stepLatencies(chain),
        total_ms: chain.totalMs,
        halted_at: chain.haltedAt,
        include_tx_pool: includeTxPool,
      },
    },
    'diagnose_chain_health',
  )
}
