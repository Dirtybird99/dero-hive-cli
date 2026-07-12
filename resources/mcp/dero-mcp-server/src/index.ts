#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createDeroMcpServer } from './server.js'
import { startHttpServer } from './http-server.js'
import { resolveDaemonBase, describeDaemonResolution } from './daemon-base.js'

function isHttpMode(): boolean {
  if (process.argv.includes('--http')) return true
  const env = process.env.DERO_MCP_HTTP?.trim().toLowerCase()
  return env === '1' || env === 'true' || env === 'yes'
}

async function runStdio(): Promise<void> {
  const resolution = await resolveDaemonBase()
  const server = createDeroMcpServer(resolution.base)
  const transport = new StdioServerTransport()

  process.stderr.write(`[dero-mcp-server] stdio · ${describeDaemonResolution(resolution)}\n`)

  await server.connect(transport)
}

async function main(): Promise<void> {
  if (isHttpMode()) {
    await startHttpServer()
    return
  }
  await runStdio()
}

main().catch((err) => {
  process.stderr.write(`[dero-mcp-server] fatal: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
