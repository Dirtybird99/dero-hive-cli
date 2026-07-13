import { Command } from 'commander';
import { accessSync, constants, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { closeDb, getDb, initDb } from '../../../src/main/db/client.js';
import { ensureDirs, paths, resourcesRoot } from '../../../src/main/utils/paths.js';

interface Check {
  label: string;
  ok: boolean;
  required: boolean;
  detail: string;
}

async function localDaemonAvailable(): Promise<boolean> {
  const daemonUrl = (process.env.DERO_DAEMON_URL || 'http://127.0.0.1:10102').replace(/\/$/u, '');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_500);
  try {
    const response = await fetch(`${daemonUrl}/json_rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'hive-doctor', method: 'DERO.GetInfo' }),
      signal: controller.signal
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export function doctorCommand(): Command {
  return new Command('doctor')
    .description('Check the Hive CLI installation and local environment')
    .action(async () => {
      const checks: Check[] = [];
      const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] || '0', 10);
      checks.push({ label: 'Node.js', ok: nodeMajor >= 22, required: true, detail: `v${process.versions.node} (22+ required)` });

      const npm = spawnSync(
        process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : 'npm',
        process.platform === 'win32' ? ['/d', '/s', '/c', 'npm --version'] : ['--version'],
        {
          encoding: 'utf8',
          windowsHide: true
        }
      );
      const npmVersion = npm.status === 0 ? npm.stdout.trim() : '';
      const npmMajor = Number.parseInt(npmVersion.split('.')[0] || '0', 10);
      checks.push({ label: 'npm', ok: npmMajor >= 10, required: true, detail: npmVersion ? `v${npmVersion} (10+ required)` : 'not found' });

      try {
        ensureDirs();
        accessSync(paths.userData, constants.R_OK | constants.W_OK);
        checks.push({ label: 'Data directory', ok: true, required: true, detail: paths.userData });
      } catch (error) {
        checks.push({ label: 'Data directory', ok: false, required: true, detail: error instanceof Error ? error.message : String(error) });
      }

      try {
        await initDb();
        getDb().prepare('SELECT 1').get();
        const providers = (getDb().prepare('SELECT COUNT(*) AS count FROM providers WHERE enabled = 1').get() as { count: number }).count;
        checks.push({ label: 'SQLite', ok: true, required: true, detail: `${paths.db}; ${providers} enabled provider${providers === 1 ? '' : 's'}` });
      } catch (error) {
        checks.push({ label: 'SQLite', ok: false, required: true, detail: error instanceof Error ? error.message : String(error) });
      } finally {
        closeDb();
      }

      const appRoot = process.env.HIVE_APP_ROOT || process.cwd();
      const cliBundle = join(appRoot, 'cli', 'dist', 'hive.mjs');
      checks.push({ label: 'CLI bundle', ok: existsSync(cliBundle), required: true, detail: cliBundle });

      const mcpBundle = join(resourcesRoot, 'mcp', 'dero-mcp-server', 'dist', 'index.js');
      checks.push({ label: 'DERO MCP bundle', ok: existsSync(mcpBundle), required: true, detail: mcpBundle });

      const skillsDir = join(resourcesRoot, 'skills');
      const skillCount = existsSync(skillsDir) ? readdirSync(skillsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length : 0;
      checks.push({ label: 'DERO skills', ok: skillCount > 0, required: true, detail: `${skillCount} bundled` });

      const codexAcp = join(appRoot, 'node_modules', '@agentclientprotocol', 'codex-acp', 'dist', 'index.js');
      checks.push({ label: 'Codex ACP', ok: existsSync(codexAcp), required: false, detail: existsSync(codexAcp) ? 'available' : 'optional provider unavailable' });

      const daemon = await localDaemonAvailable();
      const configuredDaemon = process.env.DERO_DAEMON_URL;
      checks.push({
        label: configuredDaemon ? 'Configured DERO daemon' : 'Local DERO daemon',
        ok: daemon,
        required: false,
        detail: daemon
          ? `${configuredDaemon || 'http://127.0.0.1:10102'} reachable`
          : configuredDaemon
            ? `${configuredDaemon} not reachable`
            : 'not running; MCP will use its public fallback'
      });

      for (const check of checks) {
        const marker = check.ok ? 'PASS' : check.required ? 'FAIL' : 'WARN';
        console.log(`${marker.padEnd(4)} ${check.label}: ${check.detail}`);
      }

      const failures = checks.filter((check) => check.required && !check.ok).length;
      const warnings = checks.filter((check) => !check.required && !check.ok).length;
      console.log(`\nDoctor: ${failures ? `${failures} required check${failures === 1 ? '' : 's'} failed` : 'ready'}${warnings ? `; ${warnings} optional warning${warnings === 1 ? '' : 's'}` : ''}.`);
      if (failures) process.exitCode = 1;
    });
}
