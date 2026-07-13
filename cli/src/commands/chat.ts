import { Command } from 'commander';
import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import chalk from 'chalk';
import { initHive, getContext, shutdownHive } from '../utils/init.js';
import * as format from '../utils/format.js';
import * as config from '../utils/config.js';
import * as conversationService from '../services/conversation.js';
import * as projectService from '../services/project.js';
import { runChat } from '../services/chat.js';
import { listProviders } from '../../../src/main/providers/registry.js';
import { paths, getDefaultWorkspace } from '../../../src/main/utils/paths.js';
import { getDb } from '../../../src/main/db/client.js';
import type { Message, TokenUsage } from '../../../src/shared/types.js';
import { APP_VERSION } from '../../../src/shared/version.js';
import { loadBundledSkills, loadUserSkills } from '../../../src/main/skills/loader.js';

// ── Command registry ──────────────────────────────────────────────────
const SLASH_COMMANDS: Record<string, string> = {
  'help': 'Show this help',
  'quit': 'Exit the chat',
  'exit': 'Exit the chat',
  'new': 'Start a new conversation',
  'list': 'List all conversations',
  'sessions': 'List all conversations',
  'rename': 'Rename current conversation  /rename <title>',
  'delete': 'Delete a conversation  /delete [id]',
  'search': 'Search conversations  /search <query>',
  'export': 'Export conversation as markdown  /export [id]',
  'fork': 'Fork the current conversation',
  'project': 'Set active project',
  'provider': 'Set active provider',
  'model': 'Set active model  /model <model-id>',
  'system': 'Set system prompt  /system <prompt>',
  'skill': 'Apply a skill  /skill <name>',
  'clear': 'Clear the screen',
  'tools': 'List available tools',
  'compact': 'Compact conversation history',

  // ── New commands ──
  'add-dir': 'Add a working directory  /add-dir <path>',
  'cd': 'Change working directory  /cd <path>',
  'config': 'Set a setting  /config <key=value>',
  'context': 'Show context usage breakdown',
  'copy': 'Copy last assistant response  /copy [N]',
  'cost': 'Show cumulative token usage',
  'diff': 'Show git diff in project',
  'focus': 'Toggle focus mode',
  'goal': 'Set a session goal  /goal <condition|clear>',
  'hooks': 'View tool hook configurations',
  'init': 'Initialize project with guide',
  'mcp': 'MCP server management  /mcp <connect|list|disconnect>',
  'memory': 'View or edit session memory',
  'permissions': 'Manage tool permission rules',
  'plan': 'Enter plan mode  /plan [description]',
  'release-notes': 'Show version information',
  'reload-skills': 'Reload skills from disk',
  'rewind': 'Undo the last exchange',
  'stop': 'Stop the current response',
  'status': 'Show session status',
  'theme': 'Change color theme  /theme <name>',
  'undo': 'Undo the last exchange',
  'usage': 'Show detailed token usage',
};

const HISTORY_FILE = path.join(paths.userData, 'cli', 'history.txt');
const MAX_HISTORY = 1000;

// ── In-memory session state ───────────────────────────────────────────
const sessionUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
let sessionGoal: string | undefined;
let sessionFocusMode = false;
const sessionAddedDirs: string[] = [];
let sessionPlanMode = false;
let sessionMemory: string[] = [];
let sessionLastContent = '';
let currentAbortController: AbortController | null = null;

// ── History helpers ───────────────────────────────────────────────────
function loadHistory(): string[] {
  try {
    if (existsSync(HISTORY_FILE)) {
      return readFileSync(HISTORY_FILE, 'utf-8').split('\n').filter(Boolean).reverse();
    }
  } catch { /* ignore */ }
  return [];
}

