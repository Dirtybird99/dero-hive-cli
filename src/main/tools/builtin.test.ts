import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  BUILTIN_TOOLS,
  builtinExecutors,
  htmlToText,
  isBlockedUrl,
  isBlockedAddress,
  parseDuckDuckGoHtml,
  __setHostResolverForTest,
  __setShellProcessHooksForTest,
  __setWebFetchTimeoutForTest
} from './builtin.js';
import { setMediaManager } from '../media/instance.js';
import { setSimulatorManager } from '../simulator/instance.js';
import { setXswdManager } from '../xswd/instance.js';

const root = mkdtempSync(join(tmpdir(), 'dero-hive-tools-'));
const outside = mkdtempSync(join(tmpdir(), 'dero-hive-tools-outside-'));
const ctx = { cwd: root, conversationId: 'tool-test' };
const originalFetch = globalThis.fetch;

assert.equal(BUILTIN_TOOLS.length, 29);
assert.equal(new Set(BUILTIN_TOOLS.map(({ name }) => name)).size, BUILTIN_TOOLS.length);
assert.deepEqual(Object.keys(builtinExecutors).sort(), BUILTIN_TOOLS.map(({ name }) => name).sort());

try {
  let result = await builtinExecutors.write_file({ path: 'src/example.txt', content: 'alpha\nbeta\n' }, ctx);
  assert.equal(result.isError, undefined);
  assert.equal(readFileSync(join(root, 'src', 'example.txt'), 'utf8'), 'alpha\nbeta\n');

  result = await builtinExecutors.read_file({ path: 'src/example.txt', start_line: 2, end_line: 2 }, ctx);
  assert.equal(result.content, 'beta');
  assert.equal((await builtinExecutors.read_file({ path: 'src/example.txt', encoding: 'base64' }, ctx)).content, Buffer.from('alpha\nbeta\n').toString('base64'));

  result = await builtinExecutors.edit_file({ path: 'src/example.txt', old_text: 'beta', new_text: 'gamma' }, ctx);
  assert.equal(result.isError, undefined);
  assert.match(readFileSync(join(root, 'src', 'example.txt'), 'utf8'), /gamma/u);
  assert.equal((await builtinExecutors.edit_file({ path: 'src/example.txt', old_text: 'missing', new_text: 'x' }, ctx)).isError, true);

  assert.match((await builtinExecutors.list_directory({ path: 'src' }, ctx)).content, /example\.txt/u);
  assert.match((await builtinExecutors.glob_files({ pattern: '**/*.txt' }, ctx)).content, /src[\\/]example\.txt/u);
  assert.match((await builtinExecutors.grep_files({ pattern: 'gamma', include: '**/*.txt' }, ctx)).content, /example\.txt:2:gamma/u);
  const unsafeGrep = await builtinExecutors.grep_files({ pattern: '(a+)+$', include: '**/*.txt' }, ctx);
  assert.equal(unsafeGrep.isError, true);
  assert.match(unsafeGrep.content, /potentially unsafe/u);
  writeFileSync(join(root, 'ambiguous-regex.txt'), `${'a'.repeat(100_000)}!\n`);
  const regexAbort = new AbortController();
  setTimeout(() => regexAbort.abort(), 50);
  const regexStartedAt = Date.now();
  const cancelledGrep = await builtinExecutors.grep_files(
    { pattern: '^(a|aa)+$', include: 'ambiguous-regex.txt' },
    { ...ctx, signal: regexAbort.signal }
  );
  assert.equal(cancelledGrep.isError, true);
  assert.match(cancelledGrep.content, /cancelled/u);
  assert.ok(Date.now() - regexStartedAt < 2_000, 'catastrophic regex evaluation is isolated and promptly cancellable');
  writeFileSync(join(outside, 'private.txt'), 'AUDIT_SECRET_MARKER');
  symlinkSync(outside, join(root, 'linked-outside'), process.platform === 'win32' ? 'junction' : 'dir');
  const escapedGrep = await builtinExecutors.grep_files({ pattern: 'AUDIT_SECRET_MARKER', include: '**/*.txt' }, ctx);
  assert.doesNotMatch(escapedGrep.content, /AUDIT_SECRET_MARKER/u, 'grep must not follow a workspace link outside its root');
  const escapedGlob = await builtinExecutors.glob_files({ pattern: '**/*.txt' }, ctx);
  assert.doesNotMatch(escapedGlob.content, /linked-outside/u, 'glob must not enumerate through a workspace link');
  await assert.rejects(() => builtinExecutors.read_file({ path: '../outside.txt' }, ctx), /outside allowed workspace/u);

  // read_file: missing target reports an error result rather than throwing.
  const missingRead = await builtinExecutors.read_file({ path: 'does-not-exist.txt' }, ctx);
  assert.equal(missingRead.isError, true);
  assert.match(missingRead.content, /file not found/u);
  writeFileSync(join(root, 'oversized.bin'), Buffer.alloc(10 * 1024 * 1024 + 1));
  assert.equal((await builtinExecutors.read_file({ path: 'oversized.bin' }, ctx)).isError, true);
  assert.equal((await builtinExecutors.read_file({ path: 'oversized.bin', encoding: 'base64' }, ctx)).isError, true);
  assert.equal((await builtinExecutors.write_file({ path: 'too-large.txt', content: 'x'.repeat(5 * 1024 * 1024 + 1) }, ctx)).isError, true);
  assert.equal(existsSync(join(root, 'too-large.txt')), false);

  // edit_file: a non-unique old_text is rejected (must match exactly once).
  await builtinExecutors.write_file({ path: 'dup.txt', content: 'dup\ndup\n' }, ctx);
  const dupEdit = await builtinExecutors.edit_file({ path: 'dup.txt', old_text: 'dup', new_text: 'z' }, ctx);
  assert.equal(dupEdit.isError, true);
  assert.match(dupEdit.content, /matches 2 locations/u);
  // The rejected edit leaves the file untouched.
  assert.equal(readFileSync(join(root, 'dup.txt'), 'utf8'), 'dup\ndup\n');

  // Path-boundary rejection for write/edit/list — tools not covered above.
  await assert.rejects(() => builtinExecutors.write_file({ path: '../escape.txt', content: 'x' }, ctx), /outside allowed workspace/u);
  await assert.rejects(() => builtinExecutors.edit_file({ path: '../escape.txt', old_text: 'a', new_text: 'b' }, ctx), /outside allowed workspace/u);
  await assert.rejects(() => builtinExecutors.list_directory({ path: '../sneaky' }, ctx), /outside allowed workspace/u);

  result = await builtinExecutors.run_shell({ command: 'node -e "process.stdout.write(\'shell-ok\')"' }, ctx);
  assert.equal(result.content, 'shell-ok');

  // ---- run_shell: long-running process kill, exit codes, stderr, invalid input ----
  // run_shell has two kill paths for a long-running external process:
  // timeout_ms (pinned down here) and the optional ctx.signal AbortSignal
  // (pinned down in the cancellation section below).

  // timeout_ms terminates a long-running process promptly and reports an error.
  const sleepCommand = process.platform === 'win32' ? 'Start-Sleep -Seconds 10' : 'sleep 10';
  const timeoutStart = Date.now();
  const timedOut = await builtinExecutors.run_shell({ command: sleepCommand, timeout_ms: 1_000 }, ctx);
  const timeoutElapsed = Date.now() - timeoutStart;
  assert.equal(timedOut.isError, true);
  assert.match(timedOut.content, /^\[exit err\]/u);
  assert.ok(timeoutElapsed < 8_000, `timed-out run_shell settled in ${timeoutElapsed}ms; expected well under the 10s sleep`);

  // ---- run_shell: AbortSignal cancellation (ctx.signal) ----

  // An already-aborted signal settles immediately with the pre-spawn
  // cancellation result: no process is spawned, so the marker file the
  // command would have written must never appear.
  const preAborted = new AbortController();
  preAborted.abort();
  const preStart = Date.now();
  const preCancelled = await builtinExecutors.run_shell(
    { command: 'node -e "require(\'fs\').writeFileSync(\'abort-marker.txt\', \'ran\')"' },
    { ...ctx, signal: preAborted.signal }
  );
  assert.equal(preCancelled.isError, true);
  assert.match(preCancelled.content, /^\[cancelled\]/u);
  assert.match(preCancelled.content, /before it started/u);
  assert.ok(Date.now() - preStart < 2_000, 'pre-aborted run_shell must settle without running the command');
  assert.equal(existsSync(join(root, 'abort-marker.txt')), false);

  // Abort mid-run: the shell tree is killed promptly and cancellation is
  // reported long before the 10s sleep would finish.
  const cancelSleepCommand = process.platform === 'win32'
    ? 'Start-Sleep -Seconds 10'
    : 'node -e "setTimeout(()=>{},10000)"';
  const midAbort = new AbortController();
  setTimeout(() => midAbort.abort(), 50);
  const midStart = Date.now();
  const midCancelled = await builtinExecutors.run_shell(
    { command: cancelSleepCommand },
    { ...ctx, signal: midAbort.signal }
  );
  const midElapsed = Date.now() - midStart;
  assert.equal(midCancelled.isError, true);
  assert.match(midCancelled.content, /^\[cancelled\]/u);
  assert.ok(midElapsed < 8_000, `aborted run_shell settled in ${midElapsed}ms; expected well under the 10s sleep`);

  // A fresh, never-aborted signal changes nothing: success output is
  // identical to a signal-less run...
  const freshSignal = new AbortController().signal;
  const freshOk = await builtinExecutors.run_shell(
    { command: 'node -e "process.stdout.write(\'signal-ok\')"' },
    { ...ctx, signal: freshSignal }
  );
  assert.equal(freshOk.isError, undefined);
  assert.equal(freshOk.content, 'signal-ok');

  // ...and timeout_ms still kills a long runner exactly as it does without one.
  const freshTimeoutStart = Date.now();
  const freshTimedOut = await builtinExecutors.run_shell({ command: sleepCommand, timeout_ms: 1_000 }, { ...ctx, signal: freshSignal });
  assert.equal(freshTimedOut.isError, true);
  assert.match(freshTimedOut.content, /^\[exit err\]/u);
  assert.ok(Date.now() - freshTimeoutStart < 8_000, 'timeout with a fresh, never-aborted signal must still settle promptly');

  // Shell-level exit codes are captured verbatim ('exit 3' is valid in both
  // PowerShell and /bin/sh; a child process's nonzero exit is remapped by
  // PowerShell on Windows, so the shell-level form is the portable assertion).
  const exitCode = await builtinExecutors.run_shell({ command: 'exit 3' }, ctx);
  assert.equal(exitCode.isError, true);
  assert.match(exitCode.content, /^\[exit 3\]/u);

  // stderr is captured alongside stdout on success, stdout first.
  const withStderr = await builtinExecutors.run_shell({ command: 'node -e "console.error(\'warn-line\'); process.stdout.write(\'out-line\')"' }, ctx);
  assert.equal(withStderr.isError, undefined);
  assert.match(withStderr.content, /out-line[\s\S]*\[stderr\][\s\S]*warn-line/u);

  // stderr is also surfaced on failure (the exact code differs per shell:
  // PowerShell remaps a child's nonzero exit to 1, /bin/sh passes it through).
  const failStderr = await builtinExecutors.run_shell({ command: 'node -e "console.error(\'boom-detail\'); process.exit(2)"' }, ctx);
  assert.equal(failStderr.isError, true);
  assert.match(failStderr.content, /^\[exit \d+\]/u);
  assert.match(failStderr.content, /\[stderr\][\s\S]*boom-detail/u);

  // Missing command: no process is spawned and the invalid input comes back as
  // an error result (ERR_INVALID_ARG_TYPE), not a thrown exception.
  const noCommand = await builtinExecutors.run_shell({}, ctx);
  assert.equal(noCommand.isError, true);
  for (const timeout_ms of [-1, 0, 99, 300_001, 1.5, Number.NaN]) {
    const invalidTimeout = await builtinExecutors.run_shell({ command: 'exit 0', timeout_ms }, ctx);
    assert.equal(invalidTimeout.isError, true);
    assert.match(invalidTimeout.content, /timeout_ms/u);
  }
  assert.match(noCommand.content, /must be of type string/u);

  // A cwd escaping the workspace is rejected by path policy before any spawn.
  await assert.rejects(() => builtinExecutors.run_shell({ command: 'exit 0', cwd: '../outside' }, ctx), /outside allowed workspace/u);

  // Captured output is capped at 50 KB; a silent command reports '(no output)'.
  const bigOut = await builtinExecutors.run_shell({ command: 'node -e "process.stdout.write(\'x\'.repeat(60000))"' }, ctx);
  assert.equal(bigOut.isError, undefined);
  assert.equal(bigOut.content.length, 50_000);
  assert.equal((await builtinExecutors.run_shell({ command: 'node -e "0"' }, ctx)).content, '(no output)');

  // Timeout, abort, and output overflow must kill descendants as well as the
  // shell. The grandchild announces that it started, then writes a marker only
  // if it survives long enough to escape the tool call.
  const treeChild = 'tree-grandchild.cjs';
  const treeParent = 'tree-parent.cjs';
  writeFileSync(join(root, treeChild), `
const fs = require('node:fs');
fs.writeFileSync(process.argv[2], 'ready');
setTimeout(() => fs.writeFileSync(process.argv[3], 'escaped'), 2000);
setInterval(() => {}, 1000);
`);
  writeFileSync(join(root, treeParent), `
const { spawn } = require('node:child_process');
spawn(process.execPath, [${JSON.stringify(join(root, treeChild))}, process.argv[2], process.argv[3]], { stdio: 'ignore' });
if (process.argv[4] === 'spam') {
  setTimeout(() => {
    const chunk = 'x'.repeat(65536);
    const write = () => { while (process.stdout.write(chunk)) {} };
    process.stdout.on('drain', write);
    write();
  }, 200);
}
setInterval(() => {}, 1000);
`);

  const assertTreeStopped = async (
    name: string,
    run: (ready: string, marker: string) => Promise<{ content: string; isError?: boolean }>
  ): Promise<void> => {
    const ready = `tree-${name}-ready.txt`;
    const marker = `tree-${name}-marker.txt`;
    const treeResult = await run(ready, marker);
    assert.equal(treeResult.isError, true, `${name} should stop the command`);
    assert.ok(treeResult.content.length <= 50_000, `${name} output remains bounded`);
    // Leave enough time for output overflow to be observed through PowerShell
    // on a loaded Windows runner before testing whether the child escaped.
    await delay(2200);
    assert.equal(existsSync(join(root, ready)), true, `${name} fixture grandchild started`);
    assert.equal(existsSync(join(root, marker)), false, `${name} must kill the grandchild`);
  };

  await assertTreeStopped('timeout', (ready, marker) => builtinExecutors.run_shell(
    { command: `node ${treeParent} ${ready} ${marker}`, timeout_ms: 300 },
    ctx
  ));
  await assertTreeStopped('abort', async (ready, marker) => {
    const controller = new AbortController();
    const poll = setInterval(() => {
      if (existsSync(join(root, ready))) controller.abort();
    }, 10);
    const fallback = setTimeout(() => controller.abort(), 2_000);
    try {
      return await builtinExecutors.run_shell(
        { command: `node ${treeParent} ${ready} ${marker}` },
        { ...ctx, signal: controller.signal }
      );
    } finally {
      clearInterval(poll);
      clearTimeout(fallback);
    }
  });
  await assertTreeStopped('max-buffer', (ready, marker) => builtinExecutors.run_shell(
    { command: `node ${treeParent} ${ready} ${marker} spam` },
    ctx
  ));

  // A failed Windows taskkill is surfaced, and even a child that never emits
  // close cannot leave the tool promise pending forever.
  const fakeChild = (pid: number, kill: () => boolean = () => false): ChildProcess => Object.assign(new EventEmitter(), {
    pid,
    stdout: null,
    stderr: null,
    kill
  }) as ChildProcess;
  let fallbackKillAttempts = 0;
  try {
    __setShellProcessHooksForTest({
      platform: 'win32',
      closeGraceMs: 25,
      taskkillTimeoutMs: 25,
      spawnShell: () => fakeChild(424_242, () => { fallbackKillAttempts++; return false; }),
      spawnTaskkill: () => {
        const killer = fakeChild(424_243);
        queueMicrotask(() => killer.emit('close', 1, null));
        return killer;
      }
    });
    const failedTaskkillStart = Date.now();
    const failedTaskkill = await builtinExecutors.run_shell({ command: 'ignored', timeout_ms: 100 }, ctx);
    assert.equal(failedTaskkill.isError, true);
    assert.match(failedTaskkill.content, /taskkill failed.*exit 1/iu);
    assert.ok(fallbackKillAttempts > 0, 'failed taskkill attempts a direct-child fallback');
    assert.ok(Date.now() - failedTaskkillStart < 1_000, 'failed taskkill settles within the bounded grace period');

    __setShellProcessHooksForTest({
      platform: 'win32',
      closeGraceMs: 25,
      taskkillTimeoutMs: 25,
      spawnShell: () => fakeChild(424_244),
      spawnTaskkill: () => {
        const killer = fakeChild(424_245);
        queueMicrotask(() => killer.emit('close', 0, null));
        return killer;
      }
    });
    const missingCloseStart = Date.now();
    const missingClose = await builtinExecutors.run_shell({ command: 'ignored', timeout_ms: 100 }, ctx);
    assert.equal(missingClose.isError, true);
    assert.match(missingClose.content, /did not close within 25ms/iu);
    assert.ok(Date.now() - missingCloseStart < 1_000, 'missing child close cannot hang run_shell');
  } finally {
    __setShellProcessHooksForTest(null);
  }

  assert.match((await builtinExecutors.todo_write({ todos: [{ content: 'ship', status: 'completed' }] }, ctx)).content, /\[x\] ship/u);

  process.env.HIVE_SIMULATOR_RPC_URL = 'https://example.com/json_rpc';
  const unsafeSimulatorEndpoint = await builtinExecutors.get_simulator_chain_info({}, ctx);
  assert.equal(unsafeSimulatorEndpoint.isError, true);
  assert.match(unsafeSimulatorEndpoint.content, /numeric loopback/u);
  delete process.env.HIVE_SIMULATOR_RPC_URL;

  const contract = 'Function Initialize() Uint64\n10 STORE("owner", SIGNER())\n20 RETURN 0\nEnd Function';
  assert.match((await builtinExecutors.lint_dvm_basic({ source: contract }, ctx)).content, /function/u);
  assert.match((await builtinExecutors.generate_dvm_contract({ name: 'Vault', brief: 'Owner guarded vault' }, ctx)).content, /Vault/u);
  assert.match((await builtinExecutors.audit_dvm_contract({ source: contract, contractName: 'Vault' }, ctx)).content, /Security Audit/u);
  assert.match((await builtinExecutors.discover_contracts({ query: 'vault', kind: 'by-function' }, ctx)).content, /vault/u);

  // lint_dvm_basic: non-string source and oversized source are both rejected.
  const lintNonString = await builtinExecutors.lint_dvm_basic({ source: 12345 }, ctx);
  assert.equal(lintNonString.isError, true);
  assert.match(lintNonString.content, /must be a string/u);
  const lintOversized = await builtinExecutors.lint_dvm_basic({ source: 'x'.repeat(250_001) }, ctx);
  assert.equal(lintOversized.isError, true);
  assert.match(lintOversized.content, /250 KB analysis limit/u);

  // generate_dvm_contract: both name and brief are required.
  const dvmMissingBrief = await builtinExecutors.generate_dvm_contract({ name: 'Vault' }, ctx);
  assert.equal(dvmMissingBrief.isError, true);
  assert.match(dvmMissingBrief.content, /required/u);
  assert.equal((await builtinExecutors.generate_dvm_contract({ brief: 'no name given' }, ctx)).isError, true);
  assert.equal((await builtinExecutors.generate_dvm_contract({}, ctx)).isError, true);

  // audit_dvm_contract: whitespace-only source is treated as empty and rejected.
  const auditEmpty = await builtinExecutors.audit_dvm_contract({ source: '   ' }, ctx);
  assert.equal(auditEmpty.isError, true);
  assert.match(auditEmpty.content, /source is required/u);

  result = await builtinExecutors.generate_tela_dapp({ name: 'ToolTest', description: 'test dApp' }, ctx);
  assert.equal(result.isError, undefined);
  assert.match(readFileSync(join(root, 'tela', 'ToolTest', 'tela.config.json'), 'utf8'), /ToolTest/u);

  // generate_tela_dapp: a whitespace-only name is rejected before any file is written.
  const telaEmpty = await builtinExecutors.generate_tela_dapp({ name: '   ', description: 'x' }, ctx);
  assert.equal(telaEmpty.isError, true);
  assert.match(telaEmpty.content, /name is required/u);

  globalThis.fetch = async () => new Response(JSON.stringify({ result: {
    network: 'simulator', height: 12, topoheight: 11, tx_pool_size: 0, status: 'OK', version: 'test'
  } }), { status: 200, headers: { 'content-type': 'application/json' } });
  assert.match((await builtinExecutors.get_simulator_chain_info({}, ctx)).content, /simulator/u);

  globalThis.fetch = async () => new Response(JSON.stringify({ result: { padding: 'x'.repeat(1024 * 1024) } }), { status: 200 });
  const oversizedInfo = await builtinExecutors.get_simulator_chain_info({}, ctx);
  assert.equal(oversizedInfo.isError, true);
  assert.match(oversizedInfo.content, /exceeds 1 MB/u);

  // get_simulator_chain_info: RPC error body, non-OK HTTP, and transport failure.
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'sim boom' } }), { status: 200, headers: { 'content-type': 'application/json' } });
  const infoErr = await builtinExecutors.get_simulator_chain_info({}, ctx);
  assert.equal(infoErr.isError, true);
  assert.match(infoErr.content, /sim boom/u);
  globalThis.fetch = async () => new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } });
  const infoHttp = await builtinExecutors.get_simulator_chain_info({}, ctx);
  assert.equal(infoHttp.isError, true);
  assert.match(infoHttp.content, /HTTP 500/u);
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
  const infoThrow = await builtinExecutors.get_simulator_chain_info({}, ctx);
  assert.equal(infoThrow.isError, true);
  assert.match(infoThrow.content, /simulator unavailable/u);

  // Simulator tools with no manager registered (default null state) report unavailable.
  const noMgrWallet = await builtinExecutors.simulator_create_wallet({}, ctx);
  assert.equal(noMgrWallet.isError, true);
  assert.match(noMgrWallet.content, /not available/u);
  const noMgrBalance = await builtinExecutors.simulator_get_balance({ address: 'dero1x' }, ctx);
  assert.equal(noMgrBalance.isError, true);
  assert.match(noMgrBalance.content, /not available/u);
  const noMgrState = await builtinExecutors.simulator_get_contract_state({ scid: '0'.repeat(64) }, ctx);
  assert.equal(noMgrState.isError, true);
  assert.match(noMgrState.content, /not available/u);
  const noMgrHeight = await builtinExecutors.simulator_get_height({}, ctx);
  assert.equal(noMgrHeight.isError, true);
  assert.match(noMgrHeight.content, /not available/u);

  setSimulatorManager({
    async createFixtureWallet() { return { address: 'dero1test', scid: '0'.repeat(64) }; },
    async getBalance() { return { balance: 42 }; },
    async getContractState() { return { owner: 'dero1test' }; },
    async getHeight() { return 12; }
  } as never);
  assert.match((await builtinExecutors.simulator_create_wallet({}, ctx)).content, /dero1test/u);
  assert.match((await builtinExecutors.simulator_get_balance({ address: 'dero1test' }, ctx)).content, /42/u);
  assert.match((await builtinExecutors.simulator_get_contract_state({ scid: '0'.repeat(64), keys: 'owner' }, ctx)).content, /owner/u);
  assert.match((await builtinExecutors.simulator_get_height({}, ctx)).content, /12/u);

  // With a manager present, missing required fields are rejected past the mgr guard.
  const balNoAddr = await builtinExecutors.simulator_get_balance({}, ctx);
  assert.equal(balNoAddr.isError, true);
  assert.match(balNoAddr.content, /address is required/u);
  const stateNoScid = await builtinExecutors.simulator_get_contract_state({}, ctx);
  assert.equal(stateNoScid.isError, true);
  assert.match(stateNoScid.content, /scid is required/u);

  // Media manager is still null here: a real prompt hits the unavailable branch,
  // while an empty prompt/text is rejected before the manager is ever consulted.
  const mediaNoMgr = await builtinExecutors.generate_image({ prompt: 'hive' }, ctx);
  assert.equal(mediaNoMgr.isError, true);
  assert.match(mediaNoMgr.content, /unavailable in this session/u);
  const imgEmpty = await builtinExecutors.generate_image({ prompt: '' }, ctx);
  assert.equal(imgEmpty.isError, true);
  assert.match(imgEmpty.content, /non-empty prompt/u);
  assert.equal((await builtinExecutors.generate_audio({ text: '   ' }, ctx)).isError, true);
  assert.equal((await builtinExecutors.generate_video({ prompt: '' }, ctx)).isError, true);

  // dero_wallet_* — offline path first (no XSWD manager registered): every
  // executor must fail closed with the connect hint, never throw.
  for (const tool of ['dero_wallet_address', 'dero_wallet_balance', 'dero_wallet_height', 'dero_wallet_history'] as const) {
    const offline = await builtinExecutors[tool]({}, ctx);
    assert.equal(offline.isError, true);
    assert.match(offline.content, /XSWD wallet is not connected/u);
  }
  assert.match((await builtinExecutors.dero_wallet_transfer({ destination: 'dero1x', amount: 1 }, ctx)).content, /XSWD wallet is not connected/u);
  assert.match((await builtinExecutors.dero_wallet_scinvoke({ scid: '0'.repeat(64), entrypoint: 'Test' }, ctx)).content, /XSWD wallet is not connected/u);

  // Connected paths via a mocked manager (mirrors the simulator mock below).
  setXswdManager({
    status() { return { state: 'connected', url: 'ws://127.0.0.1:44326/xswd', appName: 'test', connectedAt: 1, error: null }; },
    async getAddress() { return 'dero1qytest'; },
    async getBalance() { return { balance: 500000, unlocked_balance: 400000 }; },
    async getHeight() { return 4242; },
    async getTransfers() { return { entries: [{ txid: 'a'.repeat(64), amount: 1 }] }; },
    async transfer() { return { txid: 'b'.repeat(64) }; },
    async scinvoke() { return { txid: 'c'.repeat(64) }; }
  } as never);
  assert.match((await builtinExecutors.dero_wallet_address({}, ctx)).content, /dero1qytest/u);
  assert.match((await builtinExecutors.dero_wallet_balance({}, ctx)).content, /4\.00000 DERO/u);
  assert.equal((await builtinExecutors.dero_wallet_balance({ scid: 'not-hex' }, ctx)).isError, true);
  assert.match((await builtinExecutors.dero_wallet_height({}, ctx)).content, /4242/u);
  assert.match((await builtinExecutors.dero_wallet_history({}, ctx)).content, /1 wallet transaction/u);
  assert.equal((await builtinExecutors.dero_wallet_transfer({ destination: 'dero1abc' }, ctx)).isError, true);
  assert.equal((await builtinExecutors.dero_wallet_transfer({ destination: 'dero1abc', amount: 1.5 }, ctx)).isError, true);
  assert.match((await builtinExecutors.dero_wallet_transfer({ destination: 'dero1abc', amount: 100 }, ctx)).content, new RegExp('b'.repeat(64), 'u'));
  assert.equal((await builtinExecutors.dero_wallet_scinvoke({ scid: 'short', entrypoint: 'X' }, ctx)).isError, true);
  assert.equal((await builtinExecutors.dero_wallet_scinvoke({ scid: '0'.repeat(64), entrypoint: 'X', parameters: [{ name: 'n', datatype: 'U', value: 'not-int' }] }, ctx)).isError, true);
  assert.match(
    (await builtinExecutors.dero_wallet_scinvoke({ scid: '0'.repeat(64), entrypoint: 'Transfer', parameters: [{ name: 'to', datatype: 'S', value: 'x' }] }, ctx)).content,
    new RegExp('c'.repeat(64), 'u')
  );
  setXswdManager(null);

  setMediaManager({
    autoPick(kind: string) { return { providerId: 'fake', model: `fake-${kind}` }; },
    async generate(request: { kind: string; prompt: string }) {
      return { id: `artifact-${request.kind}`, kind: request.kind, model: `fake-${request.kind}`, mimeType: `${request.kind}/test`, prompt: request.prompt };
    },
    async copyArtifactToProject(id: string) { return { ok: true, path: join(root, `${id}.bin`) }; }
  } as never);
  process.env.HIVE_CLI = '1';
  assert.match((await builtinExecutors.generate_image({ prompt: 'hive', aspect: 'landscape' }, ctx)).content, /saved/u);
  assert.match((await builtinExecutors.generate_audio({ text: 'hello', voice: 'alloy' }, ctx)).content, /saved/u);
  assert.match((await builtinExecutors.generate_video({ prompt: 'chain', duration_seconds: 5 }, ctx)).content, /saved/u);

  // No provider can service the request: autoPick returns null -> setup hint.
  setMediaManager({
    autoPick() { return null; },
    async generate() { throw new Error('should not be reached'); },
    async copyArtifactToProject() { return { ok: false }; }
  } as never);
  const noPick = await builtinExecutors.generate_image({ prompt: 'hive' }, ctx);
  assert.equal(noPick.isError, true);
  assert.match(noPick.content, /No image generator is configured/u);

  // Provider throws during generation -> failure is surfaced, not thrown.
  setMediaManager({
    autoPick(kind: string) { return { providerId: 'fake', model: `fake-${kind}` }; },
    async generate() { throw new Error('provider exploded'); },
    async copyArtifactToProject() { return { ok: false }; }
  } as never);
  const genThrow = await builtinExecutors.generate_audio({ text: 'hello' }, ctx);
  assert.equal(genThrow.isError, true);
  assert.match(genThrow.content, /Media generation failed/u);

  // ---- web tools: SSRF guard (pure, no network) ----
  // Blocked: localhost (incl. trailing dot), private/link-local/CGNAT/multicast/reserved/
  // broadcast/unspecified, cloud metadata, IPv4-mapped IPv6 (incl. the hex form Node emits
  // for ::ffff:127.0.0.1 and ::ffff:169.254.169.254), and non-http(s) schemes.
  for (const bad of [
    'http://localhost:8080', 'http://localhost./', 'http://127.0.0.1/', 'http://127.0.0.1./',
    'http://10.0.0.5/', 'http://192.168.1.1/', 'http://172.16.0.1/', 'http://100.64.0.1/',
    'http://169.254.169.254/latest', 'http://224.0.0.1/', 'http://240.0.0.1/',
    'http://255.255.255.255/', 'http://192.0.2.5/', 'http://[::1]/', 'http://[::]/',
    'http://[fe80::1]/', 'http://[fc00::1]/', 'http://[::ffff:7f00:1]/', 'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:a9fe:a9fe]/', 'ftp://example.com/', 'file:///etc/passwd', 'not a url'
  ]) {
    assert.equal(isBlockedUrl(bad).blocked, true, `expected ${bad} to be blocked`);
  }
  // Public hosts pass — including public IPv6 and IPv4-mapped-public (must not over-block).
  for (const ok of [
    'https://example.com/path', 'http://8.8.8.8/', 'http://93.184.216.34/',
    'http://[2606:4700:4700::1111]/', 'http://[2001:4860:4860::8888]/', 'http://[::ffff:8.8.8.8]/'
  ]) {
    assert.equal(isBlockedUrl(ok).blocked, false, `expected ${ok} to be allowed`);
  }
  // isBlockedAddress: the shared IP-classification core used by the guard and the DNS re-check.
  for (const bad of ['127.0.0.1', '10.0.0.5', '169.254.169.254', '224.0.0.1', '240.0.0.1', '255.255.255.255', '100.64.0.1', '::1', 'fe80::1', '::ffff:7f00:1', '::ffff:a9fe:a9fe']) {
    assert.equal(isBlockedAddress(bad), true, `expected address ${bad} blocked`);
  }
  for (const ok of ['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isBlockedAddress(ok), false, `expected address ${ok} allowed`);
  }

  // htmlToText drops script/style, decodes entities, and turns block/br boundaries into newlines.
  const sampleHtml = '<html><head><style>b{color:red}</style><script>evil()</script></head><body><h1>Title</h1><p>Hello &amp; welcome</p><div>Line1<br>Line2</div></body></html>';
  const asText = htmlToText(sampleHtml);
  assert.match(asText, /Title/u);
  assert.match(asText, /Hello & welcome/u);
  assert.match(asText, /Line1\nLine2/u);
  assert.doesNotMatch(asText, /evil\(\)/u);
  assert.doesNotMatch(asText, /color:red/u);

  // parseDuckDuckGoHtml extracts title/url/snippet and decodes the uddg redirect param.
  const ddgHtml = `
    <div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=x">First <b>Result</b></a>
    <a class="result__snippet" href="#">A snippet about the <b>first</b> result.</a></div>
    <div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fb">Second Result</a>
    <a class="result__snippet" href="#">Another snippet.</a></div>`;
  const parsed = parseDuckDuckGoHtml(ddgHtml);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].url, 'https://example.com/a');
  assert.equal(parsed[0].title, 'First Result');
  assert.match(parsed[0].snippet, /snippet about the first result/u);
  assert.equal(parsed[1].url, 'https://example.org/b');

  // web_fetch resolves DNS-name hosts before connecting; inject a public resolver so
  // these mocked-fetch cases never touch the real network.
  __setHostResolverForTest(async () => ['93.184.216.34']);

  // ---- web_fetch executor ----
  // Guard rejects blocked URLs and missing input before any fetch.
  const fetchBlocked = await builtinExecutors.web_fetch({ url: 'http://169.254.169.254/' }, ctx);
  assert.equal(fetchBlocked.isError, true);
  assert.match(fetchBlocked.content, /Refusing to fetch/u);
  assert.equal((await builtinExecutors.web_fetch({}, ctx)).isError, true);

  // Success: HTML body is reduced to text.
  globalThis.fetch = async () => new Response('<h1>Doc</h1><p>Body text.</p>', { status: 200, headers: { 'content-type': 'text/html' } });
  const fetchOk = await builtinExecutors.web_fetch({ url: 'https://example.com/' }, ctx);
  assert.equal(fetchOk.isError, undefined);
  assert.match(fetchOk.content, /Doc/u);
  assert.match(fetchOk.content, /Body text\./u);
  assert.doesNotMatch(fetchOk.content, /<h1>/u);

  // Non-text content is not dumped.
  globalThis.fetch = async () => new Response('binarydata', { status: 200, headers: { 'content-type': 'application/octet-stream' } });
  const fetchBinary = await builtinExecutors.web_fetch({ url: 'https://example.com/x.bin' }, ctx);
  assert.match(fetchBinary.content, /body omitted/u);

  // max_bytes truncates the returned body.
  globalThis.fetch = async () => new Response('x'.repeat(500), { status: 200, headers: { 'content-type': 'text/plain' } });
  const fetchTrunc = await builtinExecutors.web_fetch({ url: 'https://example.com/big', max_bytes: 100 }, ctx);
  assert.match(fetchTrunc.content, /truncated at 100 bytes/u);

  // Cancellation stays active after headers arrive and while the body stalls.
  globalThis.fetch = async (_url, init) => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      (init?.signal as AbortSignal | undefined)?.addEventListener('abort', () => {
        controller.error(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    }
  }), { status: 200, headers: { 'content-type': 'text/plain' } });
  const bodyAbort = new AbortController();
  const stalledBody = builtinExecutors.web_fetch(
    { url: 'https://example.com/stall' },
    { ...ctx, signal: bodyAbort.signal }
  );
  setTimeout(() => bodyAbort.abort(), 25);
  const cancelledBody = await stalledBody;
  assert.equal(cancelledBody.isError, true);
  assert.match(cancelledBody.content, /cancelled/u);

  // An endless response is read incrementally and cancelled as soon as the
  // byte limit is known to be exceeded; the full stream is never buffered.
  let bodyCancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array(64).fill(120)); },
    cancel() { bodyCancelled = true; }
  }), { status: 200, headers: { 'content-type': 'text/plain' } });
  const cappedBody = await builtinExecutors.web_fetch({ url: 'https://example.com/endless', max_bytes: 100 }, ctx);
  assert.match(cappedBody.content, /truncated at 100 bytes/u);
  assert.equal(cappedBody.meta?.bytes, 100);
  assert.equal(bodyCancelled, true);

  // ---- web_search executor (keyless DuckDuckGo fallback) ----
  delete process.env.HIVE_SEARCH_API_KEY;
  globalThis.fetch = async () => new Response(ddgHtml, { status: 200, headers: { 'content-type': 'text/html' } });
  const searchOk = await builtinExecutors.web_search({ query: 'dero hive', count: 2 }, ctx);
  assert.equal(searchOk.isError, undefined);
  assert.match(searchOk.content, /example\.com\/a/u);
  assert.equal((searchOk.meta?.results as unknown[])?.length, 2);

  // Search responses are capped while streaming instead of being handed to
  // unbounded Response.text()/json() helpers.
  let oversizedSearchCancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(1_000_001).fill(120)); },
    cancel() { oversizedSearchCancelled = true; }
  }), { status: 200, headers: { 'content-type': 'text/html' } });
  const oversizedSearch = await builtinExecutors.web_search({ query: 'oversized' }, ctx);
  assert.equal(oversizedSearch.isError, true);
  assert.match(oversizedSearch.content, /response exceeded 1000000 bytes/iu);
  assert.equal(oversizedSearchCancelled, true);

  // The request deadline remains armed after headers and aborts a stalled body.
  let stalledSearchCancelled = false;
  __setWebFetchTimeoutForTest(30);
  try {
    globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
      cancel() { stalledSearchCancelled = true; }
    }), { status: 200, headers: { 'content-type': 'text/html' } });
    const stalledSearchStart = Date.now();
    const timedOutSearch = await builtinExecutors.web_search({ query: 'stalled' }, ctx);
    assert.equal(timedOutSearch.isError, true);
    assert.match(timedOutSearch.content, /timed out after 30ms/iu);
    assert.equal(stalledSearchCancelled, true);
    assert.ok(Date.now() - stalledSearchStart < 1_000, 'stalled search body obeys the request deadline');
  } finally {
    __setWebFetchTimeoutForTest(null);
  }
  // Missing query is rejected.
  assert.equal((await builtinExecutors.web_search({}, ctx)).isError, true);

  // ---- web_fetch: DNS-rebinding re-check at fetch time ----
  // A hostname that passes the string guard but RESOLVES to a loopback/private
  // address is rejected before any connection (the string guard can't resolve DNS).
  __setHostResolverForTest(async () => ['127.0.0.1']);
  globalThis.fetch = async () => new Response('should not be reached', { status: 200, headers: { 'content-type': 'text/html' } });
  const rebind = await builtinExecutors.web_fetch({ url: 'https://rebind.evil.example/' }, ctx);
  assert.equal(rebind.isError, true);
  assert.match(rebind.content, /non-public address/u);
} finally {
  globalThis.fetch = originalFetch;
  __setHostResolverForTest(null);
  __setShellProcessHooksForTest(null);
  __setWebFetchTimeoutForTest(null);
  setMediaManager(null);
  setSimulatorManager(null);
  setXswdManager(null);
  delete process.env.HIVE_CLI;
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
}
