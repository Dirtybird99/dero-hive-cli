import React from 'react';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { render } from 'ink';

const dataDir = mkdtempSync(join(tmpdir(), 'dero-hive-tui-'));
const alternateWorkspace = mkdtempSync(join(tmpdir(), 'dero-hive-tui-workspace-b-'));
const relativeWorkspace = join(alternateWorkspace, 'relative-child');
mkdirSync(relativeWorkspace);
process.env.HIVE_DATA_DIR = dataDir;
process.env.HIVE_APP_ROOT = resolve('.');
process.env.HIVE_RESOURCES = resolve('resources');
process.env.HIVE_CLI = '1';
process.env.HIVE_TUI = '1';
process.env.HIVE_REDUCED_MOTION = '1';

const stdout = new PassThrough() as PassThrough & NodeJS.WriteStream;
const stdin = new PassThrough() as PassThrough & NodeJS.ReadStream & {
  setRawMode: (enabled: boolean) => NodeJS.ReadStream;
  ref: () => NodeJS.ReadStream;
  unref: () => NodeJS.ReadStream;
};
Object.assign(stdout, { columns: 100, rows: 30, isTTY: true });
Object.assign(stdin, {
  isTTY: true,
  setRawMode() { return stdin; },
  ref() { return stdin; },
  unref() { return stdin; }
});
let output = '';
stdout.on('data', (chunk) => { output += chunk.toString(); });

const { initHive, shutdownHive } = await import('../utils/init.js');
const { App } = await import('./App.js');
const { CommandMenu, ComposerInput, StatusBar, Welcome, glimmerLevel, isAltKey } = await import('./components.js');
const { resolveTheme } = await import('./themes.js');

let composerValue = 'z';
let composerSubmits = 0;
assert.equal(glimmerLevel(0, 1), 2, 'the glimmer head should light the current logo column');

// Alt+<letter> detection: Ink meta flag, CSI-u, and legacy escape forms all match;
// Ctrl combinations and other letters must not.
assert.equal(isAltKey('x', { meta: true }, 'x'), true, 'meta+x is Alt+X');
assert.equal(isAltKey('X', { meta: true }, 'x'), true, 'meta is case-insensitive');
assert.equal(isAltKey('[120;3u', {}, 'x'), true, 'CSI-u Alt+X escape matches');
assert.equal(isAltKey('[27;3;120~', {}, 'x'), true, 'legacy Alt+X escape matches');
assert.equal(isAltKey('x', { meta: true, ctrl: true }, 'x'), false, 'ctrl+meta is not Alt');
assert.equal(isAltKey('y', { meta: true }, 'x'), false, 'other letters do not match');
assert.equal(isAltKey('x', {}, 'x'), false, 'bare letter is not Alt');
assert.equal(glimmerLevel(0, 2), 1, 'the glimmer should leave a one-column trail');
assert.equal(glimmerLevel(0, 10), 0, 'the logo should rest between sweeps');
assert.equal(glimmerLevel(6, 7), 2, 'the glimmer sweep should reach the final logo column');
assert.equal(glimmerLevel(0, 27), 2, 'the glimmer should repeat after its 26-frame cycle');

const animationStdout = new PassThrough() as PassThrough & NodeJS.WriteStream;
Object.assign(animationStdout, { columns: 100, rows: 20, isTTY: true });
let animationOutput = '';
animationStdout.on('data', (chunk) => { animationOutput += chunk.toString(); });
delete process.env.HIVE_REDUCED_MOTION;
const animatedLogo = render(React.createElement(Welcome, {
  theme: resolveTheme('dark'),
  width: 100,
  workspace: resolve('.'),
  selected: 0
}), { stdout: animationStdout, stdin, debug: true, patchConsole: false });
const animatedLogoExited = animatedLogo.waitUntilExit();
for (let attempt = 0; attempt < 100 && !/✦/.test(animationOutput); attempt += 1) {
  await new Promise((resolveWait) => setTimeout(resolveWait, 20));
}
assert.match(animationOutput, /✦/, 'the live Hive mark should emit a moving glimmer head');
animatedLogo.unmount();
await animatedLogoExited;
process.env.HIVE_REDUCED_MOTION = '1';

function ComposerProbe({ initial = 'z', multiline = false }: { initial?: string; multiline?: boolean }): JSX.Element {
  const [value, setValue] = React.useState(initial);
  composerValue = value;
  return React.createElement(ComposerInput, {
    value,
    onChange: setValue,
    onSubmit() { composerSubmits += 1; },
    focus: true,
    multiline
  });
}

let scopedComposerValue = 'abc';
function ScopedComposerProbe({ scope }: { scope: 'composer' | 'overlay' }): JSX.Element {
  const [composer, setComposer] = React.useState('abc');
  const [overlay, setOverlay] = React.useState('');
  scopedComposerValue = composer;
  return React.createElement(ComposerInput, {
    value: scope === 'composer' ? composer : overlay,
    onChange: scope === 'composer' ? setComposer : setOverlay,
    onSubmit() {},
    focus: true,
    inputKey: scope
  });
}

const secretStdout = new PassThrough() as PassThrough & NodeJS.WriteStream;
Object.assign(secretStdout, { columns: 40, rows: 4, isTTY: true });
let secretOutput = '';
secretStdout.on('data', (chunk) => { secretOutput += chunk.toString(); });
const secretComposer = render(React.createElement(ComposerInput, {
  value: 'never-print-this', onChange() {}, onSubmit() {}, focus: false, masked: true
}), { stdout: secretStdout, stdin, debug: true, patchConsole: false });
const secretExited = secretComposer.waitUntilExit();
await new Promise((resolveWait) => setTimeout(resolveWait, 20));
assert.doesNotMatch(secretOutput, /never-print-this/);
assert.match(secretOutput, /•+/);
secretComposer.unmount();
await secretExited;

