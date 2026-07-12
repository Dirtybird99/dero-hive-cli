import { Command } from 'commander';
import chalk from 'chalk';
import { getContext } from '../utils/init.js';
import * as format from '../utils/format.js';
import { getDefaultWorkspace } from '../../../src/main/utils/paths.js';

export function toolCommand(): Command {
  const cmd = new Command('tool').description('Manage and run tools');

  cmd
    .command('list')
    .description('List available tools')
    .action(() => {
      const { tools } = getContext();
      const list = tools.listTools();
      for (const t of list) {
        const source = t.source.startsWith('mcp:') ? chalk.gray(t.source) : chalk.green('builtin');
        console.log(`${source} ${chalk.bold(t.name)}: ${t.description}`);
      }
    });

  cmd
    .command('run <name>')
    .description('Run a tool directly')
    .option('--args <json>', 'JSON arguments', '{}')
    .option('--cwd <path>', 'Working directory')
    .action(async (name, options) => {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(options.args || '{}');
      } catch {
        format.printError('Invalid JSON args');
        return;
      }
      const cwd = options.cwd || getDefaultWorkspace();
      const { tools } = getContext();
      try {
        const result = await tools.execute(name, args, { cwd, conversationId: 'cli' });
        if (result.isError) format.printError(result.content);
        else format.printSuccess(result.content);
      } catch (err) {
        format.printError(`Tool failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

  return cmd;
}
