import { deroJsonRpc, jsonRpcEndpoint } from './rpc.js'

/**
 * Baked-in third-party public mainnet daemon. Last-resort fallback so the
 * server works with zero setup, but it is someone else's node — prefer a
 * local derod for privacy and trust.
 */
export const PUBLIC_DAEMON_BASE = 'http://82.65.143.182:10102'

/** A derod running locally on its default RPC bind — the preferred source. */
export const LOCAL_DAEMON_BASE = 'http://127.0.0.1:10102'

export type DaemonSource = 'env' | 'local' | 'public'

export type DaemonResolution = {
  base: string
  source: DaemonSource
}

function stripJsonRpc(url: string): string {
  return url.replace(/\/json_rpc\/?$/, '').replace(/\/+$/, '')
}

/**
 * Probe a base URL to confirm a real DERO daemon answers there. Calls
 * DERO.GetInfo rather than a bare TCP connect, so an unrelated service
 * squatting on the port is not mistaken for a daemon. A refused connection
 * on localhost rejects almost immediately, so this adds no meaningful
 * startup latency when no node is running.
 */
async function isDeroDaemon(base: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const info = await deroJsonRpc<{ height?: number; topoheight?: number }>(
      jsonRpcEndpoint(base),
      'DERO.GetInfo',
      undefined,
      { timeoutMs },
    )
    return (
      !!info &&
      typeof info === 'object' &&
      (typeof info.height === 'number' || typeof info.topoheight === 'number')
    )
  } catch {
    return false
  }
}

/**
 * Resolve which DERO daemon the server should talk to, local-first:
 *
 *   1. DERO_DAEMON_URL set  → honor it verbatim (hosted deploys, custom nodes).
 *   2. else local node up   → http://127.0.0.1:10102 (private, no third party).
 *   3. else                 → baked-in public fallback (works with zero setup).
 *
 * Resolved once at startup. stdio hosts spawn a fresh process per session, so
 * a node started later is picked up on the next launch; a long-running HTTP
 * server re-resolves on restart.
 */
export async function resolveDaemonBase(): Promise<DaemonResolution> {
  const fromEnv = process.env.DERO_DAEMON_URL?.trim()
  if (fromEnv) return { base: stripJsonRpc(fromEnv), source: 'env' }

  if (await isDeroDaemon(LOCAL_DAEMON_BASE)) {
    return { base: LOCAL_DAEMON_BASE, source: 'local' }
  }
  return { base: PUBLIC_DAEMON_BASE, source: 'public' }
}

/** One-line, human-readable description of a resolution for startup logs. */
export function describeDaemonResolution({ base, source }: DaemonResolution): string {
  switch (source) {
    case 'env':
      return `daemon: ${base} (from DERO_DAEMON_URL)`
    case 'local':
      return `daemon: ${base} (local node detected)`
    case 'public':
      return `daemon: ${base} (no local node found — public fallback; run your own derod for privacy)`
  }
}
