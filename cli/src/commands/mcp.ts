import { Command } from 'commander';
import { input, confirm, select } from '@inquirer/prompts';
import chalk from 'chalk';
import { getContext } from '../utils/init.js';
import * as format from '../utils/format.js';
import type { McpServerConfig } from '../../../src/shared/types.js';

export function mcpCommand(): Command {
  const cmd = new Command('mcp').description('Manage MCP servers');

  cmd
    .command('list')
    .description('List MCP servers')
    .action(async () => {
      const { mcpManager } = getContext();
      const statuses = mcpManager.getStatuses();
      for (const s of statuses) {
        const status = s.connected ? chalk.green('connected') : s.error ? chalk.red(`error: ${s.error}`) : chalk.gray('disconnected');
        console.log(`${s.name}: ${status} (${s.tools.length} tools)`);
      }
    });

  cmd
    .command('add')
    .description('Add or update an MCP server')
    .action(async () => {
      const id = await input({ message: 'Server id:' });
      const name = await input({ message: 'Server name:', default: id });
      const transport = await select({
        message: 'Transport',
        choices: [
          { value: 'stdio', name: 'stdio' },
          { value: 'http', name: 'HTTP' }
        ]
      });
      const enabled = await confirm({ message: 'Enable now?', default: true });
      const trust = await confirm({ message: 'Trust server (skip tool confirmations)?', default: false });

      const cfg: McpServerConfig = { id, name, enabled, transport, trust } as McpServerConfig;
      if (transport === 'stdio') {
        cfg.command = await input({ message: 'Command:' });
        const args = await input({ message: 'Args (space separated):' });
        cfg.args = args ? args.split(' ').filter(Boolean) : [];
        cfg.cwd = await input({ message: 'Working directory (optional):' });
        cfg.timeoutMs = Number(await input({ message: 'Timeout ms:', default: '30000' })) || 30000;
      } else {
        cfg.url = await input({ message: 'URL:' });
      }

      const { mcpManager } = getContext();
      await mcpManager.saveConfig(cfg);
      format.printSuccess(`MCP server ${id} saved.`);
    });

  cmd
    .command('remove <id>')
    .description('Remove an MCP server')
    .action(async (id) => {
      const { mcpManager } = getContext();
      await mcpManager.deleteConfig(id);
      format.printSuccess(`MCP server ${id} removed.`);
    });

  cmd
    .command('connect <id>')
    .description('Connect an MCP server')
    .action(async (id) => {
      const { mcpManager } = getContext();
      const configs = await mcpManager.listConfigs();
      const cfg = configs.find((c) => c.id === id);
      if (!cfg) {
        format.printError(`MCP server ${id} not found`);
        return;
      }
      try {
        await mcpManager.connect(cfg);
        format.printSuccess(`Connected ${id}`);
      } catch (err) {
        format.printError(`Connect failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

  cmd
    .command('disconnect <id>')
    .description('Disconnect an MCP server')
    .action(async (id) => {
      const { mcpManager } = getContext();
      await mcpManager.disconnect(id);
      format.printSuccess(`Disconnected ${id}`);
    });

  cmd
    .command('tools')
    .description('List available tools')
    .action(async () => {
      const { tools } = getContext();
      const list = tools.listTools();
      for (const t of list) {
        const source = t.source.startsWith('mcp:') ? chalk.gray(t.source) : chalk.green('builtin');
        console.log(`${source} ${chalk.bold(t.name)}: ${t.description}`);
      }
    });

  return cmd;
}
