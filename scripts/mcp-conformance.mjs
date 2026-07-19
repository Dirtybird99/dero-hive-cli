import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const serverEntry = fileURLToPath(new URL('../resources/mcp/dero-mcp-server/dist/index.js', import.meta.url))
const conformanceEntry = fileURLToPath(new URL('../node_modules/@modelcontextprotocol/conformance/dist/index.js', import.meta.url))
const scenarios = ['server-initialize', 'ping', 'tools-list', 'resources-list', 'prompts-list']

const probe = createServer()
await new Promise((resolve, reject) => probe.once('error', reject).listen(0, '127.0.0.1', resolve))
const { port } = probe.address()
await new Promise((resolve) => probe.close(resolve))

const server = spawn(process.execPath, [serverEntry, '--http'], {
  cwd: root,
  env: {
    ...process.env,
    DERO_DAEMON_URL: 'http://127.0.0.1:1',
    DERO_MCP_HTTP_HOST: '127.0.0.1',
    DERO_MCP_HTTP_PORT: String(port),
  },
  stdio: ['ignore', 'ignore', 'inherit'],
})

try {
  const health = `http://127.0.0.1:${port}/health`
  for (let attempt = 0; ; attempt += 1) {
    try {
      if ((await fetch(health)).ok) break
    } catch {}
    if (attempt === 49) throw new Error('Timed out waiting for the bundled MCP server')
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  for (const scenario of scenarios) {
    const result = await new Promise((resolve, reject) => {
      let output = ''
      const child = spawn(process.execPath, [
        conformanceEntry,
        'server',
        '--url', `http://127.0.0.1:${port}/mcp`,
        '--spec-version', '2025-06-18',
        '--scenario', scenario,
      ], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
      for (const stream of [child.stdout, child.stderr]) {
        stream.on('data', (chunk) => {
          output += chunk
          process.stdout.write(chunk)
        })
      }
      child.once('error', reject)
      child.once('exit', (code, signal) => resolve({ code, signal, output }))
    })
    // ponytail: conformance 0.1.16 can trip a libuv shutdown assertion on
    // Windows after printing a successful result; remove when upstream fixes it.
    const summary = /^Passed:\s+(\d+)\/(\d+),\s+0 failed,\s+0 warnings\s*$/mu.exec(result.output)
    const successfulWindowsShutdownCrash = process.platform === 'win32'
      && result.code === 3221226505
      && Number(summary?.[1]) > 0
      && summary?.[1] === summary?.[2]
    if (result.code !== 0 && !successfulWindowsShutdownCrash) {
      throw new Error(`MCP conformance scenario ${scenario} failed (${result.signal || result.code})`)
    }
  }
} finally {
  server.kill()
}
