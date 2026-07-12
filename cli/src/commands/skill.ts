import { Command } from 'commander';
import chalk from 'chalk';
import { loadBundledSkills, loadUserSkills, inspectSkillDirectory } from '../../../src/main/skills/loader.js';
import * as format from '../utils/format.js';

export function skillCommand(): Command {
  const cmd = new Command('skill').description('Manage Agent Skills');

  cmd
    .command('list')
    .description('List available skills')
    .action(() => {
      const bundled = loadBundledSkills();
      const user = loadUserSkills();
      if (bundled.length === 0 && user.length === 0) {
        format.printInfo('No skills found.');
        return;
      }
      if (bundled.length) {
        console.log(chalk.bold('Built-in skills:'));
        for (const s of bundled) console.log(`  ${chalk.cyan(s.slashCommand)} — ${s.description}`);
      }
      if (user.length) {
        console.log(chalk.bold('User skills:'));
        for (const s of user) console.log(`  ${chalk.cyan(s.slashCommand)} — ${s.description}`);
      }
    });

  cmd
    .command('inspect <dir>')
    .description('Inspect a skill directory')
    .action((dir) => {
      const result = inspectSkillDirectory(dir);
      if (!result.ok) {
        format.printError(result.error);
        return;
      }
      const p = result.preview;
      console.log(`${chalk.bold(p.name)} ${chalk.gray(p.sourceDir)}`);
      console.log(`Command: ${p.slashCommand}`);
      console.log(`Description: ${p.description}`);
      if (p.warnings.length) {
        console.log(chalk.yellow('Warnings:'));
        for (const w of p.warnings) console.log(`  ${w}`);
      }
    });

  return cmd;
}