function saveHistory(history: string[] | undefined): void {
  if (!history) return;
  try {
    const dir = path.dirname(HISTORY_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(HISTORY_FILE, history.slice(0, MAX_HISTORY).reverse().join('\n') + '\n');
  } catch { /* ignore */ }
}

// ── Main export ───────────────────────────────────────────────────────
export function startChatRepl(oneShotPrompt?: string, options?: {
  project?: string;
  provider?: string;
  model?: string;
  system?: string;
  conversation?: string;
  cwd?: string;
}): Promise<void> {
  return runChatSession(oneShotPrompt || undefined, options || {});
}

function classicSystemPrompt(basePrompt: string | undefined): string | undefined {
  const sections = [
    basePrompt?.trim(),
    sessionGoal ? `Current session goal: ${sessionGoal}` : '',
    sessionPlanMode ? 'Plan mode is enabled. Use only read-only inspection tools and return a numbered plan. Do not modify files or run state-changing actions.' : '',
    sessionMemory.length ? `Session memory:\n${sessionMemory.map((item) => `- ${item}`).join('\n')}` : '',
    sessionAddedDirs.length ? `Additional user-approved context directories:\n${sessionAddedDirs.map((item) => `- ${item}`).join('\n')}` : ''
  ].filter(Boolean);
  return sections.length ? sections.join('\n\n') : undefined;
}

// ── Session logic ─────────────────────────────────────────────────────
async function runChatSession(oneShotPrompt?: string, options: {
  project?: string;
  provider?: string;
  model?: string;
  system?: string;
  conversation?: string;
  cwd?: string;
} = {}): Promise<void> {
  await initHive();
  try {
    const state = config.loadState();
    if (state.currentModelId && state.currentModelId === 'unknown') {
      state.currentModelId = undefined;
    }
    if (!state.currentProviderId || !state.currentModelId) {
      state.currentProviderId = undefined;
      state.currentModelId = undefined;
    }
    sessionGoal = state.goal;
    sessionFocusMode = state.focusMode || false;
    sessionPlanMode = state.planMode || false;
    sessionAddedDirs.splice(0, sessionAddedDirs.length, ...(state.addedDirs || []));

    let providerId = options.provider || state.currentProviderId;
    let modelId = options.model || state.currentModelId;
    if (!providerId || !modelId) {
      const defaults = config.getDefaultProvider();
      providerId = providerId || defaults.providerId;
      modelId = modelId || defaults.modelId;
    }
    if (!providerId || !modelId) {
      const providers = listProviders().filter((p) => p.enabled);
      if (providers.length === 0) {
        format.printError('No providers configured. Run `hive provider add` first.');
        if (oneShotPrompt) process.exitCode = 1;
        return;
      }
      providerId = providers[0].id;
      modelId = providers[0].models[0]?.id || '';
    }

    let conversationId = options.conversation;
    const launchCwd = options.cwd || process.env.HIVE_LAUNCH_CWD;
    let currentProjectPath = launchCwd && existsSync(launchCwd)
      ? path.resolve(launchCwd)
      : state.currentProjectPath || getDefaultWorkspace();
    const projectDir = (): string => state.currentProjectPath || currentProjectPath;
    if (!conversationId) {
      const convs = conversationService.listConversations();
      if (convs.length > 0) {
        conversationId = convs[0].id;
        if (!state.currentProviderId && convs[0].providerId) {
          providerId = convs[0].providerId;
          modelId = (convs[0].model && convs[0].model !== 'unknown') ? convs[0].model : modelId;
        }
      } else {
        conversationId = conversationService.createConversation({
          providerId, model: modelId,
          systemPrompt: options.system,
          projectId: options.project
        }).id;
      }
    }
    // If a project option was given, also resolve its path
    if (options.project) {
      const proj = projectService.getProject(options.project);
      if (proj) currentProjectPath = proj.path;
    }

    state.currentProviderId = providerId;
    state.currentModelId = modelId;
    state.currentConversationId = conversationId;
    state.currentProjectPath = currentProjectPath;
    config.setSettingDirect('workingDirectory', currentProjectPath);
    config.saveState(state);

    if (oneShotPrompt) {
      const ok = await sendMessage(conversationId!, oneShotPrompt, providerId!, modelId!, currentProjectPath, classicSystemPrompt(state.systemPrompt));
      if (!ok) process.exitCode = 1;
      return;
    }

    const conv = conversationService.getConversation(conversationId);
    const convTitle = conv?.title || 'New chat';
    console.log(chalk.cyan('\n  Hive CLI  ') + chalk.gray('— type messages, /help for commands'));
    console.log(chalk.gray(`  ${providerId}/${modelId}  ·  ${convTitle}`));
    if (sessionGoal) console.log(chalk.yellow(`  [goal] ${sessionGoal}`));

    const existingMessages = conversationService.getMessages(conversationId);
    for (const msg of existingMessages) {
      printMessage(msg);
    }

    // ── Readline REPL ──
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
      completer: (line: string): [string[], string] => {
        const hits: string[] = [];
        if (line.startsWith('/')) {
          const input = line.slice(1).toLowerCase();
          for (const cmd of Object.keys(SLASH_COMMANDS)) {
            if (cmd.startsWith(input)) {
              hits.push('/' + cmd);
            }
          }
        }
        const prefix = line.startsWith('/') ? '/' + line.slice(1) : line;
        return [hits.length ? hits : Object.keys(SLASH_COMMANDS).map((c) => '/' + c), prefix];
      }
    });

    rl.on('SIGINT', () => {
      if (currentAbortController) {
        currentAbortController.abort();
        currentAbortController = null;
        process.stdout.write('\n');
      } else {
        rl.close();
      }
    });

    rl.setPrompt(chalk.green('> '));
    (rl as unknown as { history: string[] }).history = loadHistory();

    let inputBuffer: string[] = [];
    let inputTimer: ReturnType<typeof setTimeout> | null = null;

    function flushInput(): void {
      if (inputBuffer.length === 0) return;
      const text = inputBuffer.join('\n');
      inputBuffer = [];
      inputTimer = null;
      processInput(text);
    }

    async function processInput(text: string): Promise<void> {
      const trimmed = text.trim();
      if (!trimmed) { rl.prompt(); return; }

      if (trimmed.startsWith('/')) {
        const handled = await handleSlashCommand(trimmed, state, conversationId!, providerId!, modelId!, projectDir());
        if (handled === 'quit') { rl.close(); return; }
        if (handled === 'new') {
          conversationId = conversationService.createConversation({
            providerId, model: modelId,
            projectId: state.currentProjectId
          }).id;
          state.currentConversationId = conversationId;
          config.saveState(state);
          console.log(chalk.gray(`  New conversation created.`));
        }
        if (handled === 'refresh') {
          // State may have been updated by a command (e.g. /cd, /plan)
          config.saveState(state);
        }
        const refreshed = config.loadState();
        Object.assign(state, refreshed);
        providerId = refreshed.currentProviderId || providerId;
        modelId = refreshed.currentModelId || modelId;
        if (handled !== 'new' && refreshed.currentConversationId && refreshed.currentConversationId !== conversationId) {
          conversationId = refreshed.currentConversationId;
        }
        currentProjectPath = refreshed.currentProjectPath || currentProjectPath;
        config.setSettingDirect('workingDirectory', currentProjectPath);
        rl.prompt();
        return;
      }

      rl.pause();
      await sendMessage(conversationId!, trimmed, providerId!, modelId!, projectDir(), classicSystemPrompt(state.systemPrompt));
      rl.resume();
      rl.prompt();
    }

    rl.on('line', (line: string) => {
      inputBuffer.push(line);
      if (inputTimer) clearTimeout(inputTimer);
      inputTimer = setTimeout(flushInput, 40);
    });

    rl.prompt();

    await new Promise<void>((resolve) => {
      rl.on('close', () => resolve());
    });

    if (inputTimer) { clearTimeout(inputTimer); flushInput(); }
    saveHistory((rl as unknown as { history?: string[] }).history);
    console.log(chalk.gray('Goodbye.'));
  } finally {
    await shutdownHive();
  }
}

