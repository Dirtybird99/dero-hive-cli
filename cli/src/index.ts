#!/usr/bin/env node
import { Command } from 'commander';
import { shutdownHive } from './utils/init.js';
import { chatCommand, startChatRepl } from './commands/chat.js';
import { providerCommand } from './commands/provider.js';
import { projectCommand } from './commands/project.js';
import { conversationCommand } from './commands/conversation.js';
import { mcpCommand } from './commands/mcp.js';
import { toolCommand } from './commands/tool.js';
import { settingsCommand } from './commands/settings.js';
import { simulatorCommand } from './commands/simulator.js';
import { skillCommand } from './commands/skill.js';
import { doctorCommand } from './commands/doctor.js';
import { startTui } from './tui/index.js';
import * as config from './utils/config.js';
import * as conversationService from './services/conversation.js';
import { listProviders } from '../../src/main/providers/registry.js';
import { APP_VERSION } from '../../src/shared/version.js';
import { resolve as resolvePath } from 'node:path';

const program = new Command()
  .name('hive')
  .description('DERO Hive — terminal-native AI coding workspace')
  .version(APP_VERSION, '-v, --version', 'Show version')
  .option('-d, --data-dir <path>', 'Override Hive data directory')
  .option('-p, --project <id>', 'Project id to use as working context')
  .option('--provider <id>', 'Provider id')
  .option('-m, --model <model>', 'Model id')
  .option('--system <prompt>', 'System prompt override')
  .option('-c, --conversation <id>', 'Resume a conversation by id')
  .option('-C, --cwd <path>', 'Workspace directory (defaults to the launch folder)')
  .option('--classic', 'Use the line-oriented interface instead of the full-screen TUI');

program.addCommand(chatCommand());
program.addCommand(providerCommand());
program.addCommand(projectCommand());
program.addCommand(conversationCommand());
program.addCommand(mcpCommand());
program.addCommand(toolCommand());
program.addCommand(settingsCommand());
program.addCommand(simulatorCommand());
program.addCommand(skillCommand());
program.addCommand(doctorCommand());

program
  .action(async () => {
    const opts = program.opts();
    const launchOptions = {
      project: opts.project,
      provider: opts.provider,
      model: opts.model,
      system: opts.system,
      conversation: opts.conversation,
      cwd: opts.cwd
    };
    if (opts.classic || !process.stdin.isTTY || !process.stdout.isTTY) {
      await startChatRepl(undefined, launchOptions);
    } else {
      await startTui(launchOptions);
    }
  });

program
  .command('status')
  .description('Show Hive CLI status')
  .action(() => {
    const state = config.loadState();
    const providers = listProviders().filter((provider) => provider.enabled);
    const activeProvider = providers.find((provider) => provider.id === state.currentProviderId);
    const activeModel = activeProvider?.models.find((model) => model.id === state.currentModelId);
    console.log(`Hive CLI v${APP_VERSION}`);
    console.log(`Data dir: ${process.env.HIVE_DATA_DIR || '(default ~/.hive)'}`);
    console.log(`Providers: ${providers.length}`);
    console.log(`Active model: ${activeProvider && activeModel ? `${activeProvider.name} / ${activeModel.name}` : '(none)'}`);
    console.log(`Workspace: ${state.currentProjectPath || process.env.HIVE_LAUNCH_CWD || process.cwd()}`);
    console.log(`Conversations: ${conversationService.listConversations().length}`);
  });

program
  .command('help-all')
  .description('Show all available commands')
  .action(() => {
    program.help();
  });

program.hook('preAction', async (thisCommand, actionCommand) => {
  const opts = thisCommand.opts();
  if (opts.dataDir) process.env.HIVE_DATA_DIR = resolvePath(opts.dataDir);

  // The default action (no subcommand) starts the chat REPL which calls
  // initHive itself. Subcommands like provider, project, etc. need the
  // database, so init here for them.
  if (actionCommand && actionCommand !== thisCommand && actionCommand.name() !== 'doctor') {
    const { initHive } = await import('./utils/init.js');
    await initHive();
  }
});

program.hook('postAction', async () => {
  await shutdownHive();
});

program.parseAsync(process.argv).catch(async (err) => {
  console.error(err);
  await shutdownHive();
  process.exit(1);
});
