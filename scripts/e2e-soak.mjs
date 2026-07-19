#!/usr/bin/env node
/* global Buffer, URL, clearInterval, clearTimeout, console, process, setInterval, setTimeout */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  appendFileSync,
  createReadStream,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { cpus, freemem, loadavg, platform, release, tmpdir, totalmem } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';

const MODEL_ID = 'fixture-model';
const PROVIDER_ID = 'soak-local';
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 30_000;
const MAX_CLI_TREE_SAMPLE_GAP_MS = 3_000;
const TERMINAL_TOOL_MARKER = 'terminal-tool-safe-marker';
const TERMINAL_PROVIDER_MARKER = 'terminal-provider-safe-marker';
const TERMINAL_ATTACK = '\u001b]0;soak-title-hijack\u0007\u001b]52;c;c29hay1jbGlwYm9hcmQ=\u0007\u001b[2J\u001b[H\u0007';

function usage() {
  return `Usage: node scripts/e2e-soak.mjs --artifact <dero-hive-cli.tgz> [options]

Options:
  --mode <calibration|soak>  Run the same state machine at calibration or soak cadence
  --duration <2m|10h>       Wall-clock run duration (default: 2m calibration, 10h soak)
  --cadence <duration>       Minimum interval between cycle starts (default: 10s/1m)
  --seed <value>             Deterministic fixture seed (default: 20260719)
  --evidence <directory>     Evidence output directory
  --help                     Show this help`;
}

function parseDuration(value, option) {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/u.exec(value || '');
  if (!match) throw new Error(`${option} must be a positive duration such as 2m or 10h.`);
  const factors = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };
  const millis = Number(match[1]) * factors[match[2]];
  if (!Number.isFinite(millis) || millis <= 0) throw new Error(`${option} must be greater than zero.`);
  return Math.round(millis);
}

function parseArgs(argv) {
  const values = new Map();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const [name, inline] = arg.split('=', 2);
    const value = inline ?? argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
    if (values.has(name)) throw new Error(`${name} was supplied more than once.`);
    values.set(name, value);
  }
  const known = new Set(['--artifact', '--mode', '--duration', '--cadence', '--seed', '--evidence']);
  for (const name of values.keys()) if (!known.has(name)) throw new Error(`Unknown option: ${name}`);
  const artifactValue = values.get('--artifact');
  if (!artifactValue) throw new Error('--artifact is required.');
  const mode = values.get('--mode') || 'calibration';
  if (!['calibration', 'soak'].includes(mode)) throw new Error('--mode must be calibration or soak.');
  const durationText = values.get('--duration') || (mode === 'soak' ? '10h' : '2m');
  const cadenceText = values.get('--cadence') || (mode === 'soak' ? '1m' : '10s');
  const artifact = resolve(artifactValue);
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const evidence = resolve(values.get('--evidence') || join(process.cwd(), 'evidence', `e2e-${mode}-${stamp}`));
  return {
    help: false,
    artifact,
    mode,
    durationText,
    durationMs: parseDuration(durationText, '--duration'),
    cadenceText,
    cadenceMs: parseDuration(cadenceText, '--cadence'),
    seed: values.get('--seed') || '20260719',
    evidence
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function seedNumber(value) {
  const digest = createHash('sha256').update(value).digest();
  return digest.readUInt32LE(0);
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let n = state;
    n = Math.imul(n ^ (n >>> 15), n | 1);
    n ^= n + Math.imul(n ^ (n >>> 7), n | 61);
    return ((n ^ (n >>> 14)) >>> 0) / 4_294_967_296;
  };
}

async function sha256(path) {
  const hash = createHash('sha256');
  await new Promise((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolvePromise);
  });
  return hash.digest('hex');
}

function canonicalJson(value) {
  const sort = (item) => {
    if (Array.isArray(item)) return item.map(sort);
    if (!item || typeof item !== 'object') return item;
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, sort(item[key])]));
  };
  return JSON.stringify(sort(value));
}

function scrubEnvironment(source) {
  const env = {};
  let stripped = 0;
  const strippedDeroVariables = [];
  for (const [key, value] of Object.entries(source)) {
    if (/^HIVE_PROVIDER_/iu.test(key) || /^DERO_/iu.test(key) || /^(HIVE_SEARCH_API_KEY|HIVE_SIMULATOR_RPC_URL|OPENAI_API_KEY|ANTHROPIC_API_KEY)$/iu.test(key)) {
      stripped++;
      if (/^DERO_/iu.test(key)) strippedDeroVariables.push(key);
      continue;
    }
    if (value !== undefined) env[key] = value;
  }
  delete env.HIVE_DEBUG;
  return { env, stripped, strippedDeroVariables };
}

function workspaceSnapshot(root) {
  const hash = createHash('sha256');
  let entries = 0;
  const visit = (path, relativePath) => {
    const stats = statSync(path);
    if (stats.isDirectory()) {
      hash.update(`d\0${relativePath}\0`);
      for (const entry of readdirSync(path, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
        if (!entry.isSymbolicLink()) visit(join(path, entry.name), `${relativePath}/${entry.name}`);
      }
      return;
    }
    if (!stats.isFile()) return;
    entries++;
    hash.update(`f\0${relativePath}\0${stats.size}\0`);
    hash.update(readFileSync(path));
  };
  visit(root, '.');
  return { sha256: hash.digest('hex'), entries };
}

function samePath(left, right) {
  const normalize = (value) => process.platform === 'win32' ? resolve(value).toLocaleLowerCase() : resolve(value);
  return normalize(left) === normalize(right);
}

function lastJsonObject(stdout) {
  const lines = stdout.trim().split(/\r?\n/u).reverse();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try { return JSON.parse(trimmed); } catch { /* try an earlier line */ }
  }
  throw new Error(`CLI emitted no JSON object. Output tail: ${stdout.slice(-500)}`);
}

function textContent(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((part) => typeof part?.text === 'string' ? part.text : '').join('');
}

async function readRequestJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 2 * 1024 * 1024) throw new Error('fixture request exceeded 2 MB');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function writeSse(response, pieces) {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'close'
  });
  for (const piece of pieces) response.write(`data: ${JSON.stringify(piece)}\n\n`);
  response.end('data: [DONE]\n\n');
}

function contentChunk(content, usage = false) {
  return usage
    ? { id: 'fixture', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } }
    : { id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }] };
}

function toolChunk(id, name, args) {
  return {
    id: 'fixture',
    object: 'chat.completion.chunk',
    choices: [{
      index: 0,
      delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
      finish_reason: 'tool_calls'
    }]
  };
}

function createFixtureServers({ canary, height }) {
  const stats = {
    modelRequests: 0,
    modelAuthFailures: 0,
    modelFailures: 0,
    modelCancellations: 0,
    modelCancellationAborts: 0,
    deroRequests: 0,
    deroRouteFailures: 0,
    deroMethods: {},
    toolCallsIssued: 0
  };
  const sockets = new Set();

  const modelServer = createServer(async (request, response) => {
    try {
      if (request.headers.authorization !== `Bearer ${canary}`) {
        stats.modelAuthFailures++;
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'fixture auth rejected' } }));
        return;
      }
      if (request.method === 'GET' && request.url === '/v1/models') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: MODEL_ID, object: 'model', owned_by: 'fixture' }] }));
        return;
      }
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
        response.writeHead(404).end();
        return;
      }

      stats.modelRequests++;
      const body = await readRequestJson(request);
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const systemText = messages.filter((message) => message.role === 'system').map((message) => textContent(message.content)).join('\n');
      if (systemText.includes('Create a concise title')) {
        writeSse(response, [contentChunk('Fixture Session'), contentChunk('', true)]);
        return;
      }

      let lastUserIndex = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === 'user') { lastUserIndex = i; break; }
      }
      const prompt = lastUserIndex >= 0 ? textContent(messages[lastUserIndex].content) : '';
      const sincePrompt = lastUserIndex >= 0 ? messages.slice(lastUserIndex + 1) : [];
      const marker = /marker=([^\s]+)/u.exec(prompt)?.[1] || 'missing';

      if (prompt.startsWith('SOAK_FAILURE')) {
        stats.modelFailures++;
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: `fixture failure ${canary}` } }));
        return;
      }
      if (prompt.startsWith('SOAK_CANCEL')) {
        stats.modelCancellations++;
        let completed = false;
        const timer = setTimeout(() => {
          if (response.destroyed) return;
          completed = true;
          writeSse(response, [contentChunk(`cancel-too-late:${marker}`), contentChunk('', true)]);
        }, 10_000);
        timer.unref?.();
        response.on('close', () => {
          clearTimeout(timer);
          if (!completed) stats.modelCancellationAborts++;
        });
        return;
      }
      if (prompt.startsWith('SOAK_TOOL')) {
        const toolResults = sincePrompt.filter((message) => message.role === 'tool');
        if (toolResults.length === 0) {
          stats.toolCallsIssued++;
          writeSse(response, [toolChunk(`read-${stats.toolCallsIssued}`, 'read_file', { path: 'fixture.txt' })]);
          return;
        }
        if (toolResults.length === 1) {
          stats.toolCallsIssued++;
          writeSse(response, [toolChunk(`dero-${stats.toolCallsIssued}`, 'get_simulator_chain_info', {})]);
          return;
        }
        writeSse(response, [contentChunk(`tool-sequence-ok:${marker}:height=${height}`), contentChunk('', true)]);
        return;
      }
      if (prompt.startsWith('SOAK_TERMINAL')) {
        const toolResults = sincePrompt.filter((message) => message.role === 'tool');
        if (toolResults.length === 0) {
          stats.toolCallsIssued++;
          writeSse(response, [toolChunk(`terminal-${stats.toolCallsIssued}`, 'read_file', { path: 'terminal-fixture.txt' })]);
          return;
        }
        writeSse(response, [contentChunk(`${TERMINAL_PROVIDER_MARKER}:${marker}:${TERMINAL_ATTACK}`), contentChunk('', true)]);
        return;
      }
      if (prompt.startsWith('SOAK_RESUME')) {
        const token = /token=([^\s]+)/u.exec(prompt)?.[1] || 'missing';
        const prior = messages.slice(0, Math.max(0, lastUserIndex)).map((message) => textContent(message.content)).join('\n');
        const persisted = prior.includes(`SOAK_PERSIST`) && prior.includes(token);
        writeSse(response, [contentChunk(`${persisted ? 'resume-ok' : 'resume-missing'}:${token}`), contentChunk('', true)]);
        return;
      }
      if (prompt.startsWith('SOAK_PERSIST')) {
        const token = /token=([^\s]+)/u.exec(prompt)?.[1] || 'missing';
        writeSse(response, [contentChunk(`persisted:${token}`), contentChunk('', true)]);
        return;
      }
      writeSse(response, [contentChunk(`simple-ok:${marker}`), contentChunk('', true)]);
    } catch (error) {
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
      if (!response.destroyed) response.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }));
    }
  });

  const deroServer = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || request.url !== '/json_rpc') {
        stats.deroRouteFailures++;
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'fixture accepts only POST /json_rpc' }));
        return;
      }
      const body = await readRequestJson(request);
      const method = typeof body.method === 'string' ? body.method : 'unknown';
      stats.deroRequests++;
      stats.deroMethods[method] = (stats.deroMethods[method] || 0) + 1;
      const result = method === 'DERO.GetInfo'
        ? { height, topoheight: height, stableheight: height - 2, difficulty: 424_242, network: 'simulator', tx_pool_size: 0, status: 'OK', version: 'soak-fixture' }
        : method === 'DERO.Ping'
          ? { status: 'PONG' }
          : method === 'DERO.GetHeight'
            ? { height }
            : null;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(result === null
        ? { jsonrpc: '2.0', id: body.id ?? null, error: { code: -32601, message: 'fixture method not found' } }
        : { jsonrpc: '2.0', id: body.id ?? null, result }));
    } catch (error) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });

  for (const server of [modelServer, deroServer]) {
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
  }

  async function listen(server, port) {
    await new Promise((resolvePromise, reject) => {
      const onError = (error) => { server.off('listening', onListening); reject(error); };
      const onListening = () => { server.off('error', onError); resolvePromise(); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    });
  }

  return {
    stats,
    async start() {
      await listen(modelServer, 0);
      try {
        await listen(deroServer, 0);
      } catch (error) {
        await new Promise((done) => modelServer.close(done));
        throw new Error(`Cannot bind the isolated DERO fixture to a dynamic loopback port: ${error instanceof Error ? error.message : error}`, { cause: error });
      }
      const modelAddress = modelServer.address();
      const deroAddress = deroServer.address();
      assert(modelAddress && typeof modelAddress === 'object', 'OpenAI fixture did not expose a TCP address.');
      assert(deroAddress && typeof deroAddress === 'object', 'DERO fixture did not expose a TCP address.');
      const deroBaseUrl = `http://127.0.0.1:${deroAddress.port}`;
      return {
        modelBaseUrl: `http://127.0.0.1:${modelAddress.port}/v1`,
        deroBaseUrl,
        deroRpcUrl: `${deroBaseUrl}/json_rpc`
      };
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await Promise.all([modelServer, deroServer].map((server) => new Promise((done) => {
        if (!server.listening) { done(); return; }
        server.close(() => done());
      })));
    }
  };
}