// ── Display helpers ───────────────────────────────────────────────────
function showConversationList(): void {
  const convs = conversationService.listConversations();
  if (convs.length === 0) { format.printInfo('No conversations.'); return; }
  for (const c of convs) {
    const date = new Date(c.updatedAt).toLocaleString();
    const preview = c.preview ? c.preview.slice(0, 60) : '';
    const tag = c.id === conversationIdRef ? chalk.green(' *') : '';
    console.log(`  ${chalk.bold(c.id.slice(0, 8))}${tag}  ${chalk.cyan(c.title)}  ${chalk.gray(`${c.messageCount} msgs, ${date}`)}`);
    if (preview) console.log(`         ${chalk.gray(preview)}`);
  }
}

let conversationIdRef = '';

function printMessage(msg: Message): void {
  const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content, null, 2);
  if (msg.role === 'user') {
    console.log(chalk.green('\n  You  ') + content);
  } else if (msg.role === 'assistant') {
    const rendered = content ? format.renderMarkdown(content) : '';
    console.log(chalk.magenta('\n  Assistant'));
    if (rendered) console.log(rendered);
    if (msg.toolCalls?.length) {
      for (const tc of msg.toolCalls) {
        console.log(chalk.yellow(`  [tool] ${tc.function.name}(${tc.function.arguments})`));
      }
    }
    if (msg.usage) {
      const u = msg.usage;
      console.log(chalk.gray(`  [tokens] ${u.totalTokens} (${u.promptTokens} in / ${u.completionTokens} out)`));
    }
  } else if (msg.role === 'tool') {
    const snippet = content.length > 200 ? content.slice(0, 200) + '...' : content;
    console.log(chalk.gray(`  [result] ${msg.name}: ${snippet}`));
  }
}

export function chatCommand(): Command {
  return new Command('chat')
    .description('Start an interactive chat or send a one-shot message')
    .argument('[prompt]', 'Optional prompt for a one-shot chat')
    .option('--project <id>', 'Project id')
    .option('--provider <id>', 'Provider id')
    .option('--model <model>', 'Model id')
    .option('--system <prompt>', 'System prompt')
    .option('--conversation <id>', 'Resume a conversation')
    .option('-C, --cwd <path>', 'Workspace directory')
    .action(async (prompt: string | undefined, options) => {
      await startChatRepl(prompt, options);
    });
}

