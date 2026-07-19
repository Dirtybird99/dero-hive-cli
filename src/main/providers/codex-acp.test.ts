import assert from 'node:assert/strict';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Message } from '@shared/types';
import type { ProviderConfig } from '@shared/types';
import { canonicalizePath } from '../utils/pathPolicy';
import {
  acpMessageContextKey,
  CODEX_ACP_MAX_READ_BYTES,
  CODEX_ACP_MAX_WRITE_BYTES,
  CodexAcpAdapter,
  CodexAcpClient,
  continuesAcpContext
} from './codex-acp';

interface RuntimeProbe {
  proc: ChildProcessWithoutNullStreams;
  exited: Promise<void>;
  sessionRoots: Map<string, string>;
}

function within<T>(promise: Promise<T>, ms = 3_000): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`Operation did not settle within ${ms}ms`)), ms);
    timer.unref();
    promise.then(
      (value) => { clearTimeout(timer); resolvePromise(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

async function runtimeOf(adapter: CodexAcpAdapter): Promise<RuntimeProbe> {
  const promise = (adapter as unknown as { runtimePromise: Promise<RuntimeProbe> | null }).runtimePromise;
  assert.ok(promise, 'adapter runtime should have started');
  return promise;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const message = (id: string, content: string): Message => ({ id, role: 'user', content, createdAt: 1 });
const first = message('first', 'original request');
const priorKeys = [acpMessageContextKey(first)];

assert.equal(continuesAcpContext('system', priorKeys, 'system', [first, message('next', 'continue')]), true);
assert.equal(continuesAcpContext('system', priorKeys, 'changed system', [first]), false);
assert.equal(continuesAcpContext('system', priorKeys, 'system', [message('first', 'edited request')]), false);
assert.equal(continuesAcpContext('system', priorKeys, 'system', [message('summary', '<context_compaction>')]), false);
assert.equal(continuesAcpContext('system', priorKeys, 'system', []), false);

// ACP file callbacks are scoped to the canonical root of their exact session.
const fileDir = mkdtempSync(join(tmpdir(), 'dero-hive-codex-files-'));
const firstRoot = join(fileDir, 'first');
const secondRoot = join(fileDir, 'second');
mkdirSync(firstRoot);
mkdirSync(secondRoot);
const sessionRoots = new Map([
  ['session-a', canonicalizePath(firstRoot)],
  ['session-b', canonicalizePath(secondRoot)]
]);
const readOnlySessions = new Set<string>();
const fileClient = new CodexAcpClient(new Map(), new Map(), readOnlySessions, sessionRoots);
try {
  writeFileSync(join(firstRoot, 'lines.txt'), 'one\ntwo\nthree\nfour\n');
  writeFileSync(join(secondRoot, 'secret.txt'), 'not visible to session-a');

  assert.deepEqual(
    fileClient.readTextFile({ sessionId: 'session-a', path: 'lines.txt', line: 2, limit: 2 }),
    { content: 'two\nthree' },
    'ACP line and limit parameters must be honored'
  );
  assert.equal(
    fileClient.readTextFile({ sessionId: 'session-a', path: 'lines.txt', line: 3 }).content,
    'three\nfour\n'
  );
  assert.equal(fileClient.readTextFile({ sessionId: 'session-a', path: 'lines.txt', line: 99 }).content, '');
  assert.throws(
    () => fileClient.readTextFile({ sessionId: 'unknown', path: join(firstRoot, 'lines.txt') }),
    /unknown Codex session/iu
  );
  assert.throws(
    () => fileClient.readTextFile({ sessionId: 'session-a', path: join(secondRoot, 'secret.txt') }),
    /outside allowed workspace/iu
  );
  for (const line of [0, -1, 1.5, 0x1_0000_0000, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => fileClient.readTextFile({ sessionId: 'session-a', path: 'lines.txt', line }),
      /line must be an integer/iu
    );
  }
  for (const limit of [0, -1, 1.5, 0x1_0000_0000, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => fileClient.readTextFile({ sessionId: 'session-a', path: 'lines.txt', limit }),
      /limit must be an integer/iu
    );
  }

  const oversizedRead = join(firstRoot, 'oversized-read.txt');
  writeFileSync(oversizedRead, Buffer.alloc(CODEX_ACP_MAX_READ_BYTES + 1, 0x61));
  assert.throws(
    () => fileClient.readTextFile({ sessionId: 'session-a', path: oversizedRead }),
    /read limit/iu
  );

  const output = join(firstRoot, 'nested', 'output.txt');
  fileClient.writeTextFile({ sessionId: 'session-a', path: output, content: 'first' });
  if (process.platform !== 'win32') chmodSync(output, 0o755);
  fileClient.writeTextFile({ sessionId: 'session-a', path: output, content: 'replacement' });
  assert.equal(readFileSync(output, 'utf8'), 'replacement');
  if (process.platform !== 'win32') {
    assert.equal(statSync(output).mode & 0o777, 0o755, 'atomic replacement preserves executable mode bits');
  }
  assert.throws(
    () => fileClient.writeTextFile({ sessionId: 'session-a', path: join(secondRoot, 'blocked.txt'), content: 'blocked' }),
    /outside allowed workspace/iu
  );
  assert.throws(
    () => fileClient.writeTextFile({ sessionId: 'unknown', path: join(firstRoot, 'unknown.txt'), content: 'blocked' }),
    /unknown Codex session/iu
  );

  readOnlySessions.add('session-a');
  assert.throws(
    () => fileClient.writeTextFile({ sessionId: 'session-a', path: output, content: 'plan mode write' }),
    /read-only/iu
  );
  readOnlySessions.delete('session-a');

  assert.throws(
    () => fileClient.writeTextFile({
      sessionId: 'session-a', path: output, content: 'x'.repeat(CODEX_ACP_MAX_WRITE_BYTES + 1)
    }),
    /write limit/iu
  );
  assert.equal(readFileSync(output, 'utf8'), 'replacement', 'rejected writes must leave the target unchanged');

  const directoryTarget = join(firstRoot, 'directory-target');
  mkdirSync(directoryTarget);
  assert.throws(
    () => fileClient.writeTextFile({ sessionId: 'session-a', path: directoryTarget, content: 'must fail' }),
    /EACCES|EEXIST|EISDIR|EPERM|non-file/iu,
    'filesystem write failures must propagate'
  );
  assert.equal(
    readdirSync(firstRoot).some((name) => name.startsWith('.dero-hive-')),
    false,
    'failed atomic writes must clean up their staging file'
  );
} finally {
  rmSync(fileDir, { recursive: true, force: true });
}

const fakeCommand = fileURLToPath(new URL('./fake-codex-acp.fixture.js', import.meta.url));
const config: ProviderConfig = {
  id: 'codex-fake', presetId: 'codex', name: 'Codex fake', baseUrl: '', enabled: true,
  models: [{ id: 'fake-model', name: 'Fake model' }], customHeaders: { commandPath: fakeCommand }
};
const adapter = new CodexAcpAdapter(config);
let adapterRuntime: RuntimeProbe | undefined;
try {
  const controller = new AbortController();
  const first = adapter.stream({
    conversationId: 'first', cwd: process.cwd(), model: 'fake-model', messages: [message('cancel', 'cancel me')], signal: controller.signal
  });
  assert.equal((await first.next()).value?.content, 'first-start');
  adapterRuntime = await runtimeOf(adapter);
  assert.deepEqual([...adapterRuntime.sessionRoots.values()], [canonicalizePath(process.cwd())]);
  controller.abort();
  assert.equal((await first.next()).value?.error, 'Request cancelled.');
  assert.equal((await first.next()).done, true);
  assert.equal(adapterRuntime.sessionRoots.size, 0, 'closing a cancelled session must clear its root');

  const secondContent: string[] = [];
  for await (const event of adapter.stream({
    conversationId: 'first', cwd: process.cwd(), model: 'fake-model', messages: [message('next', 'next turn')]
  })) {
    if (event.content) secondContent.push(event.content);
  }
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(secondContent, ['second-only'], 'late events from a cancelled session must not reach the next turn');
} finally {
  await adapter.dispose();
}
assert.equal(adapterRuntime?.sessionRoots.size, 0, 'disposing the adapter must clear all session roots');

// ---------------------------------------------------------------------------
// Lifecycle: pre-aborted signals, disposal semantics, and double-dispose.
// ---------------------------------------------------------------------------
const lifecycle = new CodexAcpAdapter(config);
try {
  const preAborted = new AbortController();
  preAborted.abort();
  const never = lifecycle.stream({
    conversationId: 'pre-aborted', cwd: process.cwd(), model: 'fake-model',
    messages: [message('never', 'must not be sent')], signal: preAborted.signal
  });
  await assert.rejects(
    never.next(),
    (error: unknown) => (error as { name?: string }).name === 'AbortError'
      && /cancelled/iu.test((error as Error).message),
    'a signal aborted before the prompt is sent must cancel without prompting'
  );
  await lifecycle.closeConversation('never-existed'); // unknown conversations are a safe no-op
} finally {
  await lifecycle.dispose();
}

await lifecycle.dispose(); // double-dispose must be safe
await assert.rejects(
  lifecycle.stream({
    conversationId: 'post-dispose', cwd: process.cwd(), model: 'fake-model', messages: [message('post', 'after dispose')]
  }).next(),
  /disposed/u,
  'streaming after dispose must be refused'
);
const disposedProbe = await lifecycle.testConnection();
assert.equal(disposedProbe.ok, false);
assert.match(disposedProbe.error || '', /disposed/u);
await lifecycle.closeConversation('post-dispose'); // safe no-op once the runtime is gone

const neverStarted = new CodexAcpAdapter(config);
await neverStarted.dispose(); // disposing before first use must not spawn or throw
await assert.rejects(
  neverStarted.stream({
    conversationId: 'unused', cwd: process.cwd(), model: 'fake-model', messages: [message('unused', 'never sent')]
  }).next(),
  /disposed/u
);

// If newSession resolves after its timeout, the late session must be closed.
const lateAdapter = new CodexAcpAdapter(config, 10);
const lateRoots = new Map<string, string>();
const closedSessionIds: string[] = [];
let reportClosed!: () => void;
const lateClosed = new Promise<void>((resolveClosed) => { reportClosed = resolveClosed; });
const lateRuntime = {
  conn: {
    newSession: () => new Promise<{ sessionId: string; configOptions: [] }>((resolveSession) => {
      setTimeout(() => resolveSession({ sessionId: 'late-session', configOptions: [] }), 40);
    }),
    closeSession: async ({ sessionId }: { sessionId: string }) => {
      closedSessionIds.push(sessionId);
      reportClosed();
      return {};
    }
  },
  sessionRoots: lateRoots
};
try {
  const startSession = (lateAdapter as unknown as {
    newSession(runtime: unknown, cwd: string): Promise<{ sessionId: string }>;
  }).newSession.bind(lateAdapter);
  await assert.rejects(
    within(startSession(lateRuntime, process.cwd()), 500),
    /session creation timed out/iu
  );
  await within(lateClosed, 500);
  assert.deepEqual(closedSessionIds, ['late-session']);
  assert.equal(lateRoots.size, 0);
} finally {
  await lateAdapter.dispose();
}

// A dead ACP child must release a stream that is blocked waiting for its next event.
const exited = new CodexAcpAdapter(config);
try {
  const stream = exited.stream({
    conversationId: 'child-exit', cwd: process.cwd(), model: 'fake-model', messages: [message('exit', 'wait for exit')]
  });
  assert.equal((await within(stream.next())).value?.content, 'first-start');
  const waiting = stream.next();
  const exitedRuntime = await runtimeOf(exited);
  assert.equal(exitedRuntime.sessionRoots.size, 1);
  exitedRuntime.proc.kill();
  const terminal = await within(waiting);
  assert.equal(terminal.value?.type, 'error');
  assert.equal((await within(stream.next())).done, true);
  await within(exitedRuntime.exited);
  assert.equal(exitedRuntime.sessionRoots.size, 0, 'process exit must clear all session roots');
} finally {
  await within(exited.dispose());
}

// Disposal closes pending queues before stopping the child, so consumers cannot hang.
const pendingDispose = new CodexAcpAdapter(config);
const pendingStream = pendingDispose.stream({
  conversationId: 'pending-dispose', cwd: process.cwd(), model: 'fake-model', messages: [message('dispose', 'wait for dispose')]
});
assert.equal((await within(pendingStream.next())).value?.content, 'first-start');
const pendingRuntime = await runtimeOf(pendingDispose);
assert.equal(pendingRuntime.sessionRoots.size, 1);
const pendingEvent = pendingStream.next();
const disposing = pendingDispose.dispose();
assert.match((await within(pendingEvent)).value?.error || '', /disposed/u);
assert.equal((await within(pendingStream.next())).done, true);
await within(disposing);
assert.equal(pendingRuntime.sessionRoots.size, 0);

// Disposal must reap descendants too, including one that ignores graceful POSIX termination.
const treeDir = mkdtempSync(join(tmpdir(), 'dero-hive-codex-tree-'));
const treeCommand = join(treeDir, 'tree-codex-acp.js');
const descendantPidPath = join(treeDir, 'descendant.pid');
writeFileSync(treeCommand, [
  "import { spawn } from 'node:child_process';",
  "import { writeFileSync } from 'node:fs';",
  `const descendant = spawn(process.execPath, ['-e', ${JSON.stringify("process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000);")}], { stdio: 'ignore', windowsHide: true });`,
  `writeFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid));`,
  `await import(${JSON.stringify(pathToFileURL(fakeCommand).href)});`
].join('\n'));
const treeAdapter = new CodexAcpAdapter({
  ...config,
  id: 'codex-tree',
  customHeaders: { commandPath: treeCommand }
});
let descendantPid: number | undefined;
try {
  await within(treeAdapter.testConnection(), 5_000);
  descendantPid = Number(readFileSync(descendantPidPath, 'utf8'));
  assert.equal(processExists(descendantPid), true);
  await within(treeAdapter.dispose(), 5_000);
  assert.equal(processExists(descendantPid), false, 'dispose must terminate the complete ACP process tree');
} finally {
  await within(treeAdapter.dispose(), 5_000).catch(() => {});
  if (descendantPid && processExists(descendantPid)) {
    try { process.kill(descendantPid, 'SIGKILL'); } catch { /* already gone */ }
  }
  rmSync(treeDir, { recursive: true, force: true });
}

// Asynchronous spawn failures settle cleanly and remain safe to dispose.
const missing = new CodexAcpAdapter({
  ...config,
  id: 'codex-missing',
  customHeaders: { commandPath: resolve('missing-codex-acp-executable') }
});
const missingProbe = await within(missing.testConnection());
assert.equal(missingProbe.ok, false);
assert.match(missingProbe.error || '', /ENOENT|not found/iu);
await within(missing.dispose());

console.log('codex ACP context tests passed');
