import { initDb, closeDb } from '../../../src/main/db/client.js';
import { initSecrets } from '../../../src/main/utils/secrets.js';
import { ensureDirs } from '../../../src/main/utils/paths.js';
import { logger } from '../../../src/main/utils/logger.js';
import { McpManager } from '../../../src/main/mcp/manager.js';
import { ToolRegistry } from '../../../src/main/tools/registry.js';
import type { PermissionRequest } from '../../../src/main/tools/registry.js';
import { MediaManager } from '../../../src/main/media/manager.js';
import { setMediaManager } from '../../../src/main/media/instance.js';
import { shutdownAdapterCache } from '../../../src/main/providers/registry.js';

export interface HiveContext {
  mcpManager: McpManager;
  tools: ToolRegistry;
  mediaManager: MediaManager;
}

let context: HiveContext | null = null;
export type PermissionHandler = (request: PermissionRequest) => Promise<boolean>;
let permissionHandler: PermissionHandler | null = null;

export function setPermissionHandler(handler: PermissionHandler | null): void {
  permissionHandler = handler;
}

export async function initHive(): Promise<HiveContext> {
  if (context) return context;
  ensureDirs();
  await initSecrets();
  await initDb();

  const mcpManager = new McpManager();
  await mcpManager.loadFromSettings();
  const tools = new ToolRegistry(mcpManager);
  const mediaManager = new MediaManager();
  setMediaManager(mediaManager);

  // Interactive TUI prompts are rendered in-app. Plain subcommands retain an
  // Inquirer fallback, while non-interactive runs fail closed.
  tools.on('request', async (req) => {
    let allowed = false;
    try {
      if (permissionHandler) {
        allowed = await permissionHandler(req);
      } else if (process.stdin.isTTY && process.stdout.isTTY) {
        const { confirm } = await import('@inquirer/prompts');
        allowed = await confirm({
          message: `Allow tool ${req.toolName}?`,
          default: false
        });
      }
    } catch {
      allowed = false;
    }
    tools.decidePermission(req.requestId, allowed ? 'allow' : 'deny');
  });

  context = { mcpManager, tools, mediaManager };
  logger.info('cli', 'Hive CLI initialized');
  return context;
}

export function getContext(): HiveContext {
  if (!context) throw new Error('Hive not initialized; call initHive() first');
  return context;
}

export async function shutdownHive(): Promise<void> {
  await shutdownAdapterCache();
  if (context) {
    await context.mcpManager.shutdownAll();
    setMediaManager(null);
    context = null;
  }
  permissionHandler = null;
  closeDb();
}

// SIGINT/SIGTERM handled by the REPL. The default handlers here would
// conflict with readline's SIGINT handling (Ctrl+C during idle vs abort).
// shutdownHive is called via the finally block in each command entrypoint.
