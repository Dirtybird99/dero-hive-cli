import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve the repo root from this script's own location so the build works no
// matter which directory it is invoked from (repo root or the cli/ workspace).
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = resolve(root, 'cli', 'dist');
await mkdir(outputDir, { recursive: true });

await build({
  entryPoints: [resolve(root, 'cli', 'src', 'index.ts')],
  outfile: resolve(outputDir, 'hive.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  jsx: 'automatic',
  tsconfig: resolve(root, 'tsconfig.cli.json'),
  define: { 'process.env.NODE_ENV': '"production"' },
  banner: {
    js: "import { createRequire as __hiveCreateRequire } from 'node:module'; const require = __hiveCreateRequire(import.meta.url);"
  },
  // Keep only native/runtime-provided modules external. Everything else is
  // bundled so the packaged desktop app does not need to preserve the CLI
  // workspace's hoisted dependency layout. Native addons (.node) cannot be
  // bundled — they must resolve from node_modules at runtime.
  external: ['better-sqlite3', '@napi-rs/keyring'],
  plugins: [{
    name: 'optional-react-devtools',
    setup(buildApi) {
      buildApi.onResolve({ filter: /^react-devtools-core$/ }, () => ({
        path: 'react-devtools-core',
        namespace: 'optional-stub'
      }));
      buildApi.onLoad({ filter: /.*/, namespace: 'optional-stub' }, () => ({
        contents: 'export default { connectToDevTools() {} };',
        loader: 'js'
      }));
    }
  }],
  legalComments: 'none',
  sourcemap: false,
  logLevel: 'info'
});
