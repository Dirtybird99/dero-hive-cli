#!/usr/bin/env node
// DERO Hive CLI runtime wrapper.
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..', '..');
// Keep the terminal's original cwd as the coding workspace. Source imports
// resolve by URL, while these variables point headless services at Hive's
// bundled resources instead of whichever VS Code folder launched the CLI.
process.env.HIVE_LAUNCH_CWD ||= process.cwd();
process.env.HIVE_APP_ROOT ||= root;
process.env.HIVE_RESOURCES ||= resolve(root, 'resources');
process.env.HIVE_CLI = '1';
const builtEntry = resolve(__dirname, '..', 'dist', 'hive.mjs');
await import(pathToFileURL(builtEntry).href);
