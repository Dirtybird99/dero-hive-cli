import { copyFile, mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const temp = await mkdtemp(join(tmpdir(), 'dero-hive-package-'));
const packDir = join(temp, 'pack');
const prefix = join(temp, 'install');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const outputArchive = process.argv[2] ? resolve(process.argv[2]) : undefined;
const sqliteVersion = packageJson.dependencies?.['better-sqlite3'];
const installScripts = ['preinstall', 'install', 'postinstall', 'prepare'].filter((name) => packageJson.scripts?.[name]);

if (packageJson.name !== 'dero-hive-cli'
  || packageJson.repository?.url !== 'git+https://github.com/Dirtybird99/dero-hive-cli.git') {
  throw new Error('Package identity must be Dirtybird99/dero-hive-cli');
}
if (!/^\d+\.\d+\.\d+$/u.test(sqliteVersion || '')) {
  throw new Error('better-sqlite3 must be pinned to an exact version for package acceptance');
}
if (installScripts.length) throw new Error(`Package must not define install scripts: ${installScripts.join(', ')}`);

function run(command, args, options = {}) {
  const windows = process.platform === 'win32';
  const file = windows ? process.env.ComSpec || 'cmd.exe' : command;
  const childArgs = windows ? ['/d', '/c', 'call', command, ...args] : args;
  const isolatedEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.toUpperCase().startsWith('HIVE_') && !key.toUpperCase().startsWith('DERO_')
  ));
  const result = spawnSync(file, childArgs, {
    cwd: root,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    env: {
      ...isolatedEnv,
      HIVE_DATA_DIR: join(temp, 'data'),
      HIVE_KEYCHAIN_DISABLED: '1',
      DERO_DAEMON_URL: 'http://127.0.0.1:1'
    }
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status}\n${result.stderr || ''}`);
  }
  return result.stdout || '';
}

try {
  await Promise.all([mkdir(packDir), mkdir(prefix)]);
  const npmVersion = run(npm, ['--version'], { capture: true }).trim();
  if (Number.parseInt(npmVersion, 10) < 12) throw new Error(`npm 12+ required; found ${npmVersion}`);

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

  const required = [
    'LICENSE',
    'README.md',
    'SECURITY.md',
    'TESTING.md',
    'package.json',
    'cli/bin/hive.js',
    'cli/dist/hive.mjs',
    'resources/mcp/dero-mcp-server/package.json',
    'resources/mcp/dero-mcp-server/data/docs-index.json',
    'resources/mcp/dero-mcp-server/dist/index.js'
  ];
  const missing = required.filter((path) => !paths.includes(path));
  if (missing.length) throw new Error(`Required files missing from package:\n${missing.join('\n')}`);

  let archive = join(packDir, manifest.filename);
  if (outputArchive) {
    await mkdir(dirname(outputArchive), { recursive: true });
    await copyFile(archive, outputArchive, constants.COPYFILE_EXCL);
    archive = outputArchive;
  }

  run(npm, [
    'install',
    '--global',
    '--prefix', prefix,
    '--no-audit',
    '--no-fund',
    '--allow-remote=none',
    `--allow-scripts=better-sqlite3@${sqliteVersion}`,
    '--strict-allow-scripts',
    archive
  ]);
  const hive = process.platform === 'win32' ? join(prefix, 'hive.cmd') : join(prefix, 'bin', 'hive');
  const version = run(hive, ['--version'], { capture: true }).trim();
  if (version !== packageJson.version) throw new Error(`Expected CLI version ${packageJson.version}; found ${version}`);
  run(hive, ['status']);
  run(hive, ['doctor']);
  console.log(`Package acceptance passed (${paths.length} files, npm ${npmVersion}).`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
