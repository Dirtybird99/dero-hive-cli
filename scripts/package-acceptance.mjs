import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const temp = await mkdtemp(join(tmpdir(), 'dero-hive-package-'));
const packDir = join(temp, 'pack');
const prefix = join(temp, 'install');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(command, args, options = {}) {
  const windows = process.platform === 'win32';
  const file = windows ? process.env.ComSpec || 'cmd.exe' : command;
  const childArgs = windows ? ['/d', '/c', 'call', command, ...args] : args;
  const result = spawnSync(file, childArgs, {
    cwd: root,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    env: { ...process.env, HIVE_DATA_DIR: join(temp, 'data') }
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status}\n${result.stderr || ''}`);
  }
  return result.stdout || '';
}

try {
  await mkdir(packDir);
  const output = run(npm, ['pack', '--json', '--ignore-scripts', '--pack-destination', packDir], { capture: true });
  const parsed = JSON.parse(output);
  const manifest = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
  if (!manifest?.filename || !Array.isArray(manifest.files)) throw new Error('npm pack returned no file manifest');

  const paths = manifest.files.map(({ path }) => path.replaceAll('\\', '/'));
  const forbidden = paths.filter((path) =>
    path.includes('/node_modules/') ||
    path.startsWith('node_modules/') ||
    path.startsWith('cli/src/') ||
    path.startsWith('src/') ||
    path.startsWith('scripts/') ||
    /(^|\/)(preinstall|install|postinstall)\.(c?js|mjs)$/u.test(path)
  );
  if (forbidden.length) throw new Error(`Forbidden files in package:\n${forbidden.join('\n')}`);

  const required = ['package.json', 'cli/bin/hive.js', 'cli/dist/hive.mjs', 'resources/mcp/dero-mcp-server/dist/index.js'];
  const missing = required.filter((path) => !paths.includes(path));
  if (missing.length) throw new Error(`Required files missing from package:\n${missing.join('\n')}`);

  const archive = join(packDir, manifest.filename);
  run(npm, ['install', '--global', '--prefix', prefix, '--no-audit', '--no-fund', '--allow-scripts=better-sqlite3', archive]);
  const hive = process.platform === 'win32' ? join(prefix, 'hive.cmd') : join(prefix, 'bin', 'hive');
  run(hive, ['--version']);
  run(hive, ['status']);
  run(hive, ['doctor']);
  console.log(`Package acceptance passed (${paths.length} files).`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
