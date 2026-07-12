import { Command } from 'commander';
import ora from 'ora';
import chalk from 'chalk';
import { SimulatorManager } from '../../../src/main/simulator/manager.js';
import { lintDvmBasic } from '../../../src/shared/dvm.js';
import * as format from '../utils/format.js';
import { readFileSync } from 'node:fs';

export function simulatorCommand(): Command {
  const cmd = new Command('simulator').alias('sim').description('DERO blockchain simulator controls');
  const manager = new SimulatorManager();

  cmd
    .command('status')
    .description('Show simulator status')
    .action(() => {
      const status = manager.status();
      console.log(`${chalk.bold('Installed:')} ${status.installed ? chalk.green('yes') : chalk.red('no')}`);
      console.log(`${chalk.bold('Running:')} ${status.running ? chalk.green('yes') : chalk.gray('no')}`);
      if (status.binaryPath) console.log(`${chalk.bold('Binary:')} ${status.binaryPath}`);
      if (status.error) format.printError(status.error);
    });

  cmd
    .command('start')
    .description('Start the simulator')
    .option('--binary <path>', 'Path to derod-simulator binary')
    .option('--args <args...>', 'Arguments to pass to simulator')
    .action(async (options) => {
      const spinner = ora('Starting simulator...').start();
      const status = await manager.start({
        binaryPath: options.binary,
        args: options.args
      });
      spinner.stop();
      if (status.error) format.printError(`Start failed: ${status.error}`);
      else format.printSuccess(`Simulator started (pid ${status.pid})`);
    });

  cmd
    .command('stop')
    .description('Stop the simulator')
    .action(async () => {
      const status = await manager.stop();
      if (status.running) format.printError('Simulator still running');
      else format.printSuccess('Simulator stopped');
    });

  cmd
    .command('health')
    .description('Check simulator RPC health')
    .action(async () => {
      const health = await manager.health();
      console.log(`${chalk.bold('Endpoint:')} ${health.endpoint}`);
      console.log(`${chalk.bold('Reachable:')} ${health.reachable ? chalk.green('yes') : chalk.red('no')}`);
      if (health.latencyMs) console.log(`${chalk.bold('Latency:')} ${health.latencyMs}ms`);
      if (health.error) format.printError(health.error);
    });

  cmd
    .command('chain-info')
    .description('Show simulator chain info')
    .action(async () => {
      try {
        const info = await manager.chainInfo();
        console.log(info);
      } catch (err) {
        format.printError(`Chain info failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

  cmd
    .command('lint <file>')
    .description('Lint a DVM-BASIC file')
    .action((file) => {
      try {
        const source = readFileSync(file, 'utf-8');
        const result = lintDvmBasic(source);
        if (result.valid) format.printSuccess('No issues found');
        else {
          format.printError(`Lint issues (${result.findings.length}):`);
          for (const finding of result.findings) console.log(`  ${finding.severity}: ${finding.message} (line ${finding.line})`);
        }
      } catch (err) {
        format.printError(`Lint failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

  return cmd;
}