function findNpmCli() {
  const candidates = [
    process.env.npm_execpath,
    process.env.APPDATA ? join(process.env.APPDATA, 'npm', 'node_modules', 'npm', 'bin', 'npm-cli.js') : undefined,
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  ].filter(Boolean);
  for (const pathDir of (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean)) {
    candidates.push(join(pathDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    candidates.push(join(dirname(pathDir), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  }
  const found = [...new Set(candidates)].filter((candidate) => existsSync(candidate));
  return found.find((candidate) => {
    try {
      const pkg = JSON.parse(readFileSync(resolve(dirname(candidate), '..', 'package.json'), 'utf8'));
      return Number.parseInt(pkg.version, 10) === 12;
    } catch { return false; }
  }) || found[0];
}

function sourceIdentity() {
  const cwd = resolve(import.meta.dirname, '..');
  const env = { ...process.env };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[name];
  const run = (args) => spawnSync('git', args, { cwd, env, encoding: 'utf8', windowsHide: true });
  const rootResult = run(['rev-parse', '--show-toplevel']);
  const commitResult = run(['rev-parse', 'HEAD']);
  const statusResult = run(['status', '--porcelain=v1', '--untracked-files=all']);
  const commit = commitResult.status === 0 ? commitResult.stdout.trim() : '';
  const errors = [rootResult, commitResult, statusResult]
    .filter((result) => result.error || result.status !== 0)
    .map((result) => result.error?.message || result.stderr.trim() || `git exited ${result.status}`);
  return {
    repository: 'https://github.com/Dirtybird99/dero-hive-cli',
    commit,
    rootMatchesHarness: rootResult.status === 0 && samePath(rootResult.stdout.trim(), cwd),
    workingTreeClean: statusResult.status === 0 && statusResult.stdout.trim() === '',
    error: errors.join('; ') || null
  };
}

function appendLimited(chunks, chunk, state) {
  if (state.bytes >= MAX_OUTPUT_BYTES) { state.truncated = true; return; }
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const remaining = MAX_OUTPUT_BYTES - state.bytes;
  chunks.push(buffer.subarray(0, remaining));
  state.bytes += Math.min(buffer.length, remaining);
  if (buffer.length > remaining) state.truncated = true;
}

function posixProcessGroupAlive(pid) {
  if (process.platform === 'win32' || !pid) return false;
  try { process.kill(-pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

async function waitForPosixProcessGroupExit(pid, timeoutMs = 500) {
  const deadline = performance.now() + timeoutMs;
  while (posixProcessGroupAlive(pid) && performance.now() < deadline) {
    await new Promise((done) => setTimeout(done, 25));
  }
  return !posixProcessGroupAlive(pid);
}

async function windowsTaskkill(pid) {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const executable = join(systemRoot, 'System32', 'taskkill.exe');
  return new Promise((resolvePromise, reject) => {
    let spawnError;
    let timedOut = false;
    const killer = spawn(executable, ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try { killer.kill('SIGKILL'); } catch { /* close/reap below still owns settlement */ }
    }, 15_000);
    killer.once('error', (error) => { spawnError = error; });
    killer.once('close', (code) => {
      clearTimeout(timer);
      if (spawnError) reject(spawnError);
      else if (timedOut) reject(new Error(`taskkill timed out for PID ${pid}.`));
      else resolvePromise(code);
    });
  });
}

async function terminateProcessTree(child, force = false) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    const code = await windowsTaskkill(child.pid);
    if (code !== 0 && child.exitCode === null && child.signalCode === null) throw new Error(`taskkill exited ${code} for PID ${child.pid}.`);
    return;
  }
  try {
    process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

async function runProcess(context, label, file, args, options = {}) {
  const startedAt = new Date().toISOString();
  const startedMono = performance.now();
  let timedOut = false;
  let spawnedPid = null;
  let driverError = '';
  let treeTerminationError = '';
  let active = true;
  const stdoutChunks = [];
  const stderrChunks = [];
  const stdoutState = { bytes: 0, truncated: false };
  const stderrState = { bytes: 0, truncated: false };
  context.activeChildren++;

  const result = await new Promise((resolvePromise) => {
    let settled = false;
    let spawnError;
    let hardTimer;
    let terminationStarted = false;
    let terminationPromise = Promise.resolve();
    const child = spawn(file, args, {
      cwd: options.cwd || context.runtimeRoot,
      env: options.env || context.childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32'
    });
    spawnedPid = child.pid || null;
    const controller = {
      child,
      label,
      terminate() {
        if (terminationStarted) return terminationPromise;
        terminationStarted = true;
        terminationPromise = terminateProcessTree(child, false).catch((error) => {
          treeTerminationError = error instanceof Error ? error.message : String(error);
          try { child.kill('SIGKILL'); } catch { /* root-only fallback; evidence fails below */ }
        });
        hardTimer = setTimeout(() => {
          terminationPromise = terminationPromise.then(() => terminateProcessTree(child, true)).catch((error) => {
            treeTerminationError ||= error instanceof Error ? error.message : String(error);
            try { child.kill('SIGKILL'); } catch { /* root-only fallback; evidence fails below */ }
          });
        }, 2_000);
        return terminationPromise;
      }
    };
    if (child.pid) context.activeProcessControllers.set(child.pid, controller);
    context.currentChild = child;
    options.onSpawn?.(child, controller);
    child.stdout.on('data', (chunk) => {
      appendLimited(stdoutChunks, chunk, stdoutState);
      options.onStdout?.(chunk);
    });
    child.stderr.on('data', (chunk) => {
      appendLimited(stderrChunks, chunk, stderrState);
      options.onStderr?.(chunk);
    });

    const finish = (exitCode, signal, error) => {
      if (settled) return;
      settled = true;
      active = false;
      clearTimeout(timer);
      clearTimeout(hardTimer);
      if (child.pid) context.activeProcessControllers.delete(child.pid);
      if (context.currentChild === child) context.currentChild = null;
      resolvePromise({
        closeObserved: true,
        exitCode,
        signal,
        error: error ? (error instanceof Error ? error.message : String(error)) : '',
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        stdoutTruncated: stdoutState.truncated,
        stderrTruncated: stderrState.truncated
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      void controller.terminate();
    }, options.timeoutMs || PROBE_TIMEOUT_MS);

    child.once('error', (error) => { spawnError = error; });
    child.once('close', (code, signal) => {
      active = false;
      clearTimeout(hardTimer);
      void (async () => {
        await terminationPromise;
        if (!(await waitForPosixProcessGroupExit(child.pid))) {
          treeTerminationError ||= `PID ${child.pid} left a live process-group member after root close.`;
          await terminateProcessTree(child, true).catch((error) => {
            treeTerminationError += ` Cleanup failed: ${error instanceof Error ? error.message : error}`;
          });
        }
        finish(code, signal, spawnError);
      })();
    });
    if (options.drive) {
      Promise.resolve(options.drive(child)).catch((error) => {
        driverError = error instanceof Error ? error.message : String(error);
        if (active) void controller.terminate();
      });
    } else {
      child.stdin.end();
    }
  });

  context.activeChildren--;
  if (treeTerminationError) context.processTreeErrors.push({ label, error: treeTerminationError });
  const durationMs = Math.round(performance.now() - startedMono);
  const safe = (value) => context.redact(value);
  const record = {
    timestamp: startedAt,
    label,
    pid: spawnedPid,
    command: file,
    args: options.displayArgs || args,
    cwd: options.cwd || context.runtimeRoot,
    durationMs,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut,
    closeObserved: result.closeObserved,
    treeTerminationError: safe(treeTerminationError) || undefined,
    driverError: safe(driverError) || undefined,
    error: safe(result.error) || undefined,
    stdoutBytes: Buffer.byteLength(result.stdout),
    stderrBytes: Buffer.byteLength(result.stderr),
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    stdoutSha256: createHash('sha256').update(result.stdout).digest('hex'),
    stderrSha256: createHash('sha256').update(result.stderr).digest('hex'),
    stdoutTail: safe(result.stdout.slice(-2_000)),
    stderrTail: safe(result.stderr.slice(-2_000))
  };
  appendFileSync(context.commandsPath, `${JSON.stringify(record)}\n`, 'utf8');
  context.commandCount++;
  return { ...result, durationMs, timedOut, driverError, treeTerminationError };
}

function selectProcessTree(rows, rootPid) {
  const ids = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (ids.has(row.ppid) && !ids.has(row.pid)) {
        ids.add(row.pid);
        changed = true;
      }
    }
  }
  return rows.filter((row) => ids.has(row.pid));
}

function recordCliTreeError(context, message) {
  if (!context.cliTree.errors.includes(message)) context.cliTree.errors.push(message);
}

function acceptCliTreeRows(context, rows, capturedAt = Date.now()) {
  const numberOrNull = (value) => value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
  const normalized = rows.map((row) => ({
    pid: Number(row.pid),
    ppid: Number(row.ppid),
    rssBytes: Number(row.rssBytes) || 0,
    handles: numberOrNull(row.handles),
    fds: numberOrNull(row.fds),
    startToken: row.startToken === null || row.startToken === undefined ? null : String(row.startToken)
  })).filter((row) => Number.isInteger(row.pid) && row.pid > 0);
  for (const row of normalized) {
    context.cliTree.observed.set(`${row.pid}:${row.startToken ?? '?'}`, row);
    if (!context.cliTree.firstIdentityByPid.has(row.pid)) context.cliTree.firstIdentityByPid.set(row.pid, row.startToken);
  }
  const sum = (key) => {
    const values = normalized.map((row) => row[key]).filter((value) => Number.isFinite(value));
    return values.length ? values.reduce((total, value) => total + value, 0) : null;
  };
  const sample = {
    capturedAt,
    processCount: normalized.length,
    descendantCount: Math.max(0, normalized.length - (normalized.some((row) => row.pid === context.cliTree.rootPid) ? 1 : 0)),
    rssBytes: sum('rssBytes') || 0,
    handles: sum('handles'),
    fds: sum('fds')
  };
  if (context.cliTree.lastCapturedAt) context.cliTree.maxSampleGapMs = Math.max(context.cliTree.maxSampleGapMs, capturedAt - context.cliTree.lastCapturedAt);
  context.cliTree.lastCapturedAt = capturedAt;
  context.cliTree.latest = sample;
  context.cliTree.latestRows = normalized;
  if (normalized.length) context.cliTree.samples.push(sample);
}

function linuxProcessRows(rootPid) {
  const rows = [];
  for (const entry of readdirSync('/proc', { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
    const pid = Number(entry.name);
    try {
      const status = readFileSync(`/proc/${pid}/status`, 'utf8');
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const closeParen = stat.lastIndexOf(')');
      const fields = stat.slice(closeParen + 2).trim().split(/\s+/u);
      const ppid = Number(/^PPid:\s+(\d+)/mu.exec(status)?.[1] || fields[1]);
      const rssKb = Number(/^VmRSS:\s+(\d+)\s+kB/mu.exec(status)?.[1] || 0);
      let fds = null;
      try { fds = readdirSync(`/proc/${pid}/fd`).length; } catch { /* permission or exit race */ }
      rows.push({ pid, ppid, rssBytes: rssKb * 1024, handles: null, fds, startToken: fields[19] || null });
    } catch { /* process exited during the snapshot */ }
  }
  return selectProcessTree(rows, rootPid);
}

async function psProcessRows(rootPid) {
  const output = await new Promise((resolvePromise, reject) => {
    const chunks = [];
    let spawnError;
    let timedOut = false;
    const child = spawn('ps', ['-axo', 'pid=,ppid=,rss='], { stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch { /* close below settles */ } }, 5_000);
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.once('error', (error) => { spawnError = error; });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (spawnError) reject(spawnError);
      else if (timedOut) reject(new Error('ps process snapshot timed out.'));
      else if (code !== 0) reject(new Error(`ps exited ${code}.`));
      else resolvePromise(Buffer.concat(chunks).toString('utf8'));
    });
  });
  const rows = output.trim().split(/\r?\n/u).map((line) => {
    const [pid, ppid, rssKb] = line.trim().split(/\s+/u).map(Number);
    return { pid, ppid, rssBytes: rssKb * 1024, handles: null, fds: null, startToken: null };
  });
  return selectProcessTree(rows, rootPid);
}

function windowsSamplerScript(rootPid) {
  return `$ErrorActionPreference='Stop';Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class HiveProcessSnapshot {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct Entry { public uint size, usage, pid; public UIntPtr heap; public uint module, threads, ppid; public int priority; public uint flags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string exe; }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool Process32FirstW(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool Process32NextW(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static Dictionary<uint,uint> Parents() { var result=new Dictionary<uint,uint>(); var snapshot=CreateToolhelp32Snapshot(2,0); if(snapshot==new IntPtr(-1)) return result; try { var entry=new Entry(); entry.size=(uint)Marshal.SizeOf(typeof(Entry)); if(Process32FirstW(snapshot,ref entry)) do { result[entry.pid]=entry.ppid; } while(Process32NextW(snapshot,ref entry)); } finally { CloseHandle(snapshot); } return result; }
}
'@;$root=[uint32]${rootPid};$known=@{};while($true){$started=[Environment]::TickCount64;try{$parents=[HiveProcessSnapshot]::Parents();$ids=[Collections.Generic.HashSet[uint32]]::new();[void]$ids.Add($root);do{$changed=$false;foreach($pair in $parents.GetEnumerator()){if($ids.Contains([uint32]$pair.Value)-and $ids.Add([uint32]$pair.Key)){$changed=$true}}}while($changed);$tree=@();foreach($pidValue in $ids){try{$p=Get-Process -Id $pidValue -ErrorAction Stop;$token=$p.StartTime.ToFileTimeUtc().ToString();if(-not $known.ContainsKey([uint32]$pidValue)){$known[[uint32]$pidValue]=$token};if($known[[uint32]$pidValue]-eq $token){$tree+=[pscustomobject]@{pid=[uint32]$pidValue;ppid=if($parents.ContainsKey([uint32]$pidValue)){[uint32]$parents[[uint32]$pidValue]}else{0};rssBytes=[int64]$p.WorkingSet64;handles=[int]$p.HandleCount;fds=$null;startToken=$token}}}catch{}};foreach($pair in @($known.GetEnumerator())){$pidValue=[uint32]$pair.Key;if($ids.Contains($pidValue)){continue};try{$p=Get-Process -Id $pidValue -ErrorAction Stop;$token=$p.StartTime.ToFileTimeUtc().ToString();if($pair.Value-eq $token){$tree+=[pscustomobject]@{pid=$pidValue;ppid=if($parents.ContainsKey($pidValue)){[uint32]$parents[$pidValue]}else{0};rssBytes=[int64]$p.WorkingSet64;handles=[int]$p.HandleCount;fds=$null;startToken=$token}}}catch{}};[Console]::Out.WriteLine((ConvertTo-Json -Compress -InputObject @($tree)));[Console]::Out.Flush()}catch{[Console]::Out.WriteLine('{"error":"Toolhelp process snapshot failed"}')};$remaining=1000-([Environment]::TickCount64-$started);if($remaining-gt 0){[Threading.Thread]::Sleep([int]$remaining)}}`;
}

async function startCliTreeSampler(context, rootPid) {
  context.cliTree.rootPid = rootPid;
  if (process.platform === 'win32') {
    context.cliTree.method = 'windows-toolhelp-1s';
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    const bundled = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const executable = existsSync(bundled) ? bundled : 'powershell.exe';
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', windowsSamplerScript(rootPid)], {
      env: context.baseEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    context.cliTree.sampler = child;
    let lineBuffer = '';
    child.stdout.on('data', (chunk) => {
      lineBuffer += chunk.toString('utf8');
      const lines = lineBuffer.split(/\r?\n/u);
      lineBuffer = lines.pop() || '';
      for (const line of lines.filter(Boolean)) {
        try {
          const parsed = JSON.parse(line);
          if (parsed?.error) recordCliTreeError(context, parsed.error);
          else acceptCliTreeRows(context, Array.isArray(parsed) ? parsed : [parsed]);
        } catch { recordCliTreeError(context, 'Windows sampler emitted invalid JSON.'); }
      }
    });
    child.stderr.on('data', (chunk) => { context.cliTree.samplerStderr = `${context.cliTree.samplerStderr}${chunk}`.slice(-2_000); });
    context.cliTree.samplerClosed = new Promise((resolvePromise) => {
      child.once('error', (error) => recordCliTreeError(context, `Windows sampler failed: ${error instanceof Error ? error.message : error}`));
      child.once('close', (code) => {
        if (!context.cliTree.stopping && code !== 0) recordCliTreeError(context, `Windows sampler exited ${code}.`);
        resolvePromise();
      });
    });
    await waitFor(() => context.cliTree.latest?.processCount > 0 || context.cliTree.errors.length > 0, 10_000, 'the first Windows CLI-tree sample');
  } else {
    context.cliTree.method = existsSync('/proc/self/status') ? 'linux-procfs-1s' : 'posix-ps-1s';
    await sampleCliTreeNow(context);
  }
  assert(context.cliTree.latest?.processCount > 0, `CLI process-tree sampler produced no root sample: ${context.cliTree.errors.join('; ')}`);
}

async function sampleCliTreeNow(context) {
  if (!context.cliTree.rootPid) return;
  try {
    if (process.platform === 'win32') return;
    const rows = existsSync('/proc/self/status')
      ? linuxProcessRows(context.cliTree.rootPid)
      : await psProcessRows(context.cliTree.rootPid);
    acceptCliTreeRows(context, rows);
  } catch (error) {
    recordCliTreeError(context, `CLI tree sample failed: ${error instanceof Error ? error.message : error}`);
  }
}

function linuxIdentityAlive(row) {
  try {
    const stat = readFileSync(`/proc/${row.pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u);
    return row.startToken === null || fields[19] === row.startToken;
  } catch { return false; }
}

async function verifyCliTreeExit(context) {
  if (!context.cliTree.rootPid) return;
  if (process.platform === 'win32') {
    await waitFor(() => context.cliTree.latestRows.length === 0, 4_000, 'the persistent CLI tree to disappear').catch(() => {});
  } else {
    await sampleCliTreeNow(context);
  }
  const leftovers = process.platform === 'win32'
    ? context.cliTree.latestRows.filter((row) => context.cliTree.firstIdentityByPid.get(row.pid) === row.startToken)
    : [...context.cliTree.observed.values()].filter((row) => existsSync('/proc/self/status') ? linuxIdentityAlive(row) : (() => {
        try { process.kill(row.pid, 0); return true; } catch { return false; }
      })());
  if (posixProcessGroupAlive(context.cliTree.rootPid) && !leftovers.some((row) => row.pid === context.cliTree.rootPid)) {
    leftovers.push({ pid: `process-group-${context.cliTree.rootPid}`, ppid: null, startToken: null });
  }
  context.cliTree.leftovers = leftovers.map((row) => ({ pid: row.pid, ppid: row.ppid, startToken: row.startToken }));
  if (leftovers.length) {
    if (process.platform === 'win32') {
      for (const row of leftovers) await windowsTaskkill(row.pid).catch(() => {});
    } else {
      await terminateProcessTree({ pid: context.cliTree.rootPid }, true).catch(() => {});
    }
  }
}

async function stopCliTreeSampler(context) {
  const sampler = context.cliTree.sampler;
  if (!sampler) return;
  context.cliTree.stopping = true;
  if (sampler.exitCode === null && sampler.signalCode === null) await windowsTaskkill(sampler.pid).catch((error) => recordCliTreeError(context, `Sampler cleanup failed: ${error instanceof Error ? error.message : error}`));
  await context.cliTree.samplerClosed;
}

function event(context, type, details = {}, level = 'info') {
  const record = {
    timestamp: new Date().toISOString(),
    elapsedMs: context.soakStartedMono ? Math.round(performance.now() - context.soakStartedMono) : 0,
    type,
    level,
    ...details
  };
  appendFileSync(context.eventsPath, `${context.redact(JSON.stringify(record))}\n`, 'utf8');
  const suffix = details.probe ? ` ${details.probe}` : details.cycle ? ` cycle=${details.cycle}` : '';
  console.log(`[${record.timestamp}] ${type}${suffix}`);
}

function fileSize(path) {
  try { return statSync(path).size; } catch { return 0; }
}

function activeRuntimeCount(name) {
  const getter = process[name];
  if (typeof getter !== 'function') return null;
  try { return getter.call(process).length; } catch { return null; }
}

async function sampleMetrics(context) {
  await sampleCliTreeNow(context);
  const memory = process.memoryUsage();
  const elapsed = context.soakStartedMono ? Math.round(performance.now() - context.soakStartedMono) : 0;
  const cliTree = context.cliTree.latest || {
    capturedAt: 0, processCount: 0, descendantCount: 0, rssBytes: 0, handles: null, fds: null
  };
  const sample = {
    dbBytes: fileSize(join(context.dataDir, 'hive.db')),
    walBytes: fileSize(join(context.dataDir, 'hive.db-wal')),
    activeHandles: activeRuntimeCount('_getActiveHandles'),
    activeRequests: activeRuntimeCount('_getActiveRequests'),
    openFds: existsSync('/proc/self/fd') ? readdirSync('/proc/self/fd').length : null,
    activeChildren: context.activeChildren,
    cliTreeProcesses: cliTree.processCount,
    cliTreeDescendants: cliTree.descendantCount,
    cliTreeRssBytes: cliTree.rssBytes,
    cliTreeHandles: cliTree.handles,
    cliTreeFds: cliTree.fds,
    cliTreeSampleAgeMs: cliTree.capturedAt ? Math.max(0, Date.now() - cliTree.capturedAt) : null
  };
  context.metricSamples.push(sample);
  const line = [
    new Date().toISOString(), elapsed, context.cycle, memory.rss, memory.heapUsed,
    loadavg()[0].toFixed(3), freemem(), totalmem(), context.probePasses,
    context.probeFailures, context.fixtures?.stats.modelRequests || 0,
    context.fixtures?.stats.deroRequests || 0, sample.dbBytes, sample.walBytes,
    sample.activeHandles ?? '', sample.activeRequests ?? '', sample.openFds ?? '', sample.activeChildren,
    context.cliTree.rootPid || '', sample.cliTreeProcesses, sample.cliTreeDescendants,
    sample.cliTreeRssBytes, sample.cliTreeHandles ?? '', sample.cliTreeFds ?? '', sample.cliTreeSampleAgeMs ?? ''
  ].join(',');
  appendFileSync(context.metricsPath, `${line}\n`, 'utf8');
}

function queueMetrics(context) {
  const next = context.metricsPromise.catch(() => {}).then(() => sampleMetrics(context));
  context.metricsPromise = next;
  return next;
}

function metricTrend(samples, key) {
  const values = samples.map((sample) => sample[key]).filter((value) => Number.isFinite(value));
  if (values.length === 0) return {
    samples: 0, first: null, last: null, min: null, max: null, delta: null,
    firstWindowMedian: null, lastWindowMedian: null, medianDelta: null,
    slopePerSample: null, monotonicGrowth: false, sustainedGrowth: false
  };
  const median = (items) => {
    const sorted = [...items].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };
  const windowSize = Math.max(1, Math.floor(values.length / 4));
  const firstWindowMedian = median(values.slice(0, windowSize));
  const lastWindowMedian = median(values.slice(-windowSize));
  const meanX = (values.length - 1) / 2;
  const meanY = values.reduce((total, value) => total + value, 0) / values.length;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < values.length; index++) {
    numerator += (index - meanX) * (values[index] - meanY);
    denominator += (index - meanX) ** 2;
  }
  const slopePerSample = denominator ? numerator / denominator : 0;
  return {
    samples: values.length,
    first: values[0],
    last: values.at(-1),
    min: Math.min(...values),
    max: Math.max(...values),
    delta: values.at(-1) - values[0],
    firstWindowMedian,
    lastWindowMedian,
    medianDelta: lastWindowMedian - firstWindowMedian,
    slopePerSample,
    monotonicGrowth: values.length >= 3 && values.at(-1) > values[0] && values.every((value, index) => index === 0 || value >= values[index - 1]),
    sustainedGrowth: values.length >= 10 && lastWindowMedian > firstWindowMedian && slopePerSample > 0
  };
}

function trendExceeds(trend, threshold) {
  return (trend.monotonicGrowth && trend.delta > threshold) || (trend.sustainedGrowth && trend.medianDelta > threshold);
}

function resourceEvidence(context) {
  const stable = context.metricSamples.filter((sample) => sample.activeChildren <= 1);
  const trends = Object.fromEntries(['dbBytes', 'walBytes', 'activeHandles', 'activeRequests', 'openFds', 'activeChildren']
    .map((key) => [key, metricTrend(key === 'activeChildren' ? context.metricSamples : stable, key)]));
  const treeTrends = Object.fromEntries(['processCount', 'descendantCount', 'rssBytes', 'handles', 'fds']
    .map((key) => [key, metricTrend(context.cliTree.samples, key)]));
  const maxSampleAgeMs = Math.max(0, ...context.metricSamples
    .map((sample) => sample.cliTreeSampleAgeMs)
    .filter((value) => Number.isFinite(value)));
  const leakFlags = [];
  if (trendExceeds(trends.activeHandles, 2)) leakFlags.push('active handles showed sustained upward growth');
  if (trendExceeds(trends.activeRequests, 1)) leakFlags.push('active requests showed sustained upward growth');
  if (trendExceeds(trends.openFds, 2)) leakFlags.push('open file descriptors showed sustained upward growth');
  if ((trends.activeChildren.last || 0) !== 0) leakFlags.push('child process remained active at completion');
  if (trendExceeds(treeTrends.processCount, 0.5)) leakFlags.push('installed CLI process count showed sustained upward growth');
  if (trendExceeds(treeTrends.handles, 8)) leakFlags.push('installed CLI handles showed sustained upward growth');
  if (trendExceeds(treeTrends.fds, 8)) leakFlags.push('installed CLI file descriptors showed sustained upward growth');
  if (treeTrends.rssBytes.samples >= 30 && trendExceeds(treeTrends.rssBytes, 128 * 1024 * 1024)) leakFlags.push('installed CLI tree RSS showed sustained growth above 128 MiB');
  if (context.cliTree.leftovers.length) leakFlags.push('installed CLI left descendant processes after exit');
  if (context.cliTree.errors.length) leakFlags.push('installed CLI process-tree sampling was incomplete');
  if (context.cliTree.maxSampleGapMs > MAX_CLI_TREE_SAMPLE_GAP_MS) leakFlags.push('installed CLI process-tree sampling exceeded the 3s maximum gap');
  if (maxSampleAgeMs > MAX_CLI_TREE_SAMPLE_GAP_MS) leakFlags.push('installed CLI process-tree sampler stopped producing fresh samples');
  if (context.processTreeErrors.length) leakFlags.push('a subprocess left a live tree member or could not be tree-terminated');
  if (!context.cliTree.samples.length) leakFlags.push('installed CLI process tree was never sampled');
  return {
    samples: context.metricSamples.length,
    trends,
    cliTree: {
      method: context.cliTree.method,
      rootPid: context.cliTree.rootPid,
      samples: context.cliTree.samples.length,
      observedIdentities: context.cliTree.observed.size,
      observed: [...context.cliTree.observed.values()].map((row) => ({ pid: row.pid, ppid: row.ppid, startToken: row.startToken })),
      maxSampleGapMs: context.cliTree.maxSampleGapMs,
      maxSampleAgeMs,
      trends: treeTrends,
      leftovers: context.cliTree.leftovers,
      errors: context.cliTree.errors,
      limitations: context.cliTree.limitations
    },
    subprocessTreeErrors: context.processTreeErrors,
    leakFlags
  };
}

async function waitFor(predicate, timeoutMs, description) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function sleep(context, millis) {
  if (millis <= 0 || context.abortRequested) return;
  await new Promise((done) => {
    const timer = setTimeout(done, millis);
    context.abortWait = () => { clearTimeout(timer); done(); };
  });
  context.abortWait = null;
}

function installedPackageRoot(prefix) {
  const candidates = process.platform === 'win32'
    ? [join(prefix, 'node_modules', 'dero-hive-cli')]
    : [join(prefix, 'lib', 'node_modules', 'dero-hive-cli'), join(prefix, 'node_modules', 'dero-hive-cli')];
  return candidates.find((candidate) => existsSync(join(candidate, 'package.json')));
}

async function scanForCanary(roots, canary) {
  const needle = Buffer.from(canary);
  const hits = [];
  const visit = async (path) => {
    let stats;
    try { stats = statSync(path); } catch { return; }
    if (stats.isDirectory()) {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        if (!entry.isSymbolicLink()) await visit(join(path, entry.name));
      }
      return;
    }
    if (!stats.isFile()) return;
    const content = await readFile(path);
    if (content.includes(needle)) hits.push(path);
  };
  for (const root of roots) if (existsSync(root)) await visit(root);
  return hits;
}

async function safeRemoveRuntime(path) {
  const absolute = resolve(path);
  const tempRoot = resolve(tmpdir());
  assert(absolute.startsWith(`${tempRoot}${sep}`), `Refusing to remove runtime outside ${tempRoot}: ${absolute}`);
  assert(basename(absolute).startsWith('dero-hive-soak-'), `Refusing to remove unexpected runtime: ${absolute}`);
  await rm(absolute, { recursive: true, force: true });
}

async function runProbe(context, name, fn) {
  const started = performance.now();
  try {
    await fn();
    context.probePasses++;
    context.probes[name] = { passes: (context.probes[name]?.passes || 0) + 1, failures: context.probes[name]?.failures || 0 };
    event(context, 'probe-pass', { probe: name, durationMs: Math.round(performance.now() - started), cycle: context.cycle });
  } catch (error) {
    context.probeFailures++;
    context.probes[name] = { passes: context.probes[name]?.passes || 0, failures: (context.probes[name]?.failures || 0) + 1 };
    event(context, 'probe-fail', {
      probe: name,
      durationMs: Math.round(performance.now() - started),
      cycle: context.cycle,
      error: error instanceof Error ? error.message : String(error)
    }, 'error');
  }
}

async function cli(context, label, args, options = {}) {
  const result = await runProcess(
    context,
    label,
    process.execPath,
    [context.hiveEntry, ...args],
    { cwd: context.workspace, env: context.childEnv, ...options }
  );
  context.cliCommands++;
  if (result.exitCode === 0 && !result.timedOut) context.cliExitZero++;
  else context.cliNonzero++;
  return result;
}

function marker(context, prefix) {
  return `${prefix}-${context.cycle}-${Math.floor(context.random() * 0xffff_ffff).toString(16).padStart(8, '0')}`;
}

async function probeProcessTreeTermination(context) {
  const source = `
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
process.stdout.write(JSON.stringify({ descendantPid: child.pid }) + '\\n');
setInterval(() => {}, 1000);`;
  const result = await runProcess(context, 'process-tree-timeout-reap', process.execPath, ['-e', source], {
    cwd: context.runtimeRoot,
    env: context.baseEnv,
    timeoutMs: 500,
    displayArgs: ['<spawn descendant and require timeout tree reap>']
  });
  assert(result.timedOut, 'process-tree self-test did not reach its timeout.');
  assert(result.closeObserved, 'process-tree self-test settled before child close/reap.');
  assert(!result.treeTerminationError, `process-tree timeout cleanup failed: ${result.treeTerminationError}`);
  const descendantPid = JSON.parse(result.stdout.trim().split(/\r?\n/u)[0]).descendantPid;
  let descendantAlive = false;
  try { process.kill(descendantPid, 0); descendantAlive = true; } catch { /* expected after tree reap */ }
  assert(!descendantAlive, `timed-out descendant PID ${descendantPid} survived tree termination.`);
}

async function startPersistentCli(context) {
  let releaseDrive;
  const driveGate = new Promise((resolvePromise) => { releaseDrive = resolvePromise; });
  const session = {
    child: null,
    stdoutTail: '',
    stderrTail: '',
    releaseDrive,
    resultPromise: null,
    send(line) {
      assert(this.child?.stdin.writable, 'persistent CLI stdin is not writable.');
      this.child.stdin.write(`${line}\n`);
    }
  };
  const appendTail = (key, chunk) => { session[key] = `${session[key]}${chunk.toString('utf8')}`.slice(-128 * 1024); };
  session.resultPromise = cli(context, 'chat-persistent-soak-session', [
    '--classic', '--provider', PROVIDER_ID, '--model', MODEL_ID, '--cwd', context.workspace
  ], {
    timeoutMs: context.options.durationMs + 10 * 60_000,
    onSpawn: (child, controller) => { session.child = child; session.controller = controller; },
    onStdout: (chunk) => appendTail('stdoutTail', chunk),
    onStderr: (chunk) => appendTail('stderrTail', chunk),
    drive: () => driveGate
  });
  context.persistentSession = session;
  await waitFor(() => session.child?.pid && session.stdoutTail.includes('Hive CLI'), 10_000, 'the persistent classic CLI prompt');
  await startCliTreeSampler(context, session.child.pid);
  session.send('/new');
  await waitFor(() => session.stdoutTail.includes('New conversation created.'), 5_000, 'the persistent CLI conversation reset');
}

async function probePersistentSession(context) {
  const session = context.persistentSession;
  assert(session?.child && session.child.exitCode === null, 'persistent classic CLI is not running.');
  const value = marker(context, 'persistent');
  session.send(`SOAK_SIMPLE marker=${value}`);
  await waitFor(() => session.stdoutTail.includes(`simple-ok:${value}`), 15_000, 'the persistent classic CLI response');
}

async function stopPersistentCli(context) {
  const session = context.persistentSession;
  if (!session) return null;
  if (session.child?.exitCode === null && session.child?.signalCode === null) {
    try { session.send('/exit'); session.child.stdin.end(); } catch { void session.controller?.terminate(); }
  }
  session.releaseDrive();
  try {
    return await session.resultPromise;
  } finally {
    await verifyCliTreeExit(context);
    await stopCliTreeSampler(context);
  }
}

async function inspectInstalledDb(context, label, conversationId = '', projectPath = '') {
  const source = `
const { createRequire } = require('node:module');
const requireFromPackage = createRequire(${JSON.stringify(join(context.packageRoot, 'package.json'))});
const Database = requireFromPackage('better-sqlite3');
const db = new Database(${JSON.stringify(join(context.dataDir, 'hive.db'))}, { readonly: true });
const scalar = (sql, ...args) => db.prepare(sql).get(...args).value;
const conversationId = ${JSON.stringify(conversationId)};
const projectPath = ${JSON.stringify(projectPath)};
const output = {
  conversations: scalar('SELECT COUNT(*) AS value FROM conversations'),
  messages: scalar('SELECT COUNT(*) AS value FROM messages'),
  ftsMessages: scalar('SELECT COUNT(*) AS value FROM messages_fts'),
  projects: scalar('SELECT COUNT(*) AS value FROM projects'),
  settings: db.prepare('SELECT key, value, updated_at AS updatedAt FROM settings ORDER BY key').all(),
  conversation: conversationId ? db.prepare('SELECT id, project_id AS projectId, updated_at AS updatedAt, (SELECT COUNT(*) FROM messages WHERE conversation_id = conversations.id) AS messageCount FROM conversations WHERE id = ?').get(conversationId) || null : null,
  project: projectPath ? db.prepare('SELECT id, path FROM projects ORDER BY created_at DESC LIMIT 1').get() || null : null
};
db.close();
process.stdout.write(JSON.stringify(output));`;
  const result = await runProcess(context, label, process.execPath, ['-e', source], {
    cwd: context.packageRoot,
    env: context.childEnv,
    displayArgs: ['<installed better-sqlite3 read-only snapshot>']
  });
  assert(result.exitCode === 0 && !result.timedOut, `SQLite snapshot process exited ${result.exitCode}: ${result.stderr.slice(-300)}`);
  return JSON.parse(result.stdout);
}

async function probeSimple(context) {
  const value = marker(context, 'simple');
  const result = await cli(context, 'chat-simple', ['chat', `SOAK_SIMPLE marker=${value}`, '--provider', PROVIDER_ID, '--model', MODEL_ID, '--cwd', context.workspace, '--json']);
  assert(result.exitCode === 0 && !result.timedOut, `simple chat exited ${result.exitCode}${result.timedOut ? ' (timeout)' : ''}`);
  const output = lastJsonObject(result.stdout);
  assert(output.ok === true, `simple JSON result failed: ${output.error || 'unknown error'}`);
  assert(output.content === `simple-ok:${value}`, `unexpected simple response: ${output.content}`);
  assert(typeof output.conversationId === 'string' && output.conversationId.length > 10, 'simple chat returned no conversation id.');
}

async function probeTools(context) {
  const value = marker(context, 'tools');
  const beforeDero = context.fixtures.stats.deroRequests;
  const result = await cli(context, 'chat-multi-tool', ['chat', `SOAK_TOOL marker=${value}`, '--provider', PROVIDER_ID, '--model', MODEL_ID, '--cwd', context.workspace, '--json']);
  assert(result.exitCode === 0 && !result.timedOut, `tool chat exited ${result.exitCode}${result.timedOut ? ' (timeout)' : ''}`);
  const output = lastJsonObject(result.stdout);
  assert(output.ok === true, `tool JSON result failed: ${output.error || 'unknown error'}`);
  assert(output.content === `tool-sequence-ok:${value}:height=${context.height}`, `unexpected tool response: ${output.content}`);
  assert(Array.isArray(output.toolCalls) && output.toolCalls.length === 2, `expected two tool results, got ${output.toolCalls?.length ?? 'none'}.`);
  assert(output.toolCalls[0].name === 'read_file' && output.toolCalls[0].isError === false, 'read_file did not complete successfully.');
  assert(output.toolCalls[0].result.includes(context.workspaceMarker), 'read_file did not read the isolated Unicode workspace fixture.');
  assert(output.toolCalls[1].name === 'get_simulator_chain_info' && output.toolCalls[1].isError === false, 'DERO simulator read did not complete successfully.');
  assert(output.toolCalls[1].result.includes(String(context.height)), 'DERO simulator result did not contain the fixture height.');
  assert(context.fixtures.stats.deroRequests > beforeDero, 'DERO fixture received no RPC request.');
}

async function probePersistence(context) {
  const token = marker(context, 'persist');
  const first = await cli(context, 'chat-persist', ['chat', `SOAK_PERSIST token=${token}`, '--provider', PROVIDER_ID, '--model', MODEL_ID, '--cwd', context.workspace, '--json']);
  assert(first.exitCode === 0, `persistence start exited ${first.exitCode}.`);
  const saved = lastJsonObject(first.stdout);
  assert(saved.ok === true && saved.content === `persisted:${token}`, 'persistence start returned the wrong result.');
  const second = await cli(context, 'chat-resume-after-restart', ['chat', `SOAK_RESUME token=${token}`, '--conversation', saved.conversationId, '--provider', PROVIDER_ID, '--model', MODEL_ID, '--cwd', context.workspace, '--json']);
  assert(second.exitCode === 0, `resumed chat exited ${second.exitCode}.`);
  const resumed = lastJsonObject(second.stdout);
  assert(resumed.ok === true && resumed.conversationId === saved.conversationId, 'restart did not resume the same conversation.');
  assert(resumed.content === `resume-ok:${token}`, `persisted history was missing after restart: ${resumed.content}`);
}

async function probeCrossWorkspaceResume(context) {
  const value = marker(context, 'workspace');
  const created = await cli(context, 'chat-workspace-origin', [
    'chat', `SOAK_SIMPLE marker=${value}`, '--project', context.workspaceProjectId,
    '--provider', PROVIDER_ID, '--model', MODEL_ID, '--cwd', context.workspace, '--json'
  ]);
  assert(created.exitCode === 0 && !created.timedOut, `workspace-origin chat exited ${created.exitCode}.`);
  const origin = lastJsonObject(created.stdout);
  assert(origin.ok === true && typeof origin.conversationId === 'string', 'workspace-origin chat did not create a conversation.');

  const beforeDb = await inspectInstalledDb(context, 'sqlite-before-cross-workspace-resume', origin.conversationId);
  assert(beforeDb.conversation?.projectId === context.workspaceProjectId, 'workspace-origin conversation was not bound to its project.');
  const beforeWorkspace = workspaceSnapshot(context.otherWorkspace);
  const beforeModelRequests = context.fixtures.stats.modelRequests;
  const rejected = await cli(context, 'chat-cross-workspace-resume-rejected', [
    'chat', `SOAK_SIMPLE marker=${value}-wrong`, '--conversation', origin.conversationId,
    '--provider', PROVIDER_ID, '--model', MODEL_ID, '--cwd', context.otherWorkspace, '--json'
  ], { cwd: context.otherWorkspace });
  assert(rejected.exitCode !== 0 && !rejected.timedOut, `cross-workspace resume unexpectedly exited ${rejected.exitCode}.`);
  const output = lastJsonObject(rejected.stdout);
  assert(output.ok === false && /different workspace/iu.test(output.error || ''), `cross-workspace resume did not fail closed: ${output.error || rejected.stderr}`);
  assert(context.fixtures.stats.modelRequests === beforeModelRequests, 'cross-workspace resume reached the model provider before rejection.');

  const afterDb = await inspectInstalledDb(context, 'sqlite-after-cross-workspace-resume', origin.conversationId);
  assert(JSON.stringify(afterDb) === JSON.stringify(beforeDb), 'cross-workspace resume changed persisted conversations, messages, projects, or settings.');
  const afterWorkspace = workspaceSnapshot(context.otherWorkspace);
  assert(afterWorkspace.sha256 === beforeWorkspace.sha256 && afterWorkspace.entries === beforeWorkspace.entries, 'cross-workspace resume wrote into the rejected workspace.');
}

function assertNoActiveTerminalControls(result, label, allowTrustedUiAnsi = false) {
  for (const [stream, value] of [['stdout', result.stdout], ['stderr', result.stderr]]) {
    const injectedControl = value.includes('\u001b]') || value.includes('\u0007') || value.includes('\u001b[2J') || value.includes('\u001b[H');
    const anyControl = value.includes('\u001b') || value.includes('\u0007');
    assert(allowTrustedUiAnsi ? !injectedControl : !anyControl, `${label} emitted an active injected OSC/CSI/BEL control on ${stream}.`);
  }
}

async function probeTerminalControls(context) {
  const jsonMarker = marker(context, 'terminal-json');
  const jsonResult = await cli(context, 'chat-terminal-controls-json', [
    'chat', `SOAK_TERMINAL marker=${jsonMarker}`, '--provider', PROVIDER_ID,
    '--model', MODEL_ID, '--cwd', context.workspace, '--json'
  ]);
  assert(jsonResult.exitCode === 0 && !jsonResult.timedOut, `terminal JSON chat exited ${jsonResult.exitCode}.`);
  assertNoActiveTerminalControls(jsonResult, 'terminal JSON chat');
  const json = lastJsonObject(jsonResult.stdout);
  assert(json.ok === true && json.content.includes(`${TERMINAL_PROVIDER_MARKER}:${jsonMarker}`), 'terminal JSON response was not structurally valid or lost its safe marker.');
  assert(Array.isArray(json.toolCalls) && json.toolCalls.length === 1, 'terminal JSON response did not include the malicious tool fixture result.');
  assert(json.toolCalls[0].result.includes(TERMINAL_TOOL_MARKER), 'terminal JSON tool result lost its safe marker.');

  const classicMarker = marker(context, 'terminal-classic');
  const classic = await cli(context, 'chat-terminal-controls-classic', [
    'chat', `SOAK_TERMINAL marker=${classicMarker}`, '--provider', PROVIDER_ID,
    '--model', MODEL_ID, '--cwd', context.workspace
  ]);
  assert(classic.exitCode === 0 && !classic.timedOut, `terminal classic chat exited ${classic.exitCode}.`);
  assertNoActiveTerminalControls(classic, 'terminal classic chat', true);
  assert(classic.stdout.includes(TERMINAL_TOOL_MARKER), 'classic output lost the safe tool marker.');
  assert(classic.stdout.includes(`${TERMINAL_PROVIDER_MARKER}:${classicMarker}`), 'classic output lost the safe provider marker.');
}

async function probeFailure(context) {
  const value = marker(context, 'failure');
  const result = await cli(context, 'chat-expected-provider-failure', ['chat', `SOAK_FAILURE marker=${value}`, '--provider', PROVIDER_ID, '--model', MODEL_ID, '--cwd', context.workspace, '--json']);
  assert(result.exitCode !== 0 && !result.timedOut, `expected provider failure exited ${result.exitCode}.`);
  assert(!result.stdout.includes(context.canary) && !result.stderr.includes(context.canary), 'provider error leaked the secret canary.');
  const output = lastJsonObject(result.stdout);
  assert(output.ok === false && typeof output.error === 'string', 'failure probe did not emit structured JSON error output.');
  assert(output.error.includes('[REDACTED]') && !output.error.includes(context.canary), `failure error was not redacted: ${output.error}`);
}

async function probeCancellation(context) {
  const value = marker(context, 'cancel');
  const before = context.fixtures.stats.modelCancellations;
  const beforeAborts = context.fixtures.stats.modelCancellationAborts;
  const result = await cli(context, 'chat-interactive-cancellation', ['--classic', '--provider', PROVIDER_ID, '--model', MODEL_ID, '--cwd', context.workspace], {
    timeoutMs: 15_000,
    drive: async (child) => {
      const send = (line) => { if (child.stdin.writable) child.stdin.write(`${line}\n`); };
      await new Promise((done) => setTimeout(done, 250));
      send('/new');
      await new Promise((done) => setTimeout(done, 150));
      send(`SOAK_CANCEL marker=${value}`);
      await waitFor(() => context.fixtures.stats.modelCancellations > before, 5_000, 'the cancellation fixture request');
      send('/stop');
      await waitFor(() => context.fixtures.stats.modelCancellationAborts > beforeAborts, 5_000, 'the provider request to abort');
      await new Promise((done) => setTimeout(done, 300));
      send('/exit');
      await new Promise((done) => setTimeout(done, 500));
      if (child.stdin.writable) { send('/exit'); child.stdin.end(); }
    }
  });
  assert(!result.driverError, `cancellation driver failed: ${result.driverError}`);
  assert(result.exitCode === 0 && !result.timedOut, `cancelled chat exited ${result.exitCode}${result.timedOut ? ' (timeout)' : ''}.`);
  assert(/Cancelled\.|Goodbye\./u.test(result.stdout), `interactive cancellation was not acknowledged: ${result.stdout.slice(-400)}`);
  assert(context.fixtures.stats.modelCancellationAborts > beforeAborts, 'provider request remained open after /stop.');
}

async function probeIntegrity(context) {
  const source = `
const { createRequire } = require('node:module');
const requireFromPackage = createRequire(${JSON.stringify(join(context.packageRoot, 'package.json'))});
const Database = requireFromPackage('better-sqlite3');
const db = new Database(${JSON.stringify(join(context.dataDir, 'hive.db'))}, { readonly: true });
const integrity = db.pragma('integrity_check', { simple: true });
const foreignKeys = db.pragma('foreign_key_check');
db.close();
process.stdout.write(JSON.stringify({ integrity, foreignKeyViolations: foreignKeys.length }));`;
  const result = await runProcess(context, 'sqlite-integrity', process.execPath, ['-e', source], {
    cwd: context.packageRoot,
    env: context.childEnv,
    displayArgs: ['<installed better-sqlite3 integrity_check>']
  });
  assert(result.exitCode === 0 && !result.timedOut, `SQLite integrity process exited ${result.exitCode}: ${result.stderr.slice(-300)}`);
  const output = JSON.parse(result.stdout);
  assert(output.integrity === 'ok', `SQLite integrity_check returned ${JSON.stringify(output.integrity)}.`);
  assert(output.foreignKeyViolations === 0, `SQLite has ${output.foreignKeyViolations} foreign-key violation(s).`);
}

async function runCycle(context) {
  context.cycle++;
  const started = performance.now();
  event(context, 'cycle-start', { cycle: context.cycle });
  await runProbe(context, 'persistent-classic-session', () => probePersistentSession(context));
  await runProbe(context, 'one-shot-json', () => probeSimple(context));
  await runProbe(context, 'multi-round-read-only-tools', () => probeTools(context));
  await runProbe(context, 'persistence-restart', () => probePersistence(context));
  await runProbe(context, 'cross-workspace-resume', () => probeCrossWorkspaceResume(context));
  await runProbe(context, 'terminal-control-safety', () => probeTerminalControls(context));
  await runProbe(context, 'redacted-failure', () => probeFailure(context));
  await runProbe(context, 'interactive-cancellation', () => probeCancellation(context));
  await runProbe(context, 'sqlite-integrity', () => probeIntegrity(context));
  await queueMetrics(context);
  event(context, 'cycle-complete', { cycle: context.cycle, durationMs: Math.round(performance.now() - started) });
}

async function ensureEvidenceDirectory(path) {
  if (existsSync(path)) {
    assert(statSync(path).isDirectory(), `Evidence path is not a directory: ${path}`);
    assert(readdirSync(path).length === 0, `Evidence directory must be empty: ${path}`);
  } else {
    await mkdir(path, { recursive: true });
  }
}

async function writeChecksums(context, artifactHash) {
  assert((await sha256(context.options.artifact)) === artifactHash, 'Artifact changed during evidence finalization.');
  const names = ['run.json', 'events.jsonl', 'commands.jsonl', 'metrics.csv', 'dependency-graph.json', 'summary.json', 'summary.md']
    .filter((name) => existsSync(join(context.options.evidence, name)));
  const lines = [`${artifactHash}  ${context.options.artifact.replaceAll('\\', '/')}`];
  for (const name of names) lines.push(`${await sha256(join(context.options.evidence, name))}  ${name}`);
  await writeFile(join(context.options.evidence, 'SHA256SUMS'), `${lines.join('\n')}\n`, 'utf8');
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    if (options.help) { console.log(usage()); return; }
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : error}\n\n${usage()}`);
    process.exitCode = 2;
    return;
  }

  assert(isAbsolute(options.artifact) && existsSync(options.artifact) && statSync(options.artifact).isFile(), `Artifact not found: ${options.artifact}`);
  await ensureEvidenceDirectory(options.evidence);
  const runtimeRoot = await mkdtemp(join(tmpdir(), 'dero-hive-soak-'));
  const installPrefix = join(runtimeRoot, 'isolated install Ω');
  const dataDir = join(runtimeRoot, 'data with spaces Ω');
  const workspace = join(runtimeRoot, 'workspace with spaces Ω');
  const otherWorkspace = join(runtimeRoot, 'rejected workspace with spaces Ω');
  const npmCache = join(runtimeRoot, 'npm cache Ω');
  const npmUserConfig = join(runtimeRoot, 'isolated-npmrc');
  await Promise.all([mkdir(installPrefix), mkdir(dataDir), mkdir(workspace), mkdir(otherWorkspace), mkdir(npmCache)]);
  await writeFile(npmUserConfig, 'audit=false\nfund=false\nupdate-notifier=false\n', 'utf8');

  const canary = `hive_soak_canary_${randomBytes(24).toString('hex')}`;
  const scrubbed = scrubEnvironment(process.env);
  const artifactHashBefore = await sha256(options.artifact);
  const source = sourceIdentity();
  const artifactSnapshot = join(runtimeRoot, 'artifact-under-test.tgz');
  const height = 100_000 + (seedNumber(options.seed) % 800_000);
  const workspaceMarker = `workspace-fixture:${options.seed}:Ω`;
  await writeFile(join(workspace, 'fixture.txt'), `${workspaceMarker}\n`, 'utf8');
  await writeFile(join(workspace, 'terminal-fixture.txt'), `${TERMINAL_TOOL_MARKER}:${options.seed}\n${TERMINAL_ATTACK}\n`, 'utf8');
  await writeFile(join(otherWorkspace, 'do-not-touch.txt'), `rejected-workspace-fixture:${options.seed}:Ω\n`, 'utf8');

  const context = {
    options,
    runtimeRoot,
    installPrefix,
    dataDir,
    workspace,
    otherWorkspace,
    npmCache,
    canary,
    height,
    workspaceMarker,
    random: mulberry32(seedNumber(options.seed)),
    eventsPath: join(options.evidence, 'events.jsonl'),
    commandsPath: join(options.evidence, 'commands.jsonl'),
    metricsPath: join(options.evidence, 'metrics.csv'),
    childEnv: {},
    fixtures: null,
    hiveEntry: '',
    packageRoot: '',
    packageMetadata: null,
    dependencyGraph: null,
    workspaceProjectId: '',
    currentChild: null,
    activeProcessControllers: new Map(),
    processTreeErrors: [],
    activeChildren: 0,
    abortRequested: false,
    abortSignal: '',
    abortWait: null,
    soakStartedMono: 0,
    soakElapsedMs: 0,
    soakStartedAt: '',
    cycle: 0,
    commandCount: 0,
    cliCommands: 0,
    cliExitZero: 0,
    cliNonzero: 0,
    probePasses: 0,
    probeFailures: 0,
    probes: {},
    metricSamples: [],
    metricsPromise: Promise.resolve(),
    persistentSession: null,
    baseEnv: {},
    cliTree: {
      rootPid: null,
      method: null,
      latest: null,
      latestRows: [],
      lastCapturedAt: 0,
      maxSampleGapMs: 0,
      samples: [],
      observed: new Map(),
      firstIdentityByPid: new Map(),
      leftovers: [],
      errors: [],
      limitations: process.platform === 'win32'
        ? ['One-second Toolhelp snapshots cover the persistent installed CLI and every descendant visible for at least one sample; shorter-lived descendants can evade evidence, though forced cleanup uses taskkill /T /F.']
        : existsSync('/proc/self/status')
          ? ['One-second procfs snapshots plus process-group checks cover the persistent installed CLI; a descendant that daemonizes into another process group between samples can evade attribution.']
          : ['One-second ps snapshots provide PID/PPID/RSS only; handle/FD counts and reliable PID-reuse identity are unavailable on this POSIX platform.'],
      sampler: null,
      samplerClosed: null,
      samplerStderr: '',
      stopping: false
    },
    fatalError: '',
    redact(value) { return String(value || '').replaceAll(canary, '[REDACTED_CANARY]'); }
  };
  writeFileSync(context.eventsPath, '', 'utf8');
  writeFileSync(context.commandsPath, '', 'utf8');
  writeFileSync(context.metricsPath, 'timestamp,elapsed_ms,cycle,rss_bytes,heap_used_bytes,load_1m,free_mem_bytes,total_mem_bytes,probe_passes,probe_failures,model_requests,dero_requests,db_bytes,wal_bytes,active_handles,active_requests,open_fds,active_children,cli_tree_root_pid,cli_tree_processes,cli_tree_descendants,cli_tree_rss_bytes,cli_tree_handles,cli_tree_fds,cli_tree_sample_age_ms\n', 'utf8');

  const baseEnv = {
    ...scrubbed.env,
    HIVE_KEYCHAIN_DISABLED: '1',
    HIVE_DATA_DIR: dataDir,
    HIVE_WORKSPACE: workspace,
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    npm_config_cache: npmCache,
    npm_config_userconfig: npmUserConfig,
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false'
  };
  assert(!Object.keys(baseEnv).some((key) => /^DERO_/iu.test(key)), 'A DERO variable survived inherited-environment scrubbing.');
  assert(!Object.hasOwn(baseEnv, 'HIVE_SIMULATOR_RPC_URL'), 'An inherited simulator RPC override survived environment scrubbing.');
  context.baseEnv = baseEnv;
  context.childEnv = baseEnv;

  const runMetadata = {
    schemaVersion: 2,
    status: 'running',
    startedAt: new Date().toISOString(),
    mode: options.mode,
    requestedDuration: options.durationText,
    requestedDurationMs: options.durationMs,
    cadence: options.cadenceText,
    cadenceMs: options.cadenceMs,
    seed: options.seed,
    artifact: options.artifact,
    artifactSha256Before: artifactHashBefore,
    source,
    dependencyResolutionNote: 'The tarball SHA-256 identifies only the supplied artifact; unbundled dependencies are identified by the installed dependency-graph SHA-256 below.',
    node: process.version,
    npmRequiredMajor: 12,
    platform: `${platform()} ${release()}`,
    cpuCount: cpus().length,
    inheritedCredentialVariablesStripped: scrubbed.stripped,
    inheritedDeroVariablesStripped: scrubbed.strippedDeroVariables,
    isolation: { dataDir, workspace, rejectedWorkspace: otherWorkspace, installPrefix, keychainDisabled: true },
    fixture: { deroDaemonBaseUrl: null, simulatorRpcUrl: null, height }
  };
  await writeFile(join(options.evidence, 'run.json'), `${JSON.stringify(runMetadata, null, 2)}\n`, 'utf8');
  event(context, 'run-start', { mode: options.mode, durationMs: options.durationMs, artifactSha256: artifactHashBefore, sourceCommit: source.commit });

  const onSignal = (signal) => {
    context.abortRequested = true;
    context.abortSignal = signal;
    event(context, 'signal', { signal }, 'warn');
    context.abortWait?.();
    for (const controller of context.activeProcessControllers.values()) void controller.terminate();
  };
  const onSigint = () => onSignal('SIGINT');
  const onSigterm = () => onSignal('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);

  let artifactHashAfter;
  let artifactSnapshotHashBefore = 'unreadable';
  let artifactSnapshotHashAfter = 'unreadable';
  let canaryHits = [];
  let runtimeCleaned = false;
  let fixtureStats = {};
  try {
    assert(/^[0-9a-f]{40}$/u.test(source.commit) && source.rootMatchesHarness && !source.error, `Source commit identity is unavailable: ${source.error || source.commit || 'source root mismatch'}`);
    assert(source.workingTreeClean, 'Source checkout has tracked or untracked changes; commit the exact artifact source before starting evidence collection.');
    await copyFile(options.artifact, artifactSnapshot);
    artifactSnapshotHashBefore = await sha256(artifactSnapshot);
    assert(artifactSnapshotHashBefore === artifactHashBefore, 'Artifact changed while the isolated install snapshot was created.');
    await runProbe(context, 'process-tree-timeout-reap', () => probeProcessTreeTermination(context));
    assert(context.probes['process-tree-timeout-reap']?.passes === 1, 'process-tree timeout/reap self-test failed.');
    const npmCli = findNpmCli();
    assert(npmCli, 'Could not locate npm-cli.js next to the active Node.js installation.');
    const npmVersionResult = await runProcess(context, 'npm-version', process.execPath, [npmCli, '--version'], { env: baseEnv, cwd: runtimeRoot });
    assert(npmVersionResult.exitCode === 0, `npm --version failed: ${npmVersionResult.stderr}`);
    const npmVersion = npmVersionResult.stdout.trim();
    assert(Number.parseInt(npmVersion.split('.')[0], 10) === 12, `npm 12 is required for strict script allow-listing; found ${npmVersion}.`);
    runMetadata.npm = npmVersion;

    const install = await runProcess(context, 'install-exact-artifact', process.execPath, [
      npmCli,
      'install',
      '--global',
      '--prefix', installPrefix,
      '--no-audit',
      '--no-fund',
      '--allow-remote=none',
      '--allow-scripts=better-sqlite3@11.10.0',
      '--strict-allow-scripts',
      artifactSnapshot
    ], { env: baseEnv, cwd: runtimeRoot, timeoutMs: 10 * 60_000 });
    assert(install.exitCode === 0 && !install.timedOut, `npm install failed (${install.exitCode}): ${install.stderr.slice(-2_000)}`);
    assert((await sha256(artifactSnapshot)) === artifactHashBefore, 'Isolated artifact snapshot changed during installation.');
    assert((await sha256(options.artifact)) === artifactHashBefore, 'Supplied artifact hash changed during installation.');

    context.packageRoot = installedPackageRoot(installPrefix);
    assert(context.packageRoot, 'Installed dero-hive-cli package root was not found.');
    context.packageMetadata = JSON.parse(await readFile(join(context.packageRoot, 'package.json'), 'utf8'));
    assert(context.packageMetadata.name === 'dero-hive-cli', `Wrong project artifact: expected dero-hive-cli, got ${context.packageMetadata.name || '(missing name)'}.`);
    assert(
      context.packageMetadata.repository?.url === 'git+https://github.com/Dirtybird99/dero-hive-cli.git',
      `Wrong project repository: expected Dirtybird99/dero-hive-cli, got ${context.packageMetadata.repository?.url || '(missing repository)'}.`
    );
    context.hiveEntry = join(context.packageRoot, 'cli', 'bin', 'hive.js');
    assert(existsSync(context.hiveEntry), `Installed CLI entry is missing: ${context.hiveEntry}`);
    runMetadata.package = { name: context.packageMetadata.name, version: context.packageMetadata.version };

    const dependencyResult = await runProcess(context, 'installed-dependency-graph', process.execPath, [
      npmCli, 'ls', '--global', '--prefix', installPrefix, '--all', '--json'
    ], { env: baseEnv, cwd: runtimeRoot, timeoutMs: 2 * 60_000 });
    assert(dependencyResult.exitCode === 0 && !dependencyResult.timedOut, `npm dependency graph failed (${dependencyResult.exitCode}): ${dependencyResult.stderr.slice(-1_000)}`);
    const dependencyJson = canonicalJson(JSON.parse(dependencyResult.stdout));
    const dependencySha256 = createHash('sha256').update(dependencyJson).digest('hex');
    await writeFile(join(options.evidence, 'dependency-graph.json'), dependencyJson, 'utf8');
    assert((await sha256(join(options.evidence, 'dependency-graph.json'))) === dependencySha256, 'Installed dependency-graph hash was not reproducible from its canonical evidence file.');
    context.dependencyGraph = {
      file: 'dependency-graph.json',
      sha256: dependencySha256,
      canonicalization: 'recursive lexicographic object-key ordering; array order preserved; UTF-8; no trailing newline',
      command: 'npm ls --global --prefix <isolated-prefix> --all --json'
    };
    runMetadata.dependencyGraph = context.dependencyGraph;

    context.fixtures = createFixtureServers({ canary, height });
    const fixtureUrls = await context.fixtures.start();
    const parsedDeroUrl = new URL(fixtureUrls.deroRpcUrl);
    assert(parsedDeroUrl.hostname === '127.0.0.1' && Number(parsedDeroUrl.port) > 0 && parsedDeroUrl.pathname === '/json_rpc', `DERO fixture URL is not isolated loopback RPC: ${fixtureUrls.deroRpcUrl}`);
    context.childEnv = {
      ...baseEnv,
      HIVE_PROVIDER_SOAK_LOCAL_API_KEY: canary,
      DERO_DAEMON_URL: fixtureUrls.deroBaseUrl,
      HIVE_SIMULATOR_RPC_URL: fixtureUrls.deroRpcUrl
    };
    const routedDeroKeys = Object.keys(context.childEnv).filter((key) => /^DERO_/iu.test(key));
    assert(routedDeroKeys.length === 1 && routedDeroKeys[0] === 'DERO_DAEMON_URL', `Unexpected inherited DERO routing variables survived: ${routedDeroKeys.join(', ')}`);
    assert(context.childEnv.DERO_DAEMON_URL === fixtureUrls.deroBaseUrl, 'Dynamic DERO daemon URL was not propagated exactly.');
    assert(context.childEnv.HIVE_SIMULATOR_RPC_URL === fixtureUrls.deroRpcUrl, 'Dynamic simulator RPC URL was not propagated exactly.');
    runMetadata.fixture.openAiBaseUrl = fixtureUrls.modelBaseUrl;
    runMetadata.fixture.deroDaemonBaseUrl = fixtureUrls.deroBaseUrl;
    runMetadata.fixture.simulatorRpcUrl = fixtureUrls.deroRpcUrl;
    await writeFile(join(options.evidence, 'run.json'), `${JSON.stringify(runMetadata, null, 2)}\n`, 'utf8');

    const version = await cli(context, 'hive-version', ['--version']);
    assert(version.exitCode === 0 && version.stdout.includes(context.packageMetadata.version), `Installed CLI version check failed: ${version.stdout}${version.stderr}`);
    const status = await cli(context, 'hive-status-before-provider', ['status']);
    assert(status.exitCode === 0, `Installed CLI status failed: ${status.stderr}`);
    const doctor = await cli(context, 'hive-doctor', ['doctor']);
    assert(doctor.exitCode === 0 && doctor.stdout.includes('Doctor: ready'), `Installed CLI doctor failed: ${doctor.stdout}${doctor.stderr}`);
    const provider = await cli(context, 'configure-local-provider', [
      'provider', 'add', '--preset', 'openai', '--id', PROVIDER_ID, '--name', 'Deterministic Soak Fixture',
      '--base-url', fixtureUrls.modelBaseUrl, '--model', MODEL_ID, '--enabled'
    ]);
    assert(provider.exitCode === 0, `Local provider setup failed: ${provider.stdout}${provider.stderr}`);
    assert(context.fixtures.stats.modelAuthFailures === 0, 'Fixture provider saw an invalid authorization header during setup.');
    const project = await cli(context, 'configure-workspace-project', [
      'project', 'add', '--name', 'Deterministic Soak Workspace', '--path', workspace, '--icon', 'Ω'
    ]);
    assert(project.exitCode === 0, `Workspace project setup failed: ${project.stdout}${project.stderr}`);
    const projectState = await inspectInstalledDb(context, 'sqlite-find-workspace-project', '', workspace);
    assert(typeof projectState.project?.id === 'string', 'Configured workspace project was not persisted.');
    assert(projectState.projects === 1 && samePath(projectState.project.path, workspace), `Configured project path did not match the isolated workspace: ${projectState.project?.path || 'missing'}`);
    context.workspaceProjectId = projectState.project.id;
    event(context, 'preflight-pass', { package: `${context.packageMetadata.name}@${context.packageMetadata.version}`, npm: runMetadata.npm });

    let metricsTimer;
    let persistentResult;
    try {
      await startPersistentCli(context);
      context.soakStartedMono = performance.now();
      context.soakStartedAt = new Date().toISOString();
      await queueMetrics(context);
      metricsTimer = setInterval(() => {
        void queueMetrics(context).catch((error) => {
          const message = `Metrics sampler failed: ${error instanceof Error ? error.message : error}`;
          recordCliTreeError(context, message);
        });
      }, 1_000);
      do {
        const cycleStarted = performance.now();
        await runCycle(context);
        if (context.abortRequested) break;
        const elapsed = performance.now() - context.soakStartedMono;
        const remaining = options.durationMs - elapsed;
        if (remaining <= 0) break;
        const cadenceWait = Math.max(0, options.cadenceMs - (performance.now() - cycleStarted));
        await sleep(context, Math.min(cadenceWait, remaining));
      } while (!context.abortRequested && performance.now() - context.soakStartedMono < options.durationMs);
    } finally {
      clearInterval(metricsTimer);
      if (context.soakStartedMono) {
        await queueMetrics(context);
        context.soakElapsedMs = Math.round(performance.now() - context.soakStartedMono);
      }
      persistentResult = await stopPersistentCli(context);
      await queueMetrics(context);
    }
    assert(persistentResult?.exitCode === 0 && !persistentResult.timedOut, `Persistent classic CLI did not exit cleanly: ${persistentResult?.exitCode ?? 'no result'}.`);
    assert(!persistentResult.treeTerminationError, `Persistent classic CLI tree cleanup failed: ${persistentResult.treeTerminationError}`);
    assert(context.cliTree.leftovers.length === 0, `Persistent classic CLI left descendant processes: ${JSON.stringify(context.cliTree.leftovers)}`);
    assert(context.fixtures.stats.modelAuthFailures === 0, `Fixture saw ${context.fixtures.stats.modelAuthFailures} invalid provider authorization request(s).`);
    assert(context.fixtures.stats.deroRouteFailures === 0, `Fixture saw ${context.fixtures.stats.deroRouteFailures} incorrectly routed DERO request(s).`);
  } catch (error) {
    context.fatalError = error instanceof Error ? error.message : String(error);
    event(context, 'fatal', { error: context.fatalError }, 'error');
  } finally {
    if (context.fixtures) {
      fixtureStats = JSON.parse(JSON.stringify(context.fixtures.stats));
      await context.fixtures.close();
    }
    artifactHashAfter = await sha256(options.artifact).catch(() => 'unreadable');
    artifactSnapshotHashAfter = await sha256(artifactSnapshot).catch(() => 'unreadable');
    try {
      canaryHits = await scanForCanary([runtimeRoot, options.evidence], canary);
      if (canaryHits.length) event(context, 'secret-canary-found', { files: canaryHits }, 'error');
    } catch (error) {
      context.fatalError ||= `Secret-canary scan failed: ${error instanceof Error ? error.message : error}`;
    }
    try {
      await safeRemoveRuntime(runtimeRoot);
      runtimeCleaned = true;
    } catch (error) {
      context.fatalError ||= `Runtime cleanup failed: ${error instanceof Error ? error.message : error}`;
    }
  }

  const elapsedMs = context.soakElapsedMs;
  const durationFulfilled = elapsedMs >= options.durationMs;
  const requiredProbes = [
    'process-tree-timeout-reap', 'persistent-classic-session',
    'one-shot-json', 'multi-round-read-only-tools', 'persistence-restart',
    'cross-workspace-resume', 'terminal-control-safety', 'redacted-failure',
    'interactive-cancellation', 'sqlite-integrity'
  ];
  const missingProbes = requiredProbes.filter((name) => !context.probes[name]?.passes);
  const resources = resourceEvidence(context);
  const status = !context.fatalError
    && !context.abortRequested
    && durationFulfilled
    && context.probeFailures === 0
    && missingProbes.length === 0
    && resources.leakFlags.length === 0
    && canaryHits.length === 0
    && artifactHashAfter === artifactHashBefore
    && artifactSnapshotHashBefore === artifactHashBefore
    && artifactSnapshotHashAfter === artifactHashBefore
    ? 'passed'
    : context.abortRequested ? 'aborted' : 'failed';
  const summary = {
    schemaVersion: 2,
    status,
    startedAt: runMetadata.startedAt,
    soakStartedAt: context.soakStartedAt || null,
    completedAt: new Date().toISOString(),
    mode: options.mode,
    requestedDuration: options.durationText,
    requestedDurationMs: options.durationMs,
    elapsedMs,
    durationFulfilled,
    cadence: options.cadenceText,
    seed: options.seed,
    source,
    cycles: context.cycle,
    probes: context.probes,
    probePasses: context.probePasses,
    probeFailures: context.probeFailures,
    missingProbes,
    subprocesses: {
      total: context.commandCount,
      cli: context.cliCommands,
      cliExitZero: context.cliExitZero,
      cliNonzero: context.cliNonzero
    },
    resources,
    artifact: {
      path: options.artifact,
      sha256Before: artifactHashBefore,
      sha256After: artifactHashAfter,
      unchanged: artifactHashAfter === artifactHashBefore,
      installSnapshot: {
        sha256Before: artifactSnapshotHashBefore,
        sha256After: artifactSnapshotHashAfter,
        unchanged: artifactSnapshotHashBefore === artifactHashBefore && artifactSnapshotHashAfter === artifactHashBefore
      },
      package: runMetadata.package || null,
      dependencyGraph: context.dependencyGraph,
      dependencyResolutionNote: runMetadata.dependencyResolutionNote
    },
    fixtures: fixtureStats,
    isolation: {
      inheritedCredentialVariablesStripped: scrubbed.stripped,
      inheritedDeroVariablesStripped: scrubbed.strippedDeroVariables,
      dynamicDeroDaemonUrl: runMetadata.fixture.deroDaemonBaseUrl,
      dynamicSimulatorRpcUrl: runMetadata.fixture.simulatorRpcUrl,
      keychainDisabled: true,
      spacesAndUnicodePaths: true,
      secretCanaryHits: canaryHits,
      runtimeCleaned
    },
    abortedBy: context.abortSignal || null,
    fatalError: context.fatalError || null
  };
  runMetadata.status = status;
  runMetadata.completedAt = summary.completedAt;
  runMetadata.artifactSha256After = artifactHashAfter;
  runMetadata.artifactInstallSnapshotSha256Before = artifactSnapshotHashBefore;
  runMetadata.artifactInstallSnapshotSha256After = artifactSnapshotHashAfter;
  runMetadata.elapsedMs = elapsedMs;
  runMetadata.cycles = context.cycle;
  runMetadata.processTreeEvidence = {
    method: resources.cliTree.method,
    samples: resources.cliTree.samples,
    observedIdentities: resources.cliTree.observedIdentities,
    maxSampleGapMs: resources.cliTree.maxSampleGapMs,
    maxSampleAgeMs: resources.cliTree.maxSampleAgeMs,
    leftovers: resources.cliTree.leftovers,
    limitations: resources.cliTree.limitations
  };
  await writeFile(join(options.evidence, 'run.json'), `${JSON.stringify(runMetadata, null, 2)}\n`, 'utf8');
  await writeFile(join(options.evidence, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  const probeLines = requiredProbes.map((name) => `| ${name} | ${context.probes[name]?.passes || 0} | ${context.probes[name]?.failures || 0} |`).join('\n');
  const resourceLines = [
    ...Object.entries(resources.trends),
    ...Object.entries(resources.cliTree.trends).map(([name, trend]) => [`cliTree.${name}`, trend])
  ].map(([name, trend]) => `| ${name} | ${trend.first ?? 'n/a'} | ${trend.last ?? 'n/a'} | ${trend.max ?? 'n/a'} | ${trend.delta ?? 'n/a'} | ${trend.medianDelta ?? 'n/a'} | ${trend.slopePerSample ?? 'n/a'} | ${trend.monotonicGrowth ? 'yes' : 'no'} | ${trend.sustainedGrowth ? 'yes' : 'no'} |`).join('\n');
  let markdown = `# DERO Hive CLI ${options.mode} evidence

- Status: **${status.toUpperCase()}**
- Artifact: \`${basename(options.artifact)}\`
- SHA-256: \`${artifactHashBefore}\` (${artifactHashAfter === artifactHashBefore ? 'unchanged' : 'CHANGED'})
- Source commit: \`${source.commit || 'unavailable'}\` (${source.workingTreeClean ? 'clean working tree' : 'DIRTY working tree'})
- Isolated install snapshot: ${artifactSnapshotHashBefore === artifactHashBefore && artifactSnapshotHashAfter === artifactHashBefore ? 'matched and remained unchanged' : 'FAILED'}
- Installed dependency graph SHA-256: \`${context.dependencyGraph?.sha256 || 'unavailable'}\`
- Dependency resolution: the tarball hash identifies the supplied artifact only; \`dependency-graph.json\` identifies the exact resolved installed graph used by this run.
- Package: \`${runMetadata.package ? `${runMetadata.package.name}@${runMetadata.package.version}` : 'unavailable'}\`
- Requested wall clock: ${options.durationText} (${options.durationMs} ms)
- Observed wall clock: ${elapsedMs} ms (${durationFulfilled ? 'fulfilled' : 'not fulfilled'})
- Cycles: ${context.cycle}
- Secret-canary hits: ${canaryHits.length}
- Runtime cleaned: ${runtimeCleaned}
- Resource leak flags: ${resources.leakFlags.length ? resources.leakFlags.join('; ') : 'none'}
- CLI tree sampler: ${resources.cliTree.method || 'unavailable'} (${resources.cliTree.samples} samples, ${resources.cliTree.observedIdentities} observed identities, ${resources.cliTree.maxSampleGapMs} ms max gap, ${resources.cliTree.maxSampleAgeMs} ms max age)
- CLI tree leftovers: ${resources.cliTree.leftovers.length}

| Probe | Passes | Failures |
| --- | ---: | ---: |
${probeLines}

| Resource | First | Last | Max | Delta | Window median delta | Slope/sample | Monotonic | Sustained |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
${resourceLines}

Process-tree limitation: ${resources.cliTree.limitations.join(' ')}

${context.fatalError ? `Fatal error: ${context.redact(context.fatalError)}\n` : ''}${context.abortSignal ? `Aborted by: ${context.abortSignal}\n` : ''}`;
  await writeFile(join(options.evidence, 'summary.md'), markdown, 'utf8');

  const finalEvidenceHits = await scanForCanary([options.evidence], canary);
  if (finalEvidenceHits.length) {
    summary.status = 'failed';
    summary.isolation.secretCanaryHits = [...new Set([...canaryHits, ...finalEvidenceHits])];
    summary.fatalError = context.redact(summary.fatalError || 'Secret canary was written to evidence.');
    runMetadata.status = 'failed';
    runMetadata.fatalError = summary.fatalError;
    markdown = `${markdown.replace(/- Status: \*\*[^*]+\*\*/u, '- Status: **FAILED**')}\nFinal evidence canary scan: **FAILED**\n`;
    await Promise.all([
      writeFile(join(options.evidence, 'run.json'), `${context.redact(JSON.stringify(runMetadata, null, 2))}\n`, 'utf8'),
      writeFile(join(options.evidence, 'summary.json'), `${context.redact(JSON.stringify(summary, null, 2))}\n`, 'utf8'),
      writeFile(join(options.evidence, 'summary.md'), context.redact(markdown), 'utf8')
    ]);
  }
  await writeChecksums(context, artifactHashBefore);
  event(context, 'run-complete', { status: summary.status, elapsedMs, cycles: context.cycle });
  // events.jsonl changed after checksumming; regenerate the manifest last.
  await writeChecksums(context, artifactHashBefore);
  process.removeListener('SIGINT', onSigint);
  process.removeListener('SIGTERM', onSigterm);
  console.log(`Result: ${summary.status}. Evidence: ${options.evidence}`);
  if (summary.status !== 'passed') process.exitCode = context.abortRequested ? 130 : 1;
}

await main();
