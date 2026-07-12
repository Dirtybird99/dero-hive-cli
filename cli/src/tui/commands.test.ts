import assert from 'node:assert/strict';
import {
  COMMAND_ITEMS,
  commandSuggestions,
  filterCommandItems,
  parseSlashCommand
} from './commands.js';

assert.equal(parseSlashCommand('hello'), null);

const parsed = parseSlashCommand('  /exit "when finished" now  ');
assert.equal(parsed?.command, 'quit');
assert.equal(parsed?.invokedAs, 'exit');
assert.deepEqual(parsed?.args, ['when finished', 'now']);

const invocationTokens = COMMAND_ITEMS.flatMap((item) => [item.name, ...item.aliases]);
assert.equal(new Set(invocationTokens).size, invocationTokens.length, 'command names and aliases must be unique');

for (const item of COMMAND_ITEMS) {
  assert.equal(item.command, `/${item.name}`);
  for (const invocation of [item.name, ...item.aliases]) {
    const command = parseSlashCommand(`/${invocation}`);
    assert.equal(command?.command, item.name, `/${invocation} should resolve to ${item.command}`);
    assert.equal(command?.invokedAs, invocation);
    assert.equal(command?.item?.name, item.name);
  }
}

assert.equal(parseSlashCommand('/help')?.command, 'commands');
assert.equal(parseSlashCommand('/clear')?.command, 'new');
assert.equal(parseSlashCommand('/undo')?.command, 'rewind');
assert.equal(parseSlashCommand('/reasoning')?.command, 'effort');
assert.equal(parseSlashCommand('/cost')?.command, 'usage');
assert.equal(parseSlashCommand('/ml')?.command, 'multiline');
assert.equal(parseSlashCommand('/minimal')?.command, 'minimal');
assert.equal(parseSlashCommand('/dream')?.command, 'imagine');
assert.equal(parseSlashCommand('/marketplace')?.command, 'extensions');

const command = (name: string) => {
  const item = COMMAND_ITEMS.find((entry) => entry.name === name);
  assert.ok(item, `missing /${name} metadata`);
  return item;
};

for (const name of ['shortcuts', 'transcript', 'delete', 'worktree', 'minimal', 'fullscreen', 'multiline', 'vim-mode', 'extensions', 'feedback', 'flush']) {
  assert.equal(parseSlashCommand(`/${name}`)?.command, name);
}

assert.equal(command('sessions').usage, '/sessions [query|rename <id> <title>|close <id> confirm]');
assert.equal(command('model').usage, '/model [provider/model|name] [effort]');
assert.equal(command('effort').usage, '/effort [off|low|medium|high|max|xhigh]');
assert.equal(command('export').usage, '/export [markdown|json|clipboard] [path]');
assert.equal(command('share').usage, '/share [clipboard|markdown|json] [path]');
assert.equal(command('memory').usage, '/memory [on|off|clear|remove <number>]');
assert.equal(command('goal').usage, '/goal [status|pause|resume|clear|text]');
assert.equal(command('delete').usage, '/delete [session-id] confirm');
assert.deepEqual(command('context').aliases, ['ctx', 'tokens']);
assert.deepEqual(command('compact-mode').aliases, []);
assert.match(command('usage').description, /local token usage/i);
assert.doesNotMatch(command('usage').description, /billing|credit/i);

assert.equal(filterCommandItems('/thi')[0]?.name, 'thinking');
assert.equal(filterCommandItems('undo')[0]?.name, 'rewind');

const skills = [
  { name: 'review', slashCommand: '/review', description: 'Review the current diff', enabled: true },
  { name: 'local commit', slashCommand: '/local:commit', description: 'Commit with local policy', enabled: true },
  { name: 'shadow help', slashCommand: '/help', description: 'Must not shadow a built-in alias', enabled: true },
  { name: 'disabled', enabled: false },
  { name: 'unsafe', slashCommand: '/bad command' }
];
assert.equal(filterCommandItems('/rev', skills)[0]?.name, 'review');
assert.equal(filterCommandItems('/local:', skills)[0]?.name, 'local:commit');
assert.ok(!filterCommandItems('/', skills).some((item) => item.source === 'skill' && item.name === 'help'));
assert.ok(filterCommandItems('/', skills).some((item) => item.source === 'skill' && item.name === 'review'));
assert.equal(commandSuggestions('/', skills, 2).length, 2);
assert.equal(commandSuggestions('/commands', skills)[0]?.value, '/commands');
assert.equal(filterCommandItems('/fscr')[0]?.name, 'fullscreen');
