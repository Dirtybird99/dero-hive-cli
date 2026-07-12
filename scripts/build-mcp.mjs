import { build } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = resolve(root, 'resources', 'mcp', 'dero-mcp-server');
await rm(resolve(server, 'dist'), { recursive: true, force: true });
await mkdir(resolve(server, 'dist'), { recursive: true });

await build({
  entryPoints: [resolve(server, 'src', 'index.ts')],
  outfile: resolve(server, 'dist', 'index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner: {
    js: "import { createRequire as __hiveCreateRequire } from 'node:module'; const require = __hiveCreateRequire(import.meta.url);"
  },
  legalComments: 'none',
  sourcemap: false,
  logLevel: 'info'
});
