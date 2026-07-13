import React from 'react';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { render } from 'ink';

const dataDir = mkdtempSync(join(tmpdir(), 'dero-hive-tui-'));
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
const { CommandMenu, ComposerInput, StatusBar, Welcome, glimmerLevel } = await import('./components.js');
const { resolveTheme } = await import('./themes.js');

let composerValue = 'z';
let composerSubmits = 0;
assert.equal(glimmerLevel(0, 1), 2, 'the glimmer head should light the current logo column');
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

try {
  await initHive();
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
  instance.unmount();
  await exited;

  const conversations = await import('../services/conversation.js');
  const seeded = conversations.createConversation({ title: 'Seeded parity session', providerId: 'test', model: 'test-model' });
  conversations.persistMessage(seeded.id, { id: 'seed-user', role: 'user', content: 'seeded-user-marker', createdAt: Date.now() });
  conversations.persistMessage(seeded.id, { id: 'seed-assistant', role: 'assistant', content: 'seeded-assistant-marker', createdAt: Date.now() + 1 });
  const seededApp = render(React.createElement(App, { options: { cwd: resolve('.'), conversation: seeded.id } }), {
    stdin, stdout, stderr: process.stderr, exitOnCtrlC: false, debug: true, patchConsole: false
  });
  const seededExited = seededApp.waitUntilExit();
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));

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
}
