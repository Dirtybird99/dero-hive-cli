import { Command } from 'commander';
import { input, confirm } from '@inquirer/prompts';
import { existsSync, realpathSync } from 'node:fs';
import * as projectService from '../services/project.js';
import * as format from '../utils/format.js';
import { getDb } from '../../../src/main/db/client.js';

export function projectCommand(): Command {
  const cmd = new Command('project').description('Manage project folders');

  cmd
    .command('list')
    .description('List projects')
    .action(() => {
      const projects = projectService.listProjects();
      if (projects.length === 0) {
        format.printInfo('No projects. Use `hive project add`.');
        return;
      }
      for (const p of projects) {
        console.log(format.formatProject(p));
      }
    });

  cmd
    .command('add')
    .description('Add a project folder')
    .option('--name <name>', 'Project name')
    .option('--path <path>', 'Project folder path')
    .option('--icon <icon>', 'Project icon')
    .action(async (options) => {
      const path = options.path || (await input({ message: 'Project folder path:' }));
      const resolved = realpathSync(path);
      if (!existsSync(resolved)) {
        format.printError(`Path does not exist: ${resolved}`);
        return;
      }
      const name = options.name || (await input({ message: 'Project name:', default: resolved.split(/[\\/]/).pop() || 'Project' }));
      const icon = options.icon || '📁';
      const p = projectService.createProject({ name, path: resolved, icon });
      format.printSuccess(`Project added: ${p.name} (${p.path})`);
    });

  cmd
    .command('remove <id>')
    .description('Remove a project (does not delete files)')
    .action(async (id) => {
      const p = projectService.getProject(id);
      if (!p) {
        format.printError(`Project ${id} not found`);
        return;
      }
      const ok = await confirm({ message: `Remove project "${p.name}"?`, default: false });
      if (ok) {
        try {
          projectService.deleteProject(id);
          format.printSuccess(`Project ${id} removed`);
        } catch (error) {
          format.printError(`Project removal failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    });

  cmd
    .command('info <id>')
    .description('Show project details')
    .action((id) => {
      const p = projectService.getProject(id);
      if (!p) {
        format.printError(`Project ${id} not found`);
        return;
      }
      console.log(format.formatProject(p));
      const convCount = (getDb().prepare('SELECT COUNT(*) AS c FROM conversations WHERE project_id = ?').get(id) as { c: number }).c;
      format.printInfo(`Conversations: ${convCount}`);
      if (p.config) format.printInfo(`Config: ${JSON.stringify(p.config, null, 2)}`);
    });

  return cmd;
}
