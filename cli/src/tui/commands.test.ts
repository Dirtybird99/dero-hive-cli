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

// Non-command input and malformed slashes must never dispatch.
assert.equal(parseSlashCommand(''), null);
assert.equal(parseSlashCommand('   '), null);
assert.equal(parseSlashCommand('/'), null, 'a bare slash is not a command');
assert.equal(parseSlashCommand('/ model'), null, 'whitespace may not separate the slash from the name');
assert.equal(parseSlashCommand('say /model in prose'), null, 'a slash mid-sentence is plain text');

// Unknown commands parse without resolving to a catalog item, so the caller
// can fall through to skill dispatch or its unknown-command message.
const unknown = parseSlashCommand('/frobnicate --fast now');
assert.equal(unknown?.command, 'frobnicate');
assert.equal(unknown?.invokedAs, 'frobnicate');
assert.equal(unknown?.item, undefined, 'unknown commands must not resolve to a catalog item');
assert.deepEqual(unknown?.args, ['--fast', 'now']);
assert.equal(parseSlashCommand('//model')?.item, undefined, 'a doubled slash is not a builtin invocation');

// Invocations are case-insensitive; argument case is preserved.
const upper = parseSlashCommand('/HELP Setup');
assert.equal(upper?.command, 'commands');
assert.equal(upper?.invokedAs, 'help');
assert.deepEqual(upper?.args, ['Setup']);

// Trailing whitespace, tabs, and embedded newlines in the argument text.
const bare = parseSlashCommand('/new   ');
assert.equal(bare?.argumentText, '');
assert.deepEqual(bare?.args, []);
const tabbed = parseSlashCommand('/rename\tHello\tWorld');
assert.equal(tabbed?.command, 'rename');
assert.deepEqual(tabbed?.args, ['Hello', 'World']);
const multilineArgs = parseSlashCommand('/remember first line\nsecond line');
assert.equal(multilineArgs?.argumentText, 'first line\nsecond line');
assert.deepEqual(multilineArgs?.args, ['first', 'line', 'second', 'line']);

// Argument tokenisation: quotes group words, escapes work only inside quotes,
// and bare Windows paths keep their backslashes.
assert.deepEqual(parseSlashCommand('/rename "say \\"hi\\"" done')?.args, ['say "hi"', 'done']);
assert.deepEqual(parseSlashCommand('/rename "a\\\\b"')?.args, ['a\\b']);
assert.deepEqual(parseSlashCommand('/rename "a\\nb"')?.args, ['a\\nb'], 'a backslash before a normal character stays literal');
assert.deepEqual(parseSlashCommand(String.raw`/cd C:\temp\hive`)?.args, [String.raw`C:\temp\hive`]);
assert.deepEqual(parseSlashCommand("/attach 'my file.txt' send now")?.args, ['my file.txt', 'send', 'now']);
assert.deepEqual(parseSlashCommand(`/rename 'it "is" fine'`)?.args, ['it "is" fine']);
assert.deepEqual(parseSlashCommand(`/rename "foo"'bar'baz`)?.args, ['foobarbaz'], 'adjacent quoted segments join into one token');
assert.deepEqual(parseSlashCommand('/rename "unterminated title')?.args, ['unterminated title'], 'an unterminated quote captures the rest of the line');
const emptyQuoted = parseSlashCommand('/rename "" keep');
assert.deepEqual(emptyQuoted?.args, ['keep'], 'empty quoted strings produce no token');
assert.equal(emptyQuoted?.argumentText, '"" keep');

// Every documented usage line must begin with its own command and parse back
// to it, so help output can never drift from the dispatch table.
for (const item of COMMAND_ITEMS) {
  assert.ok(
    item.usage === item.command || item.usage.startsWith(`${item.command} `),
    `usage for /${item.name} must begin with its command`
  );
  assert.equal(parseSlashCommand(item.usage)?.command, item.name, `usage for /${item.name} must parse back to it`);
}

