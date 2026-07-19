import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { evaluatePreToolUse, evaluatePostToolUse } from './dispatcher.js';
import type { HookDefinition } from './types.js';

// Node one-liners keep hook commands cross-platform (node is always present).
const NODE = process.execPath;
const q = (s: string): string => `"${s}"`; // node path may contain spaces on Windows
const runNode = (body: string): string => `${q(NODE)} -e "${body}"`;

const root = mkdtempSync(join(tmpdir(), 'dero-hive-hooks-'));

try {
  // No matching hooks → never blocks.
  assert.deepEqual(await evaluatePreToolUse([], 'run_shell', {}), { block: false });

  // Exit-code convention: exit 0 = allow, non-zero = deny.
  const allowHook: HookDefinition = { event: 'preToolUse', command: runNode('process.exit(0)') };
  const denyHook: HookDefinition = { event: 'preToolUse', command: runNode('process.exit(1)') };
  assert.equal((await evaluatePreToolUse([allowHook], 'run_shell', {})).block, false);
  assert.equal((await evaluatePreToolUse([denyHook], 'run_shell', {})).block, true);

  // JSON stdout wins over exit code, and carries feedback.
  const jsonDeny: HookDefinition = {
    event: 'preToolUse',
    command: runNode("console.log(JSON.stringify({decision:'deny',feedback:'not allowed here'}))")
  };
  const jsonResult = await evaluatePreToolUse([jsonDeny], 'run_shell', {});
  assert.equal(jsonResult.block, true);
  assert.equal(jsonResult.feedback, 'not allowed here');

  // toolPattern filters which tools a hook applies to (substring + regex).
  const scoped: HookDefinition = { event: 'preToolUse', toolPattern: 'write_file', command: runNode('process.exit(1)') };
  assert.equal((await evaluatePreToolUse([scoped], 'read_file', {})).block, false, 'non-matching tool must be unaffected');
  assert.equal((await evaluatePreToolUse([scoped], 'write_file', {})).block, true, 'matching tool must be gated');
  const regexHook: HookDefinition = { event: 'preToolUse', toolPattern: '/^dero_wallet_/', command: runNode('process.exit(1)') };
  assert.equal((await evaluatePreToolUse([regexHook], 'dero_wallet_transfer', {})).block, true);
  assert.equal((await evaluatePreToolUse([regexHook], 'run_shell', {})).block, false);

  // A slow hook that exceeds its timeout: fail-open by default, fail-closed when blocking.
  const slow = runNode('setTimeout(function(){},4000)');
  const slowOpen: HookDefinition = { event: 'preToolUse', command: slow, timeoutMs: 400 };
  const slowClosed: HookDefinition = { event: 'preToolUse', command: slow, timeoutMs: 400, blocking: true };
  const openStart = Date.now();
  assert.equal((await evaluatePreToolUse([slowOpen], 'run_shell', {})).block, false, 'timed-out non-blocking hook must fail open');
  assert.ok(Date.now() - openStart < 5_000, 'timed-out hook must settle at its timeout, not hang');
  assert.equal((await evaluatePreToolUse([slowClosed], 'run_shell', {})).block, true, 'timed-out blocking hook must fail closed');

  // Timeout terminates the shell's descendants, not only the shell process.
  const descendantScript = join(root, 'descendant.cjs');
  const parentScript = join(root, 'parent.cjs');
  const descendantReady = join(root, 'descendant-ready.txt');
  const descendantMarker = join(root, 'descendant-escaped.txt');
  writeFileSync(descendantScript, `
const fs = require('node:fs');
setTimeout(() => fs.writeFileSync(process.argv[2], 'escaped'), 1500);
`);
  writeFileSync(parentScript, `
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, [process.argv[2], process.argv[3]], { stdio: 'ignore' });
fs.writeFileSync(process.argv[4], String(child.pid));
setTimeout(() => {}, 4000);
`);
  const descendantHook: HookDefinition = {
    event: 'preToolUse',
    command: `${q(NODE)} ${q(parentScript)} ${q(descendantScript)} ${q(descendantMarker)} ${q(descendantReady)}`,
    timeoutMs: 500,
    blocking: true
  };
  assert.equal((await evaluatePreToolUse([descendantHook], 'run_shell', {})).block, true);
  assert.equal(existsSync(descendantReady), true, 'hook descendant was running before the timeout');
  await delay(1_800);
  assert.equal(existsSync(descendantMarker), false, 'timed-out hook must terminate its descendant tree');

  // Hook output is capped and overflow terminates the producer promptly.
  const oversizedHook: HookDefinition = {
    event: 'preToolUse',
    command: runNode("process.stdout.write('x'.repeat(300000));setTimeout(function(){},4000)"),
    timeoutMs: 4_000,
    blocking: true
  };
  const oversizedStart = Date.now();
  const oversized = await evaluatePreToolUse([oversizedHook], 'run_shell', {});
  assert.equal(oversized.block, true);
  assert.match(oversized.feedback || '', /output exceeded 262144 bytes/u);
  assert.ok(Date.now() - oversizedStart < 3_000, 'oversized hook output is stopped before its normal timeout');

  // The first denying hook short-circuits (the second, which would write a marker, must not run).
  const marker = join(root, 'should-not-exist.txt');
  const shortCircuit: HookDefinition[] = [
    { event: 'preToolUse', command: runNode('process.exit(1)') },
    { event: 'preToolUse', command: `${q(NODE)} -e "require('fs').writeFileSync(process.env.HOOK_MARKER,'ran')"` }
  ];
  process.env.HOOK_MARKER = marker;
  assert.equal((await evaluatePreToolUse(shortCircuit, 'run_shell', {})).block, true);
  assert.equal(existsSync(marker), false, 'a hook after the first deny must not execute');

  // postToolUse is observational: it runs but never affects control flow. Prove it ran by side effect.
  const postMarker = join(root, 'post-ran.txt');
  process.env.HOOK_MARKER = postMarker;
  const postHook: HookDefinition = {
    event: 'postToolUse',
    command: `${q(NODE)} -e "require('fs').writeFileSync(process.env.HOOK_MARKER,'ran')"`
  };
  await evaluatePostToolUse([postHook], 'run_shell', {}, { content: 'ok', isError: false });
  assert.equal(existsSync(postMarker), true, 'postToolUse hook must run');

  // A postToolUse hook only fires for its matching event, not preToolUse-only lists.
  const preOnly: HookDefinition = { event: 'preToolUse', command: runNode('process.exit(1)') };
  await evaluatePostToolUse([preOnly], 'run_shell', {}, { content: 'ok' }); // must not throw / must be a no-op

  console.log('dispatcher.test.ts: hooks ok');
} finally {
  delete process.env.HOOK_MARKER;
  rmSync(root, { recursive: true, force: true });
}
