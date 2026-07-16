import { normalizeToolApprovalMode, type ToolApprovalMode, type ToolDefinition, type PermissionRule } from '@shared/types';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { getDb, getSetting } from '../db/client';
import { BUILTIN_TOOLS, builtinExecutors } from './builtin';
import { McpManager } from '../mcp/manager';
import { getXswdManager } from '../xswd/instance';
import { reviewXswdTransfer, reviewXswdScInvoke, type XswdTransferParams, type XswdScInvokeParams } from '../xswd/safety';

export interface ToolContext {
  cwd: string;
  conversationId: string;
  /**
   * Optional cancellation signal. When aborted, long-running executors
   * (currently run_shell) stop promptly and return a `[cancelled]` error
   * result. Omitting it preserves the previous, non-cancellable behavior.
   */
  signal?: AbortSignal;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
  meta?: Record<string, unknown>;
}

export type ToolExecutor = (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;

export interface PermissionRequest {
  requestId: string;
  toolName: string;
  args: Record<string, unknown>;
  description?: string;
  /** Human-readable, decoded review lines for irreversible wallet writes (network, amount,
   *  ring size, integrated-invoice fields). Populated for dero_wallet_* when connected. */
  reviewLines?: string[];
  conversationId?: string;
  projectPath?: string;
}

type Decision = 'allow' | 'deny';

export class ToolRegistry extends EventEmitter {
  private executors = new Map<string, ToolExecutor>();
  private pendingRequests = new Map<string, {
    resolve: (d: Decision) => void;
    grantKey?: string;
    explicitAsk: boolean;
  }>();
  private scopedAllow = new Set<string>();

  constructor(private mcpManager: McpManager | null) {
    super();
    for (const [name, exec] of Object.entries(builtinExecutors)) {
      this.executors.set(name, exec);
    }
  }

  listTools(): ToolDefinition[] {
    const builtin = BUILTIN_TOOLS;
    const mcp = this.mcpManager?.getAllTools() || [];
    return [...builtin, ...mcp];
  }

  async execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    // MCP — models call MCP tools by their raw advertised name, so resolve the
    // owning server up front. It is needed before the permission check, because
    // whether the tool needs approval depends on that server's trust flag.
    const mcp = this.executors.has(name) ? null : (this.mcpManager?.resolveTool(name) ?? null);

    // Check permissions
    const rule = this.matchRule(name, args, ctx);
    if (rule?.action === 'deny') {
      return { content: `Denied by permission rule: ${name}`, isError: true };
    }
    // Irreversible wallet writes are an un-bypassable gate: they always prompt,
    // even under an 'allow' rule or approvalMode 'never', and the decision is
    // never remembered (explicitAsk grants are not added to scopedAllow).
    const forcedApproval = WALLET_WRITE_TOOLS.has(name);
    // An explicit `ask` rule always prompts. With no rule, sensitive built-ins
    // prompt, and so does any tool from an MCP server the user has not trusted.
    const implicitRisk = !rule && (this.requiresApproval(name) || (mcp !== null && !mcp.trusted));
    if (forcedApproval || rule?.action === 'ask' || implicitRisk) {
      let reviewLines: string[] | undefined;
      if (forcedApproval) {
        try {
          reviewLines = buildWalletWriteReview(name, args);
        } catch (err) {
          // A wallet is connected and the params fail validation — reject before
          // prompting so the user never approves a transaction that cannot succeed.
          return { content: `Wallet write rejected: ${err instanceof Error ? err.message : String(err)}`, isError: true };
        }
      }
      const allowed = await this.authorize({
        requestId: cryptoRandom(),
        toolName: name,
        args,
        description: forcedApproval
          ? 'Irreversible wallet write; Hive and the connected wallet must both approve.'
          : mcp?.serverName ? `MCP server: ${mcp.serverName}` : undefined,
        reviewLines
      }, ctx, forcedApproval || rule?.action === 'ask');
      if (!allowed) return { content: `User denied: ${name}`, isError: true };
    }

    // Built-in
    const builtin = this.executors.get(name);
    if (builtin) {
      try { return await builtin(args, ctx); }
      catch (err) { return { content: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true }; }
    }

    if (mcp) {
      try {
        const result = await this.mcpManager!.callTool(mcp.serverId, mcp.toolName, args);
        const content = Array.isArray(result.content)
          ? (result.content as Array<{ type: string; text?: string }>).map((c) => c.text || JSON.stringify(c)).join('\n')
          : String(result.content);
        return {
          content,
          isError: result.isError,
          meta: { source: `mcp:${mcp.serverId}`, serverName: mcp.serverName }
        };
      } catch (err) {
        return { content: `MCP tool error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    }

    return { content: `Unknown tool: ${name}`, isError: true };
  }

  matchRule(toolName: string, args: Record<string, unknown>, ctx?: ToolContext): PermissionRule | null {
    const rows = getDb().prepare('SELECT * FROM permissions').all() as Array<Record<string, unknown>>;
    let askRule: PermissionRule | null = null;
    let allowRule: PermissionRule | null = null;
    for (const row of rows) {
      const rule: PermissionRule = {
        id: row.id as string,
        toolName: row.tool_name as string,
        pattern: row.pattern as string | undefined,
        action: row.action as 'allow' | 'deny' | 'ask',
        scope: row.scope as 'project' | 'global' | undefined,
        projectPath: row.project_path as string | undefined
      };
      if (rule.toolName !== '*' && rule.toolName !== toolName) continue;
      if (rule.pattern && !matchPattern(rule.pattern, args)) continue;
      if (rule.scope === 'project') {
        if (!rule.projectPath || !ctx) continue;
        const expected = normalizeProjectPath(rule.projectPath);
        const actual = normalizeProjectPath(ctx.cwd);
        if (expected !== actual) continue;
      }
      // A matching deny is absolute. Explicit asks then take precedence over
      // allows so a broad allow rule cannot mask a narrower safety rule.
      if (rule.action === 'deny') return rule;
      if (rule.action === 'ask') askRule ||= rule;
      if (rule.action === 'allow') allowRule ||= rule;
    }
    return askRule || allowRule;
  }

  listRules(): PermissionRule[] {
    const rows = getDb().prepare('SELECT * FROM permissions ORDER BY created_at DESC').all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: row.id as string,
      toolName: row.tool_name as string,
      pattern: row.pattern as string | undefined,
      action: row.action as 'allow' | 'deny' | 'ask',
      scope: row.scope as 'project' | 'global' | undefined,
      projectPath: row.project_path as string | undefined
    }));
  }

  saveRule(rule: PermissionRule): void {
    getDb().prepare(`
      INSERT INTO permissions (id, tool_name, pattern, action, scope, project_path, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        tool_name = excluded.tool_name,
        pattern = excluded.pattern,
        action = excluded.action,
        scope = excluded.scope,
        project_path = excluded.project_path
    `).run(rule.id, rule.toolName, rule.pattern || null, rule.action, rule.scope || null, rule.projectPath || null, Date.now());
  }

  deleteRule(id: string): void {
    getDb().prepare('DELETE FROM permissions WHERE id = ?').run(id);
  }

  decidePermission(requestId: string, decision: Decision): void {
    const p = this.pendingRequests.get(requestId);
    if (p) {
      if (decision === 'allow' && !p.explicitAsk && p.grantKey) this.scopedAllow.add(p.grantKey);
      p.resolve(decision);
      this.pendingRequests.delete(requestId);
    }
  }

  private requiresApproval(name: string): boolean {
    // 'always'/'session'/'project' all ask for sensitive built-ins; 'never' never does.
    // The scope of what "remembering" a decision means is handled in authorize().
    if (this.approvalMode() === 'never') return false;
    const sensitiveBuiltins = ['run_shell', 'write_file', 'edit_file'];
    const deroWritePatterns = ['invoke', 'deploy', 'transfer', 'send', 'sign'];
    if (sensitiveBuiltins.includes(name)) return true;
    const lower = name.toLowerCase();
    if (deroWritePatterns.some(p => lower.includes(p))) return true;
    return false;
  }

  /** Provider-native permission callbacks enter the same main-process gate. */
  async requestPermission(req: PermissionRequest, ctx?: ToolContext): Promise<boolean> {
    if (!ctx) return false;
    const rule = this.matchRule(req.toolName, req.args, ctx);
    if (rule?.action === 'deny') return false;
    // Wallet writes always prompt — an 'allow' rule cannot bypass the gate.
    if (WALLET_WRITE_TOOLS.has(req.toolName)) {
      return this.authorize({
        ...req,
        description: req.description || 'Irreversible wallet write; Hive and the connected wallet must both approve.'
      }, ctx, true);
    }
    if (rule?.action === 'allow') return true;
    return this.authorize(req, ctx, rule?.action === 'ask');
  }

  private approvalMode(): ToolApprovalMode {
    return normalizeToolApprovalMode(
      (getSetting<{ toolApprovalMode?: unknown }>('appSettings') || {}).toolApprovalMode
    );
  }

  private approvalKey(mode: ToolApprovalMode, ctx: ToolContext, toolName: string): string | undefined {
    if (mode === 'session') return `session\0${ctx.conversationId}\0${toolName}`;
    if (mode === 'project') return `project\0${ctx.cwd}\0${toolName}`;
    return undefined;
  }

  private async authorize(req: PermissionRequest, ctx: ToolContext, explicitAsk: boolean): Promise<boolean> {
    const mode = this.approvalMode();
    const grantKey = this.approvalKey(mode, ctx, req.toolName);
    if (!explicitAsk && (mode === 'never' || (grantKey && this.scopedAllow.has(grantKey)))) return true;

    const request = { ...req, conversationId: ctx.conversationId, projectPath: ctx.cwd };
    return new Promise<boolean>((resolve) => {
      const wrap = (allow: boolean): void => resolve(allow);
      this.pendingRequests.set(req.requestId, {
        resolve: ((d: Decision) => wrap(d === 'allow')) as (d: Decision) => void,
        grantKey,
        explicitAsk
      });
      this.emit('request', request);
      // Auto-deny after 2 minutes
      setTimeout(() => {
        if (this.pendingRequests.has(req.requestId)) {
          this.pendingRequests.delete(req.requestId);
          wrap(false);
        }
      }, 120_000);
    });
  }
}

const WALLET_WRITE_TOOLS = new Set(['dero_wallet_transfer', 'dero_wallet_scinvoke']);

/** Decode a wallet-write's args into human-readable approval lines. Returns undefined when
 *  no wallet is connected (the wallet's own dialog + the executor remain the gate); throws
 *  the validation message when a connected wallet's params are invalid, so the caller can
 *  reject before prompting. */
function buildWalletWriteReview(name: string, args: Record<string, unknown>): string[] | undefined {
  const mgr = getXswdManager();
  const address = mgr?.getConnectedAddress();
  if (!mgr || !address) return undefined;
  if (name === 'dero_wallet_transfer') {
    return reviewXswdTransfer(args as unknown as XswdTransferParams, address).lines;
  }
  if (name === 'dero_wallet_scinvoke') {
    return reviewXswdScInvoke(args as unknown as XswdScInvokeParams).lines;
  }
  return undefined;
}

function normalizeProjectPath(path: string): string {
  const normalized = resolve(path).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function matchPattern(pattern: string, args: Record<string, unknown>): boolean {
  // Pattern is matched against JSON-stringified args
  try {
    const str = JSON.stringify(args);
    if (pattern.startsWith('/') && pattern.endsWith('/')) {
      const re = new RegExp(pattern.slice(1, -1));
      return re.test(str);
    }
    return str.includes(pattern);
  } catch { return false; }
}

function cryptoRandom(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
