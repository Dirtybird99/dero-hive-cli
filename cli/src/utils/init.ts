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
import { XswdManager } from '../../../src/main/xswd/manager.js';
import { setXswdManager } from '../../../src/main/xswd/instance.js';
import { SimulatorManager } from '../../../src/main/simulator/manager.js';
import { setSimulatorManager } from '../../../src/main/simulator/instance.js';
import { shutdownChatTasks } from '../services/chat.js';
import { cleanupAttachmentFiles } from '../../../src/main/utils/attachments.js';

export interface HiveContext {
  mcpManager: McpManager;
  tools: ToolRegistry;
  mediaManager: MediaManager;
  xswd: XswdManager;
  simulator: SimulatorManager;
}

let context: HiveContext | null = null;
let initPromise: Promise<HiveContext> | null = null;
let shutdownPromise: Promise<void> | null = null;
export type PermissionHandler = (request: PermissionRequest) => Promise<boolean>;
let permissionHandler: PermissionHandler | null = null;

export function setPermissionHandler(handler: PermissionHandler | null): void {
  permissionHandler = handler;
}

async function initializeHive(): Promise<HiveContext> {
  ensureDirs();
  await initSecrets();
  await initDb();
  try {
    await cleanupAttachmentFiles();
  } catch (error) {
    logger.warn('cli', `attachment cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const mcpManager = new McpManager();
  try {
    await mcpManager.loadFromSettings();
    const tools = new ToolRegistry(mcpManager);
    const mediaManager = new MediaManager();
    setMediaManager(mediaManager);
    // XSWD wallet bridge: constructed up front so builtin dero_wallet_* tools can
    // resolve it via getXswdManager(); no connection is made until the user opts in.
    const xswd = new XswdManager('cli');
    setXswdManager(xswd);
    const simulator = new SimulatorManager();
    setSimulatorManager(simulator);

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

    context = { mcpManager, tools, mediaManager, xswd, simulator };
    logger.info('cli', 'Hive CLI initialized');
    return context;
  } catch (error) {
    await mcpManager.shutdownAll().catch(() => undefined);
    closeDb();
    throw error;
  }
}

export async function initHive(): Promise<HiveContext> {
  if (shutdownPromise) await shutdownPromise;
  if (context) return context;
  initPromise ||= initializeHive().finally(() => { initPromise = null; });
  return initPromise;
}

export function getContext(): HiveContext {
  if (!context) throw new Error('Hive not initialized; call initHive() first');
  return context;
}

async function boundedShutdown(label: string, operation: Promise<unknown>, timeoutMs = 10_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} shutdown timed out after ${timeoutMs}ms`)), timeoutMs);
        timer.unref?.();
      })
    ]);
  } catch (error) {
    logger.warn('cli', error instanceof Error ? error.message : String(error));
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function shutdownHive(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    if (initPromise) await initPromise.catch(() => undefined);
    const active = context;
    context = null;
    permissionHandler = null;
    await boundedShutdown('chat tasks', shutdownChatTasks());
    await boundedShutdown('provider adapters', shutdownAdapterCache());
    if (active) {
      await Promise.all([
        boundedShutdown('XSWD', active.xswd.disconnect()),
        boundedShutdown('MCP', active.mcpManager.shutdownAll()),
        boundedShutdown('media', active.mediaManager.shutdown())
      ]);
    }
    setXswdManager(null);
    setSimulatorManager(null);
    setMediaManager(null);
    closeDb();
  })().finally(() => { shutdownPromise = null; });
  return shutdownPromise;
}

// SIGINT/SIGTERM handled by the REPL. The default handlers here would
// conflict with readline's SIGINT handling (Ctrl+C during idle vs abort).
// shutdownHive is called via the finally block in each command entrypoint.