try {
  const hive = await initHive();
  const instance = render(React.createElement(App, { options: { cwd: resolve('.') } }), {
    stdin,
    stdout,
    stderr: process.stderr,
    exitOnCtrlC: false,
    debug: true,
    patchConsole: false
  });
  const exited = instance.waitUntilExit();
  const escape = String.fromCharCode(27);
  for (let attempt = 0; attempt < 100 && (!/DERO Hive/.test(output) || !output.includes(`${escape}]10;#e1e1e1`)); attempt += 1) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  if (!/DERO Hive/.test(output)) process.stderr.write(output);
  assert.match(output, /DERO Hive/);
  assert.match(output, /New worktree/);
  assert.match(output, /Resume session/);
  assert.match(output, /Connect model/);
  assert.match(output, /Changelog/);
  assert.match(output, /Quit/);
  assert.match(output, /ctrl\+s/);
  assert.match(output, /ctrl\+x/);
  assert.doesNotMatch(output, /✦/, 'reduced motion must keep the logo static');
  const ansiCsi = new RegExp(`${escape}\\[[0-?]*[ -/]*[@-~]`, 'g');
  assert.ok(output.includes(`${escape}]10;#e1e1e1`));
  assert.ok(output.includes(`${escape}]11;#141414`));
  assert.match(output, /No provider is configured|no provider/i);

  output = '';
  const firstPermission = hive.tools.requestPermission({
    requestId: 'fifo-first', toolName: 'first_tool', args: { marker: 'first' }
  }, { cwd: resolve('.'), conversationId: 'fifo-test' });
  const secondPermission = hive.tools.requestPermission({
    requestId: 'fifo-second', toolName: 'second_tool', args: { marker: 'second' }
  }, { cwd: resolve('.'), conversationId: 'fifo-test' });
  await new Promise((resolveWait) => setTimeout(resolveWait, 80));
  assert.match(output.replace(ansiCsi, ''), /Permission required · first_tool/);
  stdin.write('a');
  await new Promise((resolveWait) => setTimeout(resolveWait, 80));
  assert.equal(await firstPermission, true);
  assert.match(output.replace(ansiCsi, ''), /Permission required · second_tool/);
  stdin.write('d');
  assert.equal(await secondPermission, false, 'permission prompts resolve in FIFO order without overwriting');
  await new Promise((resolveWait) => setTimeout(resolveWait, 80));

  output = '';
  stdin.write('\u001b[A');
  await new Promise((resolveWait) => setTimeout(resolveWait, 80));
  assert.match(output.replace(ansiCsi, ''), /❯ Quit/);
  output = '';
  stdin.write('\u001b[B');
  await new Promise((resolveWait) => setTimeout(resolveWait, 80));
  assert.match(output.replace(ansiCsi, ''), /❯ New worktree/);

  output = '';
  stdin.write('\u001b[<35;40;11M');
  await new Promise((resolveWait) => setTimeout(resolveWait, 80));
  assert.match(output.replace(ansiCsi, ''), /❯ Resume session/);
  output = '';
  stdin.write('\u001b[<0;40;11M');
  await new Promise((resolveWait) => setTimeout(resolveWait, 80));
  assert.match(output.replace(ansiCsi, ''), /Resume conversation/);
  stdin.write('\u001b');
  await new Promise((resolveWait) => setTimeout(resolveWait, 60));

  output = '';
  stdin.write('\u001b[A');
  await new Promise((resolveWait) => setTimeout(resolveWait, 80));
  assert.match(output.replace(ansiCsi, ''), /❯ New worktree/);
  output = '';
  stdin.write('\u001b[B');
  await new Promise((resolveWait) => setTimeout(resolveWait, 80));
  assert.match(output.replace(ansiCsi, ''), /❯ Resume session/);
  stdin.write('\u001b[A');
  await new Promise((resolveWait) => setTimeout(resolveWait, 60));

  output = '';
  stdin.write('\u0018');
  await new Promise((resolveWait) => setTimeout(resolveWait, 80));
  const shortcuts = output.replace(ansiCsi, '');
  assert.match(shortcuts, /Keyboard shortcuts/);
  assert.match(shortcuts, /Essentials \/ Send prompt/);
  output = '';
  stdin.write('\u001b[A');
  await new Promise((resolveWait) => setTimeout(resolveWait, 80));
  assert.match(output.replace(ansiCsi, ''), /❯ › Dashboard \(1\)/);
  output = '';
  stdin.write('\u001b[B');
  await new Promise((resolveWait) => setTimeout(resolveWait, 80));
  assert.match(output.replace(ansiCsi, ''), /❯ ▾ Essentials \(6\)/);
  output = '';
  stdin.write('\u001b[<65;2;2M');
  await new Promise((resolveWait) => setTimeout(resolveWait, 80));
  assert.match(output.replace(ansiCsi, ''), /❯ Essentials \/ Send prompt/);
  stdin.write('\u001b');
  await new Promise((resolveWait) => setTimeout(resolveWait, 60));

  output = '';
  stdin.write('\u001bOQ');
  await new Promise((resolveWait) => setTimeout(resolveWait, 80));
  assert.match(output.replace(ansiCsi, ''), /Settings/);
  assert.match(output.replace(ansiCsi, ''), /Providers/);
  output = '';
  stdin.write('\r');
  await new Promise((resolveWait) => setTimeout(resolveWait, 80));
  assert.match(output.replace(ansiCsi, ''), /Connect provider/);
  output = '';
  stdin.write('\r');
  await new Promise((resolveWait) => setTimeout(resolveWait, 80));
  assert.match(output.replace(ansiCsi, ''), /OpenCode Zen/);
  output = '';
  for (const character of 'codex') stdin.write(character);
  await new Promise((resolveWait) => setTimeout(resolveWait, 80));
  assert.match(output.replace(ansiCsi, ''), /Codex \(ChatGPT\).*browser sign-in/i);
  stdin.write('\u001b');
  await new Promise((resolveWait) => setTimeout(resolveWait, 60));

  for (const mode of ['Plan', 'Auto', 'Always-Approve', 'Normal']) {
    output = '';
    stdin.write('\u001b[Z');
    await new Promise((resolveWait) => setTimeout(resolveWait, 70));
    assert.match(output.replace(ansiCsi, ''), new RegExp(`Switched to mode: ${mode}`));
  }

  output = '';
  stdin.write('\u0010');
  await new Promise((resolveWait) => setTimeout(resolveWait, 80));
  const commandPalette = output.replace(ansiCsi, '');
  assert.match(commandPalette, /› \/commands/);
  assert.doesNotMatch(commandPalette, /system \/ \/commands/);
  output = '';
  stdin.write('\u001b[B');
  await new Promise((resolveWait) => setTimeout(resolveWait, 80));
  stdin.write('\r');
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  assert.match(output.replace(ansiCsi, ''), /Usage: \/shortcuts/);

  output = '';
  stdin.write('\u0010');
  await new Promise((resolveWait) => setTimeout(resolveWait, 80));
  stdin.write('\u001b[B');
  await new Promise((resolveWait) => setTimeout(resolveWait, 80));
  stdin.write('\u001b[A');
  await new Promise((resolveWait) => setTimeout(resolveWait, 80));
  stdin.write('\r');
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  assert.match(output.replace(ansiCsi, ''), /Usage: \/commands/);

  output = '';
  stdin.write('/');
  await new Promise((resolveWait) => setTimeout(resolveWait, 80));
  const slashMenu = output.replace(ansiCsi, '');
  assert.match(slashMenu, /› \/commands/);
  stdin.write('\u001b');
  await new Promise((resolveWait) => setTimeout(resolveWait, 60));

  output = '';
  for (const character of '/definitely-missing') stdin.write(character);
  await new Promise((resolveWait) => setTimeout(resolveWait, 80));
  assert.match(output.replace(ansiCsi, ''), /No commands match your search/);
  stdin.write('\u001b');
  await new Promise((resolveWait) => setTimeout(resolveWait, 60));

  output = '';
  for (const character of '/mo') stdin.write(character);
  await new Promise((resolveWait) => setTimeout(resolveWait, 80));
  stdin.write('\t');
  await new Promise((resolveWait) => setTimeout(resolveWait, 80));
  assert.match(output.replace(ansiCsi, ''), /\/model /);
  stdin.write('\u0003');
  await new Promise((resolveWait) => setTimeout(resolveWait, 60));

  output = '';
  for (const character of '/commands new') stdin.write(character);
  await new Promise((resolveWait) => setTimeout(resolveWait, 80));
  stdin.write('\r');
  await new Promise((resolveWait) => setTimeout(resolveWait, 120));
  const commandDetail = output.replace(ansiCsi, '');
  assert.match(commandDetail, /\/new/);
  assert.match(commandDetail, /Usage: \/new/);
  assert.match(commandDetail, /Aliases: \/clear, \/chat/);

  output = '';
  for (const character of '/commands clear') stdin.write(character);
  await new Promise((resolveWait) => setTimeout(resolveWait, 80));
  stdin.write('\r');
  await new Promise((resolveWait) => setTimeout(resolveWait, 120));
  assert.match(output.replace(ansiCsi, ''), /Usage: \/new/);

  output = '';
  for (const character of '/review') stdin.write(character);
  await new Promise((resolveWait) => setTimeout(resolveWait, 80));
  stdin.write('\r');
  await new Promise((resolveWait) => setTimeout(resolveWait, 120));
  assert.match(output.replace(ansiCsi, ''), /No provider\/model is selected/);

  for (const character of '/attach README.md') stdin.write(character);
  await new Promise((resolveWait) => setTimeout(resolveWait, 80));
  stdin.write('\r');
  await new Promise((resolveWait) => setTimeout(resolveWait, 120));
  assert.match(output, /attachments.*README\.md/i);

  for (const character of '/extensions') stdin.write(character);
  await new Promise((resolveWait) => setTimeout(resolveWait, 80));
  output = '';
  stdin.write('\r');
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  const extensions = output.replace(ansiCsi, '');
  assert.match(extensions, /Extensions/);
  assert.match(extensions, /extension \/ Skills/);
  assert.match(extensions, /extension \/ MCP servers/);
  stdin.write('\u001b');
  await new Promise((resolveWait) => setTimeout(resolveWait, 60));

  output = '';
  for (const character of '/mcp') stdin.write(character);
  await new Promise((resolveWait) => setTimeout(resolveWait, 80));
  stdin.write('\r');
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  const mcp = output.replace(ansiCsi, '');
  assert.match(mcp, /MCP servers/);
  assert.match(mcp, /available \/ DERO MCP server/);
  assert.match(mcp, /32 read-only tools/);
  stdin.write('\u001b');
  await new Promise((resolveWait) => setTimeout(resolveWait, 60));

  for (const character of '/minimal') stdin.write(character);
  await new Promise((resolveWait) => setTimeout(resolveWait, 80));
  output = '';
  stdin.write('\r');
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  assert.match(output.replace(ansiCsi, ''), /Minimal view enabled\. Use \/fullscreen to restore the full chrome\./);

  for (const character of '/fullscreen') stdin.write(character);
  await new Promise((resolveWait) => setTimeout(resolveWait, 80));
  output = '';
  stdin.write('\r');
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  assert.match(output.replace(ansiCsi, ''), /Fullscreen view enabled\./);

  for (const character of 'history-draft') stdin.write(character);
  await new Promise((resolveWait) => setTimeout(resolveWait, 60));
  output = '';
  stdin.write('\u0012');
  await new Promise((resolveWait) => setTimeout(resolveWait, 80));
  assert.match(output.replace(ansiCsi, ''), /Prompt history/);
  output = '';
  stdin.write('\u001b');
  await new Promise((resolveWait) => setTimeout(resolveWait, 60));
  assert.match(output.replace(ansiCsi, ''), /history-draft/);
  stdin.write('\u0001');
  await new Promise((resolveWait) => setTimeout(resolveWait, 40));
  stdin.write('\u001b[3~');
  await new Promise((resolveWait) => setTimeout(resolveWait, 60));

  for (const character of 'session-draft') stdin.write(character);
  await new Promise((resolveWait) => setTimeout(resolveWait, 60));
  output = '';
  stdin.write('\u0013');
  await new Promise((resolveWait) => setTimeout(resolveWait, 80));
  assert.match(output.replace(ansiCsi, ''), /Resume conversation/);
  output = '';
  stdin.write('\u001b');
  await new Promise((resolveWait) => setTimeout(resolveWait, 60));
  assert.match(output.replace(ansiCsi, ''), /session-draft/);
  output = '';
  stdin.write('\u001b[A');
  await new Promise((resolveWait) => setTimeout(resolveWait, 80));
  stdin.write('\u001b[B');
  await new Promise((resolveWait) => setTimeout(resolveWait, 80));
  assert.match(output.replace(ansiCsi, ''), /session-draft/);

  // Bang-shell commands share the active AbortController. Unmounting the TUI
  // must cancel the shell's whole process tree, not just its immediate parent.
  const shellChild = join(dataDir, 'tui-shell-child.cjs');
  const shellParent = join(dataDir, 'tui-shell-parent.cjs');
  const shellReady = join(dataDir, 'tui-shell-ready.txt');
  const shellMarker = join(dataDir, 'tui-shell-delayed-marker.txt');
  writeFileSync(shellChild, `
const fs = require('node:fs');
fs.writeFileSync(process.argv[2], 'ready');
setTimeout(() => fs.writeFileSync(process.argv[3], 'escaped'), 1200);
setInterval(() => {}, 1000);
`);
  writeFileSync(shellParent, `
const { spawn } = require('node:child_process');
spawn(process.execPath, [${JSON.stringify(shellChild)}, process.argv[2], process.argv[3]], { stdio: 'ignore' });
setInterval(() => {}, 1000);
`);
  stdin.write('\u0001');
  await new Promise((resolveWait) => setTimeout(resolveWait, 40));
  stdin.write('\u001b[3~');
  await new Promise((resolveWait) => setTimeout(resolveWait, 60));
  const bangCommand = `!node "${shellParent}" "${shellReady}" "${shellMarker}"`;
  for (const character of bangCommand) stdin.write(character);
  await new Promise((resolveWait) => setTimeout(resolveWait, 60));
  stdin.write('\r');
  for (let attempt = 0; attempt < 200 && !existsSync(shellReady); attempt += 1) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  assert.equal(existsSync(shellReady), true, 'bang-shell descendant fixture must start before cancellation');
  instance.unmount();
  await exited;
  await new Promise((resolveWait) => setTimeout(resolveWait, 1500));
  assert.equal(existsSync(shellMarker), false, 'unmount must kill bang-shell descendants before delayed work runs');

  const conversations = await import('../services/conversation.js');
  const seeded = conversations.createConversation({
    title: 'Seeded parity session', providerId: 'test', model: 'test-model', workspacePath: resolve('.')
  });
  conversations.persistMessage(seeded.id, { id: 'seed-user', role: 'user', content: 'seeded-user-marker', createdAt: Date.now() });
  conversations.persistMessage(seeded.id, { id: 'seed-assistant', role: 'assistant', content: 'seeded-assistant-marker', createdAt: Date.now() + 1 });
  const seededApp = render(React.createElement(App, { options: { cwd: resolve('.'), conversation: seeded.id } }), {
    stdin, stdout, stderr: process.stderr, exitOnCtrlC: false, debug: true, patchConsole: false
  });
  const seededExited = seededApp.waitUntilExit();
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));

  const attachmentNamesBeforeSwitch = new Set(readdirSync(join(dataDir, 'attachments')));
  for (const character of '/attach README.md') stdin.write(character);
  await new Promise((resolveWait) => setTimeout(resolveWait, 60));
  stdin.write('\r');
  await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  const stagedAttachment = readdirSync(join(dataDir, 'attachments')).find((name) => !attachmentNamesBeforeSwitch.has(name) && /^[0-9a-f-]{36}$/iu.test(name));
  assert.ok(stagedAttachment, 'the workspace-switch fixture must stage an attachment');

  for (const character of `/cd ${alternateWorkspace}`) stdin.write(character);
  await new Promise((resolveWait) => setTimeout(resolveWait, 60));
  output = '';
  stdin.write('\r');
  await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  assert.match(output.replace(ansiCsi, ''), /new conversation/i);
  const cliConfig = await import('../utils/config.js');
  const { sameWorkspacePath } = await import('../../../src/shared/workspace.js');
  const switchedState = cliConfig.loadState();
  assert.notEqual(switchedState.currentConversationId, seeded.id);
  const switchedConversation = conversations.getConversation(switchedState.currentConversationId || '');
  assert.equal(sameWorkspacePath(switchedConversation?.workspacePath, alternateWorkspace), true);
  assert.equal(switchedConversation?.projectId, undefined, 'unregistered workspace clears the active project id');
  assert.equal(existsSync(join(dataDir, 'attachments', stagedAttachment)), false, 'workspace switching deletes pending attachments from the old workspace');

  for (const character of '/cd relative-child') stdin.write(character);
  await new Promise((resolveWait) => setTimeout(resolveWait, 60));
  stdin.write('\r');
  await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  const relativeState = cliConfig.loadState();
  assert.equal(sameWorkspacePath(relativeState.currentProjectPath, relativeWorkspace), true, 'TUI relative /cd resolves from the active workspace');

  for (const character of `/resume ${seeded.id}`) stdin.write(character);
  await new Promise((resolveWait) => setTimeout(resolveWait, 60));
  output = '';
  stdin.write('\r');
  await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  assert.match(output.replace(ansiCsi, ''), /Resumed: Seeded parity session/);
  assert.equal(cliConfig.loadState().currentConversationId, seeded.id);

  for (const character of '/home') stdin.write(character);
  await new Promise((resolveWait) => setTimeout(resolveWait, 60));
  output = '';
  stdin.write('\r');
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  assert.match(output.replace(ansiCsi, ''), /Home · the previous conversation remains saved/);
  assert.ok(conversations.getConversation(seeded.id), '/home must not delete the saved session');

  for (const character of `/resume ${seeded.id}`) stdin.write(character);
  await new Promise((resolveWait) => setTimeout(resolveWait, 60));
  output = '';
  stdin.write('\r');
  await new Promise((resolveWait) => setTimeout(resolveWait, 120));
  assert.match(output.replace(ansiCsi, ''), /Resumed: Seeded parity session/);
  output = '';
  for (const character of '/transcript') stdin.write(character);
  await new Promise((resolveWait) => setTimeout(resolveWait, 60));
  stdin.write('\r');
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  const transcript = output.replace(ansiCsi, '');
  assert.match(transcript, /Transcript/);
  assert.match(transcript, /seeded-user-marker/);
  assert.match(transcript, /seeded-assistant-marker/);
  stdin.write('\u001b');
  await new Promise((resolveWait) => setTimeout(resolveWait, 50));

  output = '';
  for (const character of '/copy 0') stdin.write(character);
  await new Promise((resolveWait) => setTimeout(resolveWait, 60));
  stdin.write('\r');
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  assert.match(output.replace(ansiCsi, ''), /Usage: \/copy \[last\|code\|response-number\]/);

  const sharedPath = join(dataDir, 'shared-session.md');
  output = '';
  for (const character of `/share markdown "${sharedPath}"`) stdin.write(character);
  await new Promise((resolveWait) => setTimeout(resolveWait, 60));
  stdin.write('\r');
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  assert.match(output.replace(ansiCsi, ''), /Exported:/);
  assert.match(readFileSync(sharedPath, 'utf8'), /Seeded parity session/);

  output = '';
  for (const character of '/flush') stdin.write(character);
  await new Promise((resolveWait) => setTimeout(resolveWait, 60));
  stdin.write('\r');
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  assert.match(output.replace(ansiCsi, ''), /Session summary saved to memory/);

  output = '';
  for (const character of `/delete ${seeded.id}`) stdin.write(character);
  await new Promise((resolveWait) => setTimeout(resolveWait, 60));
  stdin.write('\r');
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  assert.match(output.replace(ansiCsi, ''), /Deletion is permanent/);
  assert.ok(conversations.getConversation(seeded.id), 'unconfirmed deletion must keep the session');

  output = '';
  for (const character of `/delete ${seeded.id} confirm`) stdin.write(character);
  await new Promise((resolveWait) => setTimeout(resolveWait, 60));
  stdin.write('\r');
  await new Promise((resolveWait) => setTimeout(resolveWait, 140));
  assert.match(output.replace(ansiCsi, ''), /Deleted session: Seeded parity session/);
  assert.equal(conversations.getConversation(seeded.id), null, 'confirmed deletion must remove the session');
  seededApp.unmount();
  await seededExited;

  // ── Event-driven provider coverage: form validation, mid-form cancellation,
  //    connection test, model refresh (success + failure banner), and the
  //    destructive remove-provider confirmation. Uses a loopback HTTP server so
  //    no external network or credentials are ever touched.
  const { createServer } = await import('node:http');
  const providerService = await import('../../../src/main/providers/service.js');
  const providerRegistry = await import('../../../src/main/providers/registry.js');

  let fakeModelIds = ['hive-fake-alpha'];
  let fakeModelsFail = false;
  const fakeProviderServer = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (!fakeModelsFail && request.method === 'GET' && request.url === '/models') {
      response.end(JSON.stringify({ data: fakeModelIds.map((id) => ({ id })) }));
      return;
    }
    if (request.method === 'POST' && request.url === '/chat/completions') {
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: { message: 'not found' } }));
  });
  await new Promise<void>((resolveListen) => { fakeProviderServer.listen(0, '127.0.0.1', resolveListen); });
  const fakeAddress = fakeProviderServer.address();
  if (!fakeAddress || typeof fakeAddress !== 'object') throw new Error('the fake provider server did not report a port');
  const fakeBaseUrl = `http://127.0.0.1:${fakeAddress.port}`;

  const savedFake = await providerService.saveProvider({
    id: 'local-fake', presetId: 'custom', name: 'Local Fake', baseUrl: fakeBaseUrl, enabled: true, defaultModel: 'hive-fake-alpha'
  });
  assert.equal(savedFake.discovery.ok, true, 'the loopback provider must connect without external network');

  const strippedOutput = (): string => output.replace(ansiCsi, '');
  const whitespaceTolerant = (text: string): RegExp => new RegExp(
    text.split(' ').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+')
  );
  async function waitForOutput(pattern: RegExp): Promise<void> {
    for (let attempt = 0; attempt < 150 && !pattern.test(strippedOutput()); attempt += 1) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
    assert.match(strippedOutput(), pattern);
  }
  async function pressKey(sequence: string, settleMs = 80): Promise<void> {
    stdin.write(sequence);
    await new Promise((resolveWait) => setTimeout(resolveWait, settleMs));
  }
  async function typeText(text: string): Promise<void> {
    for (const character of text) stdin.write(character);
    await new Promise((resolveWait) => setTimeout(resolveWait, 80));
  }
  async function clearOverlayInput(): Promise<void> {
    await pressKey('\u0001', 40);
    await pressKey('\u001b[3~', 60);
  }
  async function openProvidersOverlay(): Promise<void> {
    output = '';
    await pressKey('\u001bOQ');
    await waitForOutput(/❯ Providers /);
    output = '';
    await pressKey('\r');
    await waitForOutput(/Connect provider/);
  }
  async function openLocalFakeManagement(): Promise<void> {
    await openProvidersOverlay();
    output = '';
    await typeText('local');
    await waitForOutput(/❯ configured \/ Local Fake/);
    output = '';
    await pressKey('\r');
    await waitForOutput(/Verify credentials and endpoint/);
  }

  output = '';
  const providerApp = render(React.createElement(App, { options: { cwd: resolve('.') } }), {
    stdin, stdout, stderr: process.stderr, exitOnCtrlC: false, debug: true, patchConsole: false
  });
  const providerExited = providerApp.waitUntilExit();
  await waitForOutput(/Local Fake/);
  await waitForOutput(/hive-fake-alpha/);

  // Provider form validation: required, malformed, and duplicate ids.
  await openProvidersOverlay();
  output = '';
  await typeText('connect');
  await waitForOutput(/❯ action \/ Connect provider/);
  output = '';
  await pressKey('\r');
  await waitForOutput(/OpenCode Zen/);
  output = '';
  await typeText('custom');
  await waitForOutput(/❯ Custom OpenAI-compatible/);
  output = '';
  await pressKey('\r');
  await waitForOutput(/❯ Provider id Step 1 of 5/);
  assert.match(strippedOutput(), /Type a value · Enter continue · Esc cancel/);
  assert.match(strippedOutput(), /⌕ custom/, 'the id step must pre-fill the preset id');
  await clearOverlayInput();
  output = '';
  await pressKey('\r');
  await waitForOutput(/× Provider id is required\./);
  await typeText('bad id');
  output = '';
  await pressKey('\r');
  await waitForOutput(whitespaceTolerant('× Provider id may contain letters, numbers, dots, dashes, and underscores.'));
  await clearOverlayInput();
  await typeText('local-fake');
  output = '';
  await pressKey('\r');
  await waitForOutput(whitespaceTolerant('× Provider id “local-fake” is already configured.'));

  // A valid id advances the wizard; base URL validation then rejects bad input.
  await clearOverlayInput();
  await typeText('local-two');
  output = '';
  await pressKey('\r');
  await waitForOutput(/❯ Display name Step 2 of 5/);
  assert.match(strippedOutput(), /⌕ Custom OpenAI-compatible/, 'the name step must pre-fill the preset name');
  output = '';
  await pressKey('\r');
  await waitForOutput(/❯ Base URL Step 3 of 5/);
  output = '';
  await pressKey('\r');
  await waitForOutput(/× Base URL is required\./);
  await typeText('ftp://blocked.invalid');
  output = '';
  await pressKey('\r');
  await waitForOutput(whitespaceTolerant('× Base URL must be http(s) and must not contain credentials.'));
  await clearOverlayInput();
  output = '';
  await pressKey('\r');
  await waitForOutput(/× Base URL is required\./);
  await typeText('http://user:secret@127.0.0.1:65000');
  output = '';
  await pressKey('\r');
  await waitForOutput(whitespaceTolerant('× Base URL must be http(s) and must not contain credentials.'));

  // Esc mid-form cancels without a partial save and resets the draft.
  output = '';
  await pressKey('\u001b', 100);
  await waitForOutput(/DERO Hive/);
  assert.equal(providerRegistry.getProviderConfig('local-two'), null, 'cancelling provider setup mid-form must not save a partial provider');
  assert.equal(providerRegistry.listProviders().length, 1, 'cancelling provider setup must leave the provider list unchanged');
  await openProvidersOverlay();
  output = '';
  await typeText('connect');
  await waitForOutput(/❯ action \/ Connect provider/);
  output = '';
  await pressKey('\r');
  await waitForOutput(/OpenCode Zen/);
  output = '';
  await typeText('custom');
  await waitForOutput(/❯ Custom OpenAI-compatible/);
  output = '';
  await pressKey('\r');
  await waitForOutput(/❯ Provider id Step 1 of 5/);
  assert.match(strippedOutput(), /⌕ custom/, 're-opening provider setup must start from a fresh draft');
  assert.doesNotMatch(strippedOutput(), /local-two/, 'a cancelled draft must not leak into the next setup');
  await pressKey('\u001b', 100);

  // Test connection succeeds against the loopback endpoint.
  await openLocalFakeManagement();
  assert.match(strippedOutput(), /❯ Test connection Verify credentials and endpoint/);
  assert.match(strippedOutput(), /Refresh models/);
  assert.match(strippedOutput(), /Add API key Input stays masked/);
  assert.match(strippedOutput(), /Disable provider/);
  assert.match(strippedOutput(), /Remove provider Requires confirmation/);
  output = '';
  await typeText('test');
  await waitForOutput(/❯ Test connection/);
  output = '';
  await pressKey('\r');
  await waitForOutput(/Testing Local Fake…/);
  await waitForOutput(/· Local Fake is reachable\./);

  // Refresh models re-fetches and persists the discovered list.
  fakeModelIds = ['hive-fake-alpha', 'hive-fake-beta'];
  await openLocalFakeManagement();
  output = '';
  await typeText('refresh');
  await waitForOutput(/❯ Refresh models/);
  output = '';
  await pressKey('\r');
  await waitForOutput(/Refreshing Local Fake models…/);
  await waitForOutput(/· Local Fake models refreshed · 2 available\./);
  assert.deepEqual(
    providerRegistry.getProviderConfig('local-fake')?.models.map((entry) => entry.id),
    ['hive-fake-alpha', 'hive-fake-beta'],
    'refresh must persist the newly discovered model list'
  );

  // A failing refresh surfaces an error banner and keeps the previous models.
  fakeModelsFail = true;
  await openLocalFakeManagement();
  output = '';
  await typeText('refresh');
  await waitForOutput(/❯ Refresh models/);
  output = '';
  await pressKey('\r');
  await waitForOutput(whitespaceTolerant('× Local Fake refresh failed: Could not retrieve model list from provider'));
  assert.equal(providerRegistry.getProviderConfig('local-fake')?.models.length, 2, 'a failed refresh must keep the previously discovered models');
  fakeModelsFail = false;

  // Destructive confirmation: declining keeps the provider, confirming removes it.
  await openLocalFakeManagement();
  output = '';
  await typeText('remove');
  await waitForOutput(/❯ Remove provider Requires confirmation/);
  output = '';
  await pressKey('\r');
  await waitForOutput(/Confirm provider removal/);
  assert.match(strippedOutput(), /❯ Remove Local Fake This also removes its saved API key/);
  assert.match(strippedOutput(), /Cancel Keep this provider/);
  output = '';
  await pressKey('\u001b[B');
  await waitForOutput(/❯ Cancel Keep this provider/);
  output = '';
  await pressKey('\r');
  await waitForOutput(/Verify credentials and endpoint/);
  assert.ok(providerRegistry.getProviderConfig('local-fake'), 'declining the removal confirmation must keep the provider');
  output = '';
  await typeText('remove');
  await waitForOutput(/❯ Remove provider Requires confirmation/);
  output = '';
  await pressKey('\r');
  await waitForOutput(/Confirm provider removal/);
  output = '';
  await pressKey('\r');
  await waitForOutput(/· Local Fake removed\./);
  assert.equal(providerRegistry.getProviderConfig('local-fake'), null, 'confirming removal must delete the provider');

  // Completing the whole form: masked key entry, save, and a discovery-failure banner.
  await openProvidersOverlay();
  await waitForOutput(/❯ action \/ Connect provider/);
  output = '';
  await pressKey('\r');
  await waitForOutput(/OpenCode Zen/);
  output = '';
  await typeText('custom');
  await waitForOutput(/❯ Custom OpenAI-compatible/);
  output = '';
  await pressKey('\r');
  await waitForOutput(/❯ Provider id Step 1 of 5/);
  output = '';
  await pressKey('\r');
  await waitForOutput(/❯ Display name Step 2 of 5/);
  await clearOverlayInput();
  await typeText('Local Broken');
  output = '';
  await pressKey('\r');
  await waitForOutput(/❯ Base URL Step 3 of 5/);
  await typeText(`${fakeBaseUrl}/missing`);
  output = '';
  await pressKey('\r');
  await waitForOutput(/❯ Default model Step 4 of 5/);
  output = '';
  await pressKey('\r');
  await waitForOutput(/× Default model is required\./);
  await typeText('broken-model');
  output = '';
  await pressKey('\r');
  await waitForOutput(/❯ API key or subscription key/);
  assert.match(strippedOutput(), /Paste a key, or leave blank if authentication is not req/);
  assert.match(strippedOutput(), /⌕ optional/, 'the key step must show its optional placeholder');
  output = '';
  await typeText('sekret-key-123');
  await waitForOutput(/•{14}/);
  assert.doesNotMatch(output, /sekret-key-123/, 'typing a provider key must render only mask characters');
  await pressKey('\r');
  await waitForOutput(whitespaceTolerant('Saving Local Broken and discovering models…'));
  await waitForOutput(whitespaceTolerant('× Local Broken was saved, but model discovery failed: Could not retrieve model list from provider'));
  assert.doesNotMatch(output, /sekret-key-123/, 'provider save notices must never echo the key');
  const brokenProvider = providerRegistry.getProviderConfig('custom');
  assert.ok(brokenProvider, 'completing the form must save the provider even when discovery fails');
  assert.equal(brokenProvider?.name, 'Local Broken');
  assert.equal(brokenProvider?.hasApiKey, true, 'the submitted key must be stored for the saved provider');
  assert.deepEqual(brokenProvider?.models.map((entry) => entry.id), ['broken-model'], 'a failed discovery must fall back to the typed default model');

  providerApp.unmount();
  await providerExited;
  fakeProviderServer.closeAllConnections();
  await new Promise((resolveClose) => { fakeProviderServer.close(() => resolveClose(undefined)); });

  const composer = render(React.createElement(ComposerProbe), { stdout, stdin, patchConsole: false });
  const composerExited = composer.waitUntilExit();
  await new Promise((resolveWait) => setTimeout(resolveWait, 40));
  stdin.write('\u0001');
  await new Promise((resolveWait) => setTimeout(resolveWait, 40));
  assert.equal(composerValue, 'z', 'Ctrl+A must select, not insert a literal a');
  stdin.write('\u001b[3~');
  await new Promise((resolveWait) => setTimeout(resolveWait, 60));
  assert.equal(composerValue, '', 'Delete must clear a fully selected value');
  stdin.write('q');
  await new Promise((resolveWait) => setTimeout(resolveWait, 40));
  stdin.write('\b');
  await new Promise((resolveWait) => setTimeout(resolveWait, 60));
  assert.equal(composerValue, '', 'Backspace must remove the final character');
  stdin.write('abc');
  await new Promise((resolveWait) => setTimeout(resolveWait, 40));
  stdin.write('\u001b[D');
  await new Promise((resolveWait) => setTimeout(resolveWait, 30));
  stdin.write('\u001b[D');
  await new Promise((resolveWait) => setTimeout(resolveWait, 40));
  stdin.write('\u001b[3~');
  await new Promise((resolveWait) => setTimeout(resolveWait, 60));
  assert.equal(composerValue, 'ac', 'Delete must remove the character under the cursor');
  stdin.write('\u0001');
  await new Promise((resolveWait) => setTimeout(resolveWait, 40));
  stdin.write('\b');
  await new Promise((resolveWait) => setTimeout(resolveWait, 60));
  assert.equal(composerValue, '', 'Backspace must clear a fully selected value');
  stdin.write('q');
  await new Promise((resolveWait) => setTimeout(resolveWait, 40));
  stdin.write('\u001b[3~');
  await new Promise((resolveWait) => setTimeout(resolveWait, 60));
  assert.equal(composerValue, '', 'Delete must remove the final character at the end of input');
  stdin.write('\u001b[<35;20');
  await new Promise((resolveWait) => setTimeout(resolveWait, 40));
  stdin.write(';10M');
  await new Promise((resolveWait) => setTimeout(resolveWait, 40));
  assert.equal(composerValue, '', 'split mouse reports must never leak into the composer');
  composer.unmount();
  await composerExited;

  const scopedComposer = render(React.createElement(ScopedComposerProbe, { scope: 'composer' }), { stdout, stdin, patchConsole: false });
  const scopedExited = scopedComposer.waitUntilExit();
  await new Promise((resolveWait) => setTimeout(resolveWait, 40));
  stdin.write('\u001b[D');
  await new Promise((resolveWait) => setTimeout(resolveWait, 30));
  stdin.write('\u001b[D');
  await new Promise((resolveWait) => setTimeout(resolveWait, 40));
  scopedComposer.rerender(React.createElement(ScopedComposerProbe, { scope: 'overlay' }));
  await new Promise((resolveWait) => setTimeout(resolveWait, 40));
  stdin.write('filter');
  await new Promise((resolveWait) => setTimeout(resolveWait, 40));
  scopedComposer.rerender(React.createElement(ScopedComposerProbe, { scope: 'composer' }));
  await new Promise((resolveWait) => setTimeout(resolveWait, 40));
  stdin.write('X');
  await new Promise((resolveWait) => setTimeout(resolveWait, 60));
  assert.equal(scopedComposerValue, 'aXbc', 'opening and closing an overlay must preserve the composer cursor');
  scopedComposer.unmount();
  await scopedExited;

  composerValue = '';
  composerSubmits = 0;
  const multilineComposer = render(React.createElement(ComposerProbe, { initial: '', multiline: true }), { stdout, stdin, patchConsole: false });
  const multilineExited = multilineComposer.waitUntilExit();
  await new Promise((resolveWait) => setTimeout(resolveWait, 40));
  stdin.write('alpha');
  await new Promise((resolveWait) => setTimeout(resolveWait, 40));
  stdin.write('\r');
  await new Promise((resolveWait) => setTimeout(resolveWait, 40));
  stdin.write('beta');
  await new Promise((resolveWait) => setTimeout(resolveWait, 60));
  assert.equal(composerValue, 'alpha\nbeta', 'Enter must add a newline in multiline mode');
  assert.equal(composerSubmits, 0, 'regular Enter must not submit in multiline mode');
  stdin.write('\u001b\r');
  await new Promise((resolveWait) => setTimeout(resolveWait, 60));
  assert.equal(composerSubmits, 1, 'Alt+Enter must submit exactly once in multiline mode');
  stdin.write('\u001b[13;2u');
  await new Promise((resolveWait) => setTimeout(resolveWait, 60));
  assert.equal(composerSubmits, 2, 'Shift+Enter must submit in terminals that report modified Enter');
  assert.equal(composerValue, 'alpha\nbeta', 'submitting must not mutate the controlled value');
  multilineComposer.unmount();
  await multilineExited;

  const commandStdout = new PassThrough() as PassThrough & NodeJS.WriteStream;
  Object.assign(commandStdout, { columns: 24, rows: 10, isTTY: true });
  let commandOutput = '';
  commandStdout.on('data', (chunk) => { commandOutput += chunk.toString(); });
  const commandMenu = render(React.createElement(CommandMenu, {
    theme: resolveTheme('dark'),
    items: [{ id: 'long', label: '/very-long-command-name', detail: 'A deliberately long description for narrow terminals' }],
    selected: 0,
    width: 24
  }), { stdout: commandStdout, stdin, patchConsole: false });
  const commandMenuExited = commandMenu.waitUntilExit();
  await new Promise((resolveWait) => setTimeout(resolveWait, 40));
  commandMenu.unmount();
  await commandMenuExited;
  const narrowCommandMenu = commandOutput.replace(ansiCsi, '');
  assert.match(narrowCommandMenu, /› \/very-long/);
  assert.match(narrowCommandMenu, /A deliberate/);

  const narrowStdout = new PassThrough() as PassThrough & NodeJS.WriteStream;
  Object.assign(narrowStdout, { columns: 24, rows: 2, isTTY: true });
  let narrowOutput = '';
  narrowStdout.on('data', (chunk) => { narrowOutput += chunk.toString(); });
  const narrowTheme = resolveTheme('dark');
  const narrow = render(React.createElement(StatusBar, {
    theme: narrowTheme,
    provider: 'Provider',
    model: 'long-model-name',
    reasoning: 'high',
    usage: { promptTokens: 1_000_000, completionTokens: 234_567, totalTokens: 1_234_567 },
    width: 20,
    borderColor: narrowTheme.palette.borderStrong
  }), { stdout: narrowStdout, stdin, patchConsole: false });
  const narrowExited = narrow.waitUntilExit();
  await new Promise((resolveWait) => setTimeout(resolveWait, 40));
  narrow.unmount();
  await narrowExited;
  const narrowLines = narrowOutput
    .replace(ansiCsi, '')
    .split(/\r?\n/)
    .filter((line) => line.includes('╰'));
  assert.ok(narrowLines.length > 0 && narrowLines.every((line) => Array.from(line).length <= 22));
} finally {
  await shutdownHive();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(alternateWorkspace, { recursive: true, force: true });
}