// Filtering: query normalisation and ranking tiers.
assert.equal(filterCommandItems('').length, COMMAND_ITEMS.length, 'an empty query lists every builtin');
assert.equal(filterCommandItems('')[0]?.name, 'commands', 'an empty query keeps registration order');
assert.equal(filterCommandItems('').at(-1)?.name, 'quit');
assert.equal(filterCommandItems('/model gpt-5 high')[0]?.name, 'model', 'only the first word of the query matches');
assert.equal(filterCommandItems('//model')[0]?.name, 'model', 'extra leading slashes are ignored');
assert.equal(filterCommandItems('MODEL')[0]?.name, 'model', 'queries are case-insensitive');
assert.equal(filterCommandItems('changelog')[0]?.name, 'release-notes', 'an exact alias match ranks first');
assert.equal(filterCommandItems('clipboard')[0]?.name, 'copy', 'keyword prefixes outrank description matches');
assert.equal(filterCommandItems('permanently')[0]?.name, 'delete', 'description text is searchable');
assert.deepEqual(filterCommandItems('@@@'), [], 'unmatched queries return nothing');

// Suggestions expose the full row shape and clamp nonsense limits.
const modelSuggestion = commandSuggestions('/model')[0];
assert.deepEqual(modelSuggestion, {
  id: 'builtin:model',
  label: '/model',
  value: '/model',
  description: 'Choose the provider and model for the next turn',
  usage: '/model [provider/model|name] [effort]',
  category: 'model',
  aliases: ['models', 'provider', 'm'],
  source: 'builtin'
});
assert.equal(commandSuggestions('/', skills, 0).length, 0);
assert.equal(commandSuggestions('/', skills, -3).length, 0, 'negative limits clamp to zero');
assert.equal(commandSuggestions('/', skills, 2.9).length, 2, 'fractional limits round down');
assert.equal(commandSuggestions('/', skills, Number.NaN).length, 10, 'NaN limits fall back to the default');
assert.equal(commandSuggestions('/', skills, Number.POSITIVE_INFINITY).length, 10, 'infinite limits fall back to the default');
assert.deepEqual(commandSuggestions('@@@', skills), []);

// Skill-derived commands: name fallback, slash and case normalisation,
// duplicate and builtin-name shadowing, default descriptions.
const skillSeeds = [
  { name: 'deploy', category: 'ops' },
  { name: 'Docs Helper', slashCommand: '///DOCS-helper' },
  { name: 'first', slashCommand: '/dup', description: 'First wins' },
  { name: 'second', slashCommand: '/dup', description: 'Second is ignored' },
  { name: 'model', description: 'May not shadow a builtin name' },
  { name: 'blank description', slashCommand: '/blank-desc', description: '   ' }
];
const skillList = filterCommandItems('', skillSeeds).filter((item) => item.source === 'skill');
assert.deepEqual(skillList.map((item) => item.name), ['deploy', 'docs-helper', 'dup', 'blank-desc']);
const deploySkill = skillList.find((item) => item.name === 'deploy');
assert.equal(deploySkill?.command, '/deploy');
assert.equal(deploySkill?.usage, '/deploy');
assert.equal(deploySkill?.description, 'Run the deploy skill');
assert.equal(deploySkill?.category, 'skill');
assert.deepEqual(deploySkill?.aliases, []);
assert.deepEqual(deploySkill?.keywords, ['skill', 'deploy', 'ops']);
assert.equal(skillList.find((item) => item.name === 'dup')?.description, 'First wins', 'the first duplicate registration wins');
assert.equal(skillList.find((item) => item.name === 'blank-desc')?.description, 'Run the blank description skill');
assert.equal(filterCommandItems('ops', skillSeeds)[0]?.name, 'deploy', 'skill categories are searchable keywords');
assert.equal(parseSlashCommand('/deploy')?.item, undefined, 'skill commands stay outside the builtin lookup');

// The catalog and caller-supplied skill arrays are never mutated.
const frozenSkills = Object.freeze([Object.freeze({ name: 'frozen-skill' })]);
assert.equal(filterCommandItems('frozen-skill', frozenSkills)[0]?.name, 'frozen-skill');