// ── Core sendMessage ──────────────────────────────────────────────────
async function sendMessage(
  conversationId: string,
  prompt: string,
  providerId: string,
  model: string,
  cwd: string,
  systemPrompt?: string
): Promise<boolean> {
  const { tools } = getContext();
  const messages = conversationService.getMessages(conversationId);
  const userMsg: Message = {
    id: randomUUID(),
    role: 'user',
    content: prompt,
    createdAt: Date.now()
  };
  messages.push(userMsg);

  console.log(chalk.green('\n  You  ') + prompt);

  const abort = new AbortController();
  currentAbortController = abort;
  printTooltip('thinking...');

  let content = '';
  let firstDelta = true;
  let hadToolCalls = false;
  let turnUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let failed = false;

  try {
    await runChat(
      {
        conversationId,
        providerId,
        model,
        messages,
        systemPrompt,
        planMode: sessionPlanMode || undefined
      },
      {
        tools,
        cwd,
        signal: abort.signal,
        onEvent: (event) => {
          if (event.type === 'delta' && event.content) {
            if (firstDelta) {
              clearTooltip();
              firstDelta = false;
              process.stdout.write(chalk.magenta('\n  Assistant'));
            }
            content += event.content;
            process.stdout.write(event.content);
          } else if (event.type === 'tool_calls') {
            if (!hadToolCalls) {
              if (firstDelta) clearTooltip();
              firstDelta = false;
              hadToolCalls = true;
            }
          } else if (event.type === 'usage') {
            turnUsage = event.usage;
          } else if (event.type === 'error') {
            failed = true;
            clearTooltip();
            format.printError(event.error);
          }
        },
        onToolResult: (info) => {
          const argsStr = JSON.stringify(info.args).slice(0, 100);
          const resultSnippet = info.result.content.length > 200
            ? info.result.content.slice(0, 200) + '...'
            : info.result.content;
          console.log(chalk.yellow(`  [tool] ${info.toolName}(${argsStr})`));
          if (info.result.isError) {
            console.log(chalk.red(`  [error] ${resultSnippet}`));
          } else {
            console.log(chalk.gray(`  [result] ${resultSnippet}`));
          }
        }
      }
    );

    if (firstDelta) clearTooltip();
    if (content) process.stdout.write('\n\n');

    // Track cumulative usage
    if (turnUsage.totalTokens > 0) {
      sessionUsage.promptTokens += turnUsage.promptTokens;
      sessionUsage.completionTokens += turnUsage.completionTokens;
      sessionUsage.totalTokens += turnUsage.totalTokens;
      console.log(chalk.gray(`  [tokens] ${turnUsage.totalTokens} (${turnUsage.promptTokens} in / ${turnUsage.completionTokens} out)`));
    }
    sessionLastContent = content;
  } catch (err) {
    failed = true;
    clearTooltip();
    if ((err as Error)?.name === 'AbortError' || (err as { code?: string })?.code === 'ABORT_ERR') {
      console.log(chalk.gray('\n  Cancelled.'));
    } else {
      format.printError(`Chat failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  } finally {
    currentAbortController = null;
  }
  return !failed;
}

function printTooltip(text: string): void {
  process.stdout.write(chalk.gray(`  ${text}`));
}

function clearTooltip(): void {
  process.stdout.write('\r\x1b[K');
}

// ── Slash command handlers ────────────────────────────────────────────
async function handleSlashCommand(
  prompt: string,
  state: config.CliState,
  conversationId: string,
  providerId: string,
  modelId: string,
  cwd: string,
): Promise<'handled' | 'quit' | 'new' | 'refresh'> {
  const [command, ...args] = prompt.slice(1).split(' ');
  const arg = args.join(' ');
  conversationIdRef = conversationId;

  switch (command) {
    // ── Existing commands ──
    case 'help':
      console.log(chalk.bold('\nAvailable commands:'));
      console.log(format.table(Object.entries(SLASH_COMMANDS).map(([k, v]) => [`/${k}`, v])));
      console.log(chalk.gray('\nTip: Most settings are managed through /config. Use /context to see token usage.\n'));
      break;

    case 'quit':
    case 'exit':
      return 'quit';

    case 'new':
      return 'new';

    case 'list':
    case 'sessions':
      showConversationList();
      break;

    case 'rename': {
      if (!arg) { format.printError('Usage: /rename <new title>'); break; }
      conversationService.updateConversationTitle(conversationId, arg);
      format.printSuccess(`Renamed to "${arg}"`);
      break;
    }

    case 'delete': {
      const targetId = arg || conversationId;
      const conv = conversationService.getConversation(targetId);
      if (!conv) { format.printError(`Conversation ${targetId} not found`); break; }
      conversationService.deleteConversation(targetId);
      format.printSuccess(`Deleted: ${conv.title}`);
      if (targetId === conversationId) {
        format.printInfo('Deleted active conversation. Use /new to start fresh.');
      }
      break;
    }

    case 'search': {
      if (!arg) { format.printError('Usage: /search <query>'); break; }
      const results = conversationService.searchConversations(arg);
      if (results.length === 0) { format.printInfo('No matches.'); break; }
      for (const r of results) {
        console.log(`  ${chalk.bold(r.conversationId.slice(0, 8))}  ${r.snippet}`);
      }
      break;
    }

    case 'export': {
      const targetId = arg || conversationId;
      const conv = conversationService.getConversation(targetId);
      if (!conv) { format.printError(`Conversation ${targetId} not found`); break; }
      const msgs = conversationService.getMessages(targetId);
      let md = `# ${conv.title || 'Conversation'}\n\n`;
      md += `Provider: ${conv.providerId || 'N/A'} / ${conv.model || 'N/A'}\n\n---\n\n`;
      for (const m of msgs) {
        const label = m.role === 'user' ? 'You' : m.role === 'assistant' ? 'AI' : 'Tool';
        const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content, null, 2);
        md += `### ${label}\n\n${c}\n\n`;
      }
      const outFile = path.join(paths.userData, 'cli', `export-${targetId.slice(0, 8)}.md`);
      mkdirSync(path.dirname(outFile), { recursive: true });
      writeFileSync(outFile, md);
      format.printSuccess(`Exported to ${outFile}`);
      break;
    }

    case 'fork': {
      const forked = conversationService.forkConversation(conversationId);
      if (forked) {
        state.currentConversationId = forked.id;
        config.saveState(state);
        format.printSuccess(`Forked to ${forked.id}`);
      }
      break;
    }

    case 'project': {
      const projects = projectService.listProjects();
      if (projects.length === 0) {
        format.printError('No projects. Use `hive project add`.');
      } else {
        const { select } = await import('@inquirer/prompts');
        const id = await select({
          message: 'Select project',
          choices: projects.map((p) => ({ value: p.id, name: `${p.icon} ${p.name}` }))
        });
        state.currentProjectId = id;
        const proj = projectService.getProject(id);
        if (proj) state.currentProjectPath = proj.path;
        config.saveState(state);
        format.printSuccess(`Project set to ${id}`);
      }
      break;
    }

    case 'provider': {
      const providers = listProviders().filter((p) => p.enabled);
      const { select } = await import('@inquirer/prompts');
      const chosen = await select({
        message: 'Choose provider/model',
        choices: providers.flatMap((p) => p.models.map((m) => ({ value: `${p.id}:${m.id}`, name: `${p.name} / ${m.name}` })))
      });
      const [pid, mid] = chosen.split(':') as [string, string];
      state.currentProviderId = pid;
      state.currentModelId = mid;
      conversationService.updateConversation(conversationId, { providerId: pid, model: mid });
      config.saveState(state);
      format.printSuccess(`Provider set to ${pid}/${mid}`);
      break;
    }

    case 'model': {
      if (!arg) { format.printError('Usage: /model <model-id>'); break; }
      state.currentModelId = arg;
      conversationService.updateConversation(conversationId, { model: arg });
      config.saveState(state);
      format.printSuccess(`Model set to ${arg}`);
      break;
    }

    case 'system': {
      state.systemPrompt = arg || undefined;
      config.saveState(state);
      format.printSuccess('System prompt updated');
      break;
    }

    case 'skill': {
      if (!arg) { format.printError('Usage: /skill <skill-name>'); break; }
      const skills = [...loadBundledSkills(), ...loadUserSkills()];
      const skill = skills.find((s) => s.slashCommand === `/${arg}` || s.name === arg);
      if (!skill) { format.printError(`Skill "${arg}" not found. Use /skills to list.`); break; }
      state.systemPrompt = skill.prompt;
      config.saveState(state);
      format.printSuccess(`Applied skill: ${skill.name}`);
      break;
    }

    case 'clear':
      console.clear();
      break;

    case 'tools': {
      const { tools } = getContext();
      const list = tools.listTools();
      for (const t of list) {
        console.log(`${t.source} ${chalk.bold(t.name)}: ${t.description}`);
      }
      break;
    }

    case 'compact': {
      const result = conversationService.compactConversation(conversationId, 8, arg || undefined);
      if (result.removedCount) format.printSuccess(`Compacted ${result.removedCount} messages and freed about ${result.tokensSaved} tokens.`);
      else format.printInfo('There is not enough history to compact.');
      break;
    }

    case 'settings': {
      const rows = getDb().prepare('SELECT key, value FROM settings ORDER BY key').all() as Array<{ key: string; value: string }>;
      if (rows.length === 0) { format.printInfo('No settings.'); break; }
      for (const row of rows) {
        console.log(`  ${chalk.bold(row.key)}: ${row.value.slice(0, 200)}`);
      }
      break;
    }

    case 'file': {
      if (!arg) { format.printError('Usage: /file <path>'); break; }
      try {
        const data = readFileSync(path.resolve(arg));
        const b64 = data.toString('base64');
        const userMsg: Message = {
          id: randomUUID(),
          role: 'user',
          content: [
            { type: 'text', text: `Attached file: ${arg}` },
            { type: 'file', file: { filename: path.basename(arg), data: b64, mimeType: 'application/octet-stream' } }
          ],
          createdAt: Date.now()
        };
        conversationService.persistMessage(conversationId, userMsg);
        format.printSuccess(`File attached: ${arg}`);
      } catch (err) {
        format.printError(`Failed to attach file: ${err instanceof Error ? err.message : String(err)}`);
      }
      break;
    }

    // ── New commands ─────────────────────────────────────────────────

    case 'add-dir': {
      if (!arg) { format.printError('Usage: /add-dir <path>'); break; }
      const resolved = path.resolve(arg);
      if (!existsSync(resolved)) { format.printError(`Directory not found: ${resolved}`); break; }
      if (!sessionAddedDirs.includes(resolved)) sessionAddedDirs.push(resolved);
      format.printSuccess(`Added directory: ${resolved}`);
      state.addedDirs = sessionAddedDirs;
      config.saveState(state);
      break;
    }

    case 'cd': {
      if (!arg) { format.printError('Usage: /cd <path>'); break; }
      const cdTarget = path.resolve(arg);
      if (!existsSync(cdTarget)) { format.printError(`Directory not found: ${cdTarget}`); break; }
      if (!existsSync(path.join(cdTarget, '.git')) && !existsSync(path.join(cdTarget, 'package.json'))) {
        const { confirm } = await import('@inquirer/prompts');
        const ok = await confirm({ message: `"${cdTarget}" doesn't look like a project. Proceed?`, default: false });
        if (!ok) break;
      }
      state.currentProjectPath = cdTarget;
      config.saveState(state);
      format.printSuccess(`Working directory changed to ${cdTarget}`);
      return 'refresh';
    }

    case 'config': {
      if (!arg) {
        // Show current config
        const appSettings = config.getSettingDirect<Record<string, unknown>>('appSettings') || {};
        console.log(chalk.bold('Settings:'));
        for (const [k, v] of Object.entries(appSettings)) {
          console.log(`  ${chalk.cyan(k)} = ${JSON.stringify(v)}`);
        }
        break;
      }
      const eq = arg.indexOf('=');
      if (eq === -1) { format.printError('Usage: /config <key>=<value>'); break; }
      const key = arg.slice(0, eq).trim();
      let val: unknown = arg.slice(eq + 1).trim();
      try { val = JSON.parse(val as string); } catch { /* keep as string */ }
      const appCfg = config.getSettingDirect<Record<string, unknown>>('appSettings') || {};
      appCfg[key] = val;
      config.setSettingDirect('appSettings', appCfg);
      format.printSuccess(`Set ${key} = ${JSON.stringify(val)}`);
      break;
    }

    case 'context': {
      const convMsgs = conversationService.getMessages(conversationId);
      const totalChars = convMsgs.reduce((s, m) => s + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length), 0);
      const estimatedTokens = Math.round(totalChars / 3.5);
      console.log(chalk.bold('\nContext usage:'));
      console.log(`  Messages:     ${convMsgs.length}`);
      console.log(`  Est. tokens:  ${chalk.cyan(String(estimatedTokens))}`);
      console.log(`  Characters:   ${totalChars.toLocaleString()}`);
      console.log(`  Session usage: ${sessionUsage.totalTokens} total (${sessionUsage.promptTokens} prompt / ${sessionUsage.completionTokens} completion)`);
      const modelCfg = listProviders()
        .filter((p) => p.enabled)
        .flatMap((p) => p.models)
        .find((m) => m.id === modelId);
      if (modelCfg?.contextWindow) {
        const pct = Math.round((estimatedTokens / modelCfg.contextWindow) * 100);
        console.log(`  Context window: ${modelCfg.contextWindow.toLocaleString()} (${pct}% used)`);
        const barLen = 30;
        const filled = Math.round((pct / 100) * barLen);
        console.log(`  [${'█'.repeat(filled)}${'░'.repeat(barLen - filled)}]`);
      }
      break;
    }

    case 'copy': {
      if (!sessionLastContent) { format.printError('No assistant response to copy.'); break; }
      const n = arg ? parseInt(arg, 10) : 1;
      if (isNaN(n) || n < 1) { format.printError('Usage: /copy [N] (N must be a positive number)'); break; }
      // Get the Nth-latest assistant message
      const allMsgs = conversationService.getMessages(conversationId);
      const assistantMsgs = allMsgs.filter((m) => m.role === 'assistant').reverse();
      const target = assistantMsgs[n - 1];
      if (!target) { format.printError(`Only ${assistantMsgs.length} assistant message(s) available.`); break; }
      const text = typeof target.content === 'string' ? target.content : JSON.stringify(target.content);
      try {
        const { execSync } = await import('node:child_process');
        execSync('clip', { input: text });
        format.printSuccess(`Copied to clipboard.`);
      } catch {
        // Fallback: print to stdout for manual copy
        console.log(chalk.gray('\n--- copy content ---'));
        console.log(text);
        console.log(chalk.gray('--- end copy ---'));
      }
      break;
    }

    case 'cost':
    case 'usage': {
      console.log(chalk.bold('\nUsage:'));
      console.log(`  Prompt tokens:     ${sessionUsage.promptTokens.toLocaleString()}`);
      console.log(`  Completion tokens: ${sessionUsage.completionTokens.toLocaleString()}`);
      console.log(`  Total tokens:      ${chalk.cyan(sessionUsage.totalTokens.toLocaleString())}`);
      // Estimate cost at ~$3/M input, $15/M output (rough Claude Sonnet pricing)
      const inputCost = (sessionUsage.promptTokens / 1_000_000) * 3;
      const outputCost = (sessionUsage.completionTokens / 1_000_000) * 15;
      const totalCost = inputCost + outputCost;
      if (totalCost > 0) {
        console.log(chalk.gray(`  Est. cost:         $${totalCost.toFixed(4)} (input: $${inputCost.toFixed(4)}, output: $${outputCost.toFixed(4)})`));
      }
      break;
    }

    case 'diff': {
      const dir = state.currentProjectPath || cwd;
      if (!existsSync(path.join(dir, '.git'))) {
        format.printError('Not a git repository.');
        break;
      }
      try {
        const diff = execSync('git diff', { cwd: dir, encoding: 'utf-8', timeout: 10000 });
        if (!diff.trim()) {
          format.printInfo('No uncommitted changes.');
          break;
        }
        // Show summary
        const files = execSync('git diff --stat', { cwd: dir, encoding: 'utf-8', timeout: 5000 });
        console.log(chalk.bold('\nUncommitted changes:'));
        console.log(chalk.gray(files.trim()));
        // Show first 2000 chars of diff
        if (diff.length > 2000) {
          console.log(chalk.gray(diff.slice(0, 2000) + '...'));
          console.log(chalk.gray(`  (${diff.length} total chars — truncated)`));
        } else {
          console.log(chalk.gray(diff));
        }
      } catch (err) {
        format.printError(`Git diff failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      break;
    }

    case 'focus': {
      sessionFocusMode = !sessionFocusMode;
      state.focusMode = sessionFocusMode;
      config.saveState(state);
      format.printSuccess(sessionFocusMode ? 'Focus mode ON' : 'Focus mode OFF');
      break;
    }

    case 'goal': {
      if (!arg || arg === 'clear' || arg === 'off' || arg === 'stop' || arg === 'cancel' || arg === 'reset' || arg === 'none') {
        sessionGoal = undefined;
        state.goal = undefined;
        config.saveState(state);
        format.printSuccess('Goal cleared.');
      } else {
        sessionGoal = arg;
        state.goal = arg;
        config.saveState(state);
        format.printSuccess(`Goal set: ${arg}`);
      }
      break;
    }

    case 'hooks': {
      const { tools } = getContext();
      const rules = tools.listRules();
      if (rules.length === 0) { format.printInfo('No hook configurations.'); break; }
      console.log(chalk.bold('Permission rules:'));
      for (const r of rules) {
        console.log(`  ${chalk.cyan(r.toolName)} → ${r.action} ${r.scope ? `(scope: ${r.scope})` : ''}`);
      }
      break;
    }

    case 'init': {
      const dir = state.currentProjectPath || cwd;
      const guideFile = path.join(dir, 'CLAUDE.md');
      if (existsSync(guideFile)) {
        format.printInfo(`CLAUDE.md already exists at ${guideFile}`);
        const { confirm } = await import('@inquirer/prompts');
        const ok = await confirm({ message: 'Overwrite?', default: false });
        if (!ok) break;
      }
      const content = `# ${path.basename(dir)} — Project Guide

## Build / Test / Lint
- \`npm run build\`
- \`npm run dev\`
- \`npm run typecheck\`
- \`npm run lint\`

## Project structure
- \`src/\` — source code

## Coding conventions
- Use TypeScript strict mode
- Prefer functional components with hooks
- Run typecheck before committing
`;
      writeFileSync(guideFile, content, 'utf-8');
      format.printSuccess(`Created ${guideFile}`);
      break;
    }

    case 'mcp': {
      const { mcpManager } = await import('../utils/init.js').then((m) => m.getContext());
      const sub = args[0] || '';
      if (sub === 'list' || !sub) {
        const statuses = mcpManager.getStatuses();
        if (statuses.length === 0) { format.printInfo('No MCP servers configured.'); break; }
        for (const s of statuses) {
          const st = s.connected ? chalk.green('connected') : s.error ? chalk.red(`error: ${s.error}`) : chalk.gray('disconnected');
          console.log(`  ${chalk.bold(s.name)}: ${st} (${s.tools.length} tools)`);
        }
      } else if (sub === 'connect') {
        const id = args[1];
        if (!id) { format.printError('Usage: /mcp connect <server-id>'); break; }
        try {
          const configs = await mcpManager.listConfigs();
          const cfg = configs.find((c) => c.id === id);
          if (!cfg) { format.printError(`Server ${id} not found`); break; }
          await mcpManager.connect(cfg);
          format.printSuccess(`Connected ${id}`);
        } catch (err) {
          format.printError(`Connect failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else if (sub === 'disconnect') {
        const id = args[1];
        if (!id) { format.printError('Usage: /mcp disconnect <server-id>'); break; }
        await mcpManager.disconnect(id);
        format.printSuccess(`Disconnected ${id}`);
      } else {
        format.printError('Usage: /mcp [list|connect <id>|disconnect <id>]');
      }
      break;
    }

    case 'memory': {
      if (!arg) {
        if (sessionMemory.length === 0) { format.printInfo('No session memory. Use /memory <text> to add a note.'); break; }
        console.log(chalk.bold('Session memory:'));
        for (let i = 0; i < sessionMemory.length; i++) {
          console.log(`  ${i + 1}. ${sessionMemory[i]}`);
        }
      } else if (arg.startsWith('delete ') || arg.startsWith('rm ')) {
        const idx = parseInt(arg.split(' ')[1], 10) - 1;
        if (isNaN(idx) || idx < 0 || idx >= sessionMemory.length) {
          format.printError(`Invalid index. Use /memory to list.`);
        } else {
          const removed = sessionMemory.splice(idx, 1);
          format.printSuccess(`Removed: ${removed}`);
        }
      } else if (arg === 'clear') {
        sessionMemory = [];
        format.printSuccess('Memory cleared.');
      } else {
        sessionMemory.push(arg);
        format.printSuccess(`Added to memory (${sessionMemory.length} note(s))`);
      }
      break;
    }

    case 'permissions': {
      const { tools } = getContext();
      const rules = tools.listRules();
      if (rules.length === 0 && arg !== 'add') {
        console.log(chalk.bold('Permission rules:'));
        format.printInfo('No rules configured. Use /permissions add <tool> <allow|deny|ask> to add one.');
      }
      if (arg === 'add') {
        const toolName = args[1];
        const action = args[2] as 'allow' | 'deny' | 'ask';
        if (!toolName || !action || !['allow', 'deny', 'ask'].includes(action)) {
          format.printError('Usage: /permissions add <tool-name> <allow|deny|ask>');
          break;
        }
        tools.saveRule({
          id: randomUUID(),
          toolName,
          action,
          scope: 'global'
        });
        format.printSuccess(`Rule added: ${toolName} → ${action}`);
      } else if (arg === 'list' || !arg) {
        console.log(chalk.bold('Permission rules:'));
        for (const r of rules) {
          console.log(`  ${chalk.cyan(r.toolName)} → ${chalk.bold(r.action)}${r.scope ? ` (${r.scope})` : ''}`);
        }
      } else {
        format.printError('Usage: /permissions [list|add <tool> <allow|deny|ask>]');
      }
      break;
    }

    case 'plan': {
      if (arg === 'off' || arg === 'stop' || arg === 'end') {
        sessionPlanMode = false;
        state.planMode = false;
        config.saveState(state);
        format.printSuccess('Plan mode OFF.');
      } else {
        sessionPlanMode = true;
        state.planMode = true;
        config.saveState(state);
        if (arg) {
          format.printSuccess(`Plan mode ON — now describe "${arg}" to plan it.`);
        } else {
          format.printSuccess('Plan mode ON — describe what you want to plan.');
        }
      }
      break;
    }

    case 'release-notes': {
      console.log(`Hive CLI v${APP_VERSION}`);
      console.log('Type /help for available commands.');
      break;
    }

    case 'reload-skills': {
      try {
        const bundled = loadBundledSkills();
        const user = loadUserSkills();
        format.printSuccess(`Reloaded ${bundled.length} built-in + ${user.length} user skills.`);
      } catch (err) {
        format.printError(`Reload failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      break;
    }

    case 'rewind':
    case 'undo': {
      const removed = conversationService.removeLastExchange(conversationId);
      if (!removed) format.printError('Nothing to rewind.');
      else format.printSuccess(`Removed ${removed} message(s).`);
      break;
    }

    case 'stop': {
      if (currentAbortController) {
        currentAbortController.abort();
        currentAbortController = null;
        format.printSuccess('Response stopped.');
      } else {
        format.printInfo('No active response to stop.');
      }
      break;
    }

    case 'status': {
      const conv = conversationService.getConversation(conversationId);
      console.log(chalk.bold('\nSession status:'));
      console.log(`  Provider:  ${providerId}`);
      console.log(`  Model:     ${modelId}`);
      console.log(`  Directory: ${state.currentProjectPath || cwd}`);
      console.log(`  Tokens:    ${sessionUsage.totalTokens} total`);
      console.log(`  Messages:  ${conv?.messageCount || 0}`);
      console.log(`  Goal:      ${sessionGoal || '(none)'}`);
      console.log(`  Focus:     ${sessionFocusMode ? 'ON' : 'OFF'}`);
      console.log(`  Plan mode: ${sessionPlanMode ? 'ON' : 'OFF'}`);
      if (sessionMemory.length) console.log(`  Memory:    ${sessionMemory.length} note(s)`);
      if (sessionAddedDirs.length) console.log(`  Added dirs: ${sessionAddedDirs.length}`);
      break;
    }

    case 'theme': {
      const themes: Record<string, string> = {
        cyan: 'Cyan (default)',
        red: 'Red',
        green: 'Green',
        yellow: 'Yellow',
        blue: 'Blue',
        magenta: 'Magenta',
        white: 'White',
        gray: 'Gray',
        default: 'Default'
      };
      if (!arg || arg === 'default') {
        state.theme = undefined;
        format.printSuccess('Theme reset to default.');
      } else if (themes[arg]) {
        state.theme = arg;
        config.saveState(state);
        format.printSuccess(`Theme set to ${arg}. Restart to apply.`);
      } else {
        console.log(chalk.bold('Available themes:'));
        for (const [name, desc] of Object.entries(themes)) {
          const marker = state.theme === name ? ' *' : '';
          console.log(`  ${name}${marker} — ${desc}`);
        }
      }
      break;
    }

    default:
      format.printError(`Unknown command: /${command}. Type /help for commands.`);
  }
  return 'handled';
}
