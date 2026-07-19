import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { EventEmitter } from 'node:events';
import type { McpServerConfig, McpServerStatus, ToolDefinition } from '@shared/types';
import { APP_VERSION } from '@shared/version';
import { getDb } from '../db/client';
import { logger } from '../utils/logger';
import { resourcesRoot } from '../utils/paths';
import { getWorkspaceRoot, isPathWithin } from '../utils/pathPolicy';
import { deleteSecret, getSecret, setSecret } from '../utils/secrets';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { McpServerInstance } from './client';
import { BoundedStdioClientTransport, createBoundedMcpFetch } from './transport';

const RECONNECT_DELAY_MS = 2000;
const RECONNECT_MAX_DELAY_MS = 60_000;
const RECONNECT_MAX_ATTEMPTS = 8;

export function validateMcpConfig(cfg: McpServerConfig): void {
  if (!cfg.id?.trim() || !cfg.name?.trim()) throw new Error('MCP server id and name are required');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(cfg.id)) {
    throw new Error('MCP server id must use only letters, numbers, dot, underscore, or hyphen');
  }
  if (cfg.timeoutMs !== undefined
    && (!Number.isInteger(cfg.timeoutMs) || cfg.timeoutMs < 100 || cfg.timeoutMs > 300_000)) {
    throw new Error('MCP server timeout must be an integer between 100 and 300000ms');
  }
  if (cfg.transport !== undefined && !['stdio', 'http'].includes(cfg.transport)) {
    throw new Error('Unsupported MCP transport');
  }
  if (cfg.transport === 'http') {
    let url: URL;
    try { url = new URL(cfg.url || ''); } catch { throw new Error('MCP server URL must be valid'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('MCP server URL must use http or https');
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname.toLowerCase());
    if (url.protocol === 'http:' && !loopback) throw new Error('Remote MCP server URLs must use https');
    if (url.username || url.password) throw new Error('MCP credentials must use the bearer-token field, not the URL');
  } else {
    if (!cfg.command || typeof cfg.command !== 'string') {
      throw new Error('MCP server command must be a non-empty string');
    }
    if (cfg.args !== undefined && !Array.isArray(cfg.args)) {
      throw new Error('MCP server args must be an array of strings');
    }
    if (cfg.args?.some((a) => typeof a !== 'string')) throw new Error('MCP server args must be strings');
    if (cfg.cwd && !isPathWithin(cfg.cwd, resourcesRoot) && !isPathWithin(cfg.cwd, getWorkspaceRoot())) {
      throw new Error(`MCP server cwd outside allowed roots: ${cfg.cwd}`);
    }
  }

  if (cfg.env && (typeof cfg.env !== 'object' || Array.isArray(cfg.env)
    || Object.entries(cfg.env).some(([key, value]) => !key || key.includes('=') || key.includes('\0') || typeof value !== 'string'))) {
    throw new Error('MCP server environment must contain string values with non-empty keys');
  }
}

const bearerSecretKey = (id: string): string => `mcp:${id}:bearer`;
const envSecretKey = (id: string, key: string): string => `mcp:${id}:env:${key}`;

const CHILD_ENV_KEYS = [
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'ComSpec',
  'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
  'LANG', 'LC_ALL', 'DERO_DAEMON_URL', 'DERO_WALLET_URL', 'DERO_NETWORK'
] as const;

export function buildMcpChildEnv(serverEnv: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of CHILD_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...serverEnv };
}


export class McpManager extends EventEmitter {
  private servers = new Map<string, McpServerInstance>();
  private pendingReconnects = new Map<string, NodeJS.Timeout>();
  private reconnectAttempts = new Map<string, number>();
  private lastErrors = new Map<string, string>();
  private shuttingDown = false;

  async ensureBundledServers(onlyName?: string): Promise<void> {
    const mcpDir = join(resourcesRoot, 'mcp');
    if (!statSync(mcpDir, { throwIfNoEntry: false })?.isDirectory()) return;

    for (const name of readdirSync(mcpDir)) {
      if (onlyName && name !== onlyName) continue;
      const serverDir = join(mcpDir, name);
      if (!statSync(serverDir).isDirectory()) continue;

      // Binary bundled server: described by a hive-mcp.json manifest
      // (written by scripts/setup-mcp.mjs) pointing at a native executable.
      const manifestPath = join(serverDir, 'hive-mcp.json');
      if (statSync(manifestPath, { throwIfNoEntry: false })?.isFile()) {
        try {
          const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { name?: string; command?: string; args?: string[] };
          const mcpName = manifest.name || name;
          const binPath = manifest.command ? join(serverDir, manifest.command) : '';
          if (!binPath || !statSync(binPath, { throwIfNoEntry: false })?.isFile()) {
            logger.warn('mcp', `bundled server ${mcpName} missing binary: ${binPath || '(no command in manifest)'}`);
            continue;
          }
          await this.registerBundled({
            id: `bundled-${sanitizeId(mcpName)}`,
            name: mcpName,
            enabled: true,
            command: binPath,
            args: manifest.args || [],
            cwd: serverDir,
            timeoutMs: 30_000,
            trust: true
          }, []);
        } catch (err) {
          logger.warn('mcp', `invalid manifest for bundled server ${name}: ${err instanceof Error ? err.message : String(err)}`);
        }
        continue;
      }

      const pkgPath = join(serverDir, 'package.json');
      if (!statSync(pkgPath, { throwIfNoEntry: false })?.isFile()) continue;

      let pkg: Record<string, unknown>;
      try {
        pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>;
      } catch {
        continue;
      }

      // Display under the plain package name; earlier versions registered
      // under the MCP-registry mcpName (e.g. "io.github.DHEBP/dero-mcp-server"),
      // which reads poorly in the UI — drop those legacy rows.
      const pkgName = (pkg.name as string) || name;
      const legacyIds: string[] = [];
      if (typeof pkg.mcpName === 'string' && pkg.mcpName && pkg.mcpName !== pkgName) {
        legacyIds.push(`bundled-${sanitizeId(pkg.mcpName)}`);
      }

      const mainEntry = (pkg.main as string) || './dist/index.js';
      const entryFile = mainEntry.startsWith('./') ? mainEntry.slice(2) : mainEntry;
      const entryPath = join(serverDir, entryFile);
      if (!statSync(entryPath, { throwIfNoEntry: false })?.isFile()) {
        logger.warn('mcp', `bundled server ${pkgName} missing entry: ${entryPath}`);
        continue;
      }

      await this.registerBundled({
        id: `bundled-${sanitizeId(pkgName)}`,
        name: pkgName,
        enabled: true,
        command: process.execPath,
        args: [entryPath],
        cwd: serverDir,
        timeoutMs: 30_000,
        trust: true,
        // Without this the child boots as a second Electron app instead of
        // Node running the server script, and the MCP handshake never happens.
        env: { ELECTRON_RUN_AS_NODE: '1' }
      }, legacyIds);
    }
  }

  /**
   * Insert a bundled server registration, or refresh an existing one whose
   * command/args/cwd/env drifted (paths move between dev and packaged
   * installs). Preserves the user's enabled/trust choices on update and
   * removes superseded legacy registrations.
   */
  private async registerBundled(cfg: McpServerConfig, legacyIds: string[]): Promise<void> {
    for (const legacyId of legacyIds) {
      const legacy = getDb().prepare('SELECT id FROM mcp_servers WHERE id = ?').get(legacyId) as { id: string } | undefined;
      if (legacy) {
        await this.deleteConfig(legacyId);
        logger.info('mcp', `removed legacy bundled registration ${legacyId}`);
      }
    }

    const row = getDb().prepare('SELECT * FROM mcp_servers WHERE id = ?').get(cfg.id) as Record<string, unknown> | undefined;
    if (!row) {
      await this.saveConfig(cfg);
      logger.info('mcp', `registered bundled server ${cfg.name} (${cfg.id})`);
      return;
    }

    const cur = rowToConfig(row);
    const drifted = (cur.transport ?? 'stdio') !== (cfg.transport ?? 'stdio')
      || cur.command !== cfg.command
      || JSON.stringify(cur.args || []) !== JSON.stringify(cfg.args || [])
      || cur.cwd !== cfg.cwd
      || JSON.stringify(cur.envKeys || []) !== JSON.stringify(Object.keys(cfg.env || {}));
    if (drifted) {
      await this.saveConfig({ ...cfg, enabled: cur.enabled, trust: cur.trust });
      logger.info('mcp', `refreshed bundled server ${cfg.name} (${cfg.id})`);
    }
  }

  async loadFromSettings(): Promise<void> {
    // Reading every row also migrates legacy plaintext env JSON into the
    // encrypted secret store, including disabled servers.
    const configs = (getDb().prepare('SELECT * FROM mcp_servers').all() as Array<Record<string, unknown>>)
      .map(rowToConfig)
      .filter((cfg) => cfg.enabled);
    // Connect in parallel with a short startup timeout so a slow or hanging
    // server (e.g. dero-mcp-server waiting for a remote daemon) does not
    // delay other servers or the app window.
    const STARTUP_TIMEOUT_MS = 10_000;
    await Promise.allSettled(
      configs.map(async (cfg) => {
        const cfgWithStartupTimeout = { ...cfg, timeoutMs: Math.min(cfg.timeoutMs ?? STARTUP_TIMEOUT_MS, STARTUP_TIMEOUT_MS) };
        try {
          await this.connect(cfgWithStartupTimeout);
        } catch (err) {
          logger.warn('mcp', `failed to connect ${cfg.name}: ${err instanceof Error ? err.message : String(err)}`);
          this.handleDisconnect(cfg.id, cfg, err);
        }
      })
    );
    this.emitChange();
  }

  async listConfigs(): Promise<McpServerConfig[]> {
    const rows = getDb().prepare('SELECT * FROM mcp_servers ORDER BY name').all() as Array<Record<string, unknown>>;
    return rows.map(rowToConfig);
  }

  async saveConfig(cfg: McpServerConfig): Promise<void> {
    validateMcpConfig(cfg);
    const existingRow = getDb().prepare('SELECT * FROM mcp_servers WHERE id = ?').get(cfg.id) as Record<string, unknown> | undefined;
    const existing = existingRow ? rowToConfig(existingRow) : undefined;
    const oldEnvKeys = existing?.envKeys ?? [];
    const nextEnvKeys = cfg.env === undefined ? oldEnvKeys : Object.keys(cfg.env);

    if (cfg.env !== undefined) {
      for (const key of oldEnvKeys) {
        if (!nextEnvKeys.includes(key)) deleteSecret(envSecretKey(cfg.id, key));
      }
      for (const [key, value] of Object.entries(cfg.env)) {
        // An empty editor value means "keep the saved value"; deleting the
        // line is the explicit way to remove a variable.
        if (value) setSecret(envSecretKey(cfg.id, key), value);
      }
    }

    if (cfg.transport === 'http') {
      if (cfg.clearBearerToken) deleteSecret(bearerSecretKey(cfg.id));
      else if (cfg.bearerToken) setSecret(bearerSecretKey(cfg.id), cfg.bearerToken);
    } else {
      deleteSecret(bearerSecretKey(cfg.id));
    }

    const now = Date.now();
    getDb().prepare(`
      INSERT INTO mcp_servers (id, name, enabled, transport, command, url, args, env, cwd, timeout_ms, trust, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        enabled = excluded.enabled,
        transport = excluded.transport,
        command = excluded.command,
        url = excluded.url,
        args = excluded.args,
        env = excluded.env,
        cwd = excluded.cwd,
        timeout_ms = excluded.timeout_ms,
        trust = excluded.trust,
        updated_at = excluded.updated_at
    `).run(
      cfg.id, cfg.name, cfg.enabled ? 1 : 0, cfg.transport ?? 'stdio',
      cfg.transport === 'http' ? '' : cfg.command, cfg.transport === 'http' ? cfg.url : null,
      JSON.stringify(cfg.transport === 'http' ? [] : cfg.args || []),
      JSON.stringify(nextEnvKeys),
      cfg.transport === 'http' ? null : cfg.cwd || null,
      cfg.timeoutMs || null, cfg.trust ? 1 : 0, now
    );

    // Reconnect if enabled
    await this.disconnect(cfg.id);
    if (cfg.enabled) {
      const saved = rowToConfig(getDb().prepare('SELECT * FROM mcp_servers WHERE id = ?').get(cfg.id) as Record<string, unknown>);
      try { await this.connect(saved); } catch (err) {
        logger.warn('mcp', `reconnect failed for ${cfg.name}: ${err instanceof Error ? err.message : String(err)}`);
        this.handleDisconnect(cfg.id, saved, err);
      }
    }
    this.emitChange();
  }

  async deleteConfig(id: string): Promise<void> {
    const row = getDb().prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (row) {
      const cfg = rowToConfig(row);
      for (const key of cfg.envKeys ?? []) deleteSecret(envSecretKey(id, key));
      deleteSecret(bearerSecretKey(id));
    }
    getDb().prepare('DELETE FROM mcp_servers WHERE id = ?').run(id);
    await this.disconnect(id);
    this.emitChange();
  }

  async connect(cfg: McpServerConfig): Promise<void> {
    validateMcpConfig(cfg);
    if (this.shuttingDown) throw new Error('MCP manager is shutting down');
    if (this.servers.has(cfg.id)) {
      logger.debug('mcp', `${cfg.name} already connected`);
      return;
    }
    const serverEnv: Record<string, string> = {};
    for (const key of cfg.envKeys ?? []) {
      const value = getSecret(envSecretKey(cfg.id, key));
      if (value !== undefined) serverEnv[key] = value;
    }
    const env = buildMcpChildEnv(serverEnv);
    const bearerToken = cfg.transport === 'http' ? getSecret(bearerSecretKey(cfg.id)) : undefined;
    const transport = cfg.transport === 'http'
      ? new StreamableHTTPClientTransport(new URL(cfg.url || ''), {
          requestInit: bearerToken
            ? { headers: { Authorization: `Bearer ${bearerToken}` } }
            : undefined,
          fetch: createBoundedMcpFetch()
        })
      : new BoundedStdioClientTransport({
          // The SDK delegates to cross-spawn, which resolves Windows .cmd
          // shims and invokes ComSpec /d /s /c with escaped arguments.
          command: cfg.command || '',
          args: cfg.args || [],
          env,
          cwd: cfg.cwd
        });

    const client = new Client(
      { name: 'dero-hive', version: APP_VERSION },
      { capabilities: {} }
    );

    const instance: McpServerInstance = {
      id: cfg.id,
      client,
      transport,
      status: 'connecting',
      trust: cfg.trust,
      timeoutMs: cfg.timeoutMs,
      tools: [], resources: [], prompts: []
    };
    this.servers.set(cfg.id, instance);

    const timeoutMs = cfg.timeoutMs ?? 30_000;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error(`Connection timeout after ${timeoutMs}ms`)), timeoutMs);
      timeoutHandle.unref?.();
    });

    try {
      await Promise.race([client.connect(transport), timeout]);
      instance.status = 'connected';

      // Discover tools, resources, prompts
      const [toolsRes, resourcesRes, promptsRes] = await Promise.allSettled([
        client.listTools(undefined, { timeout: timeoutMs, maxTotalTimeout: timeoutMs }),
        client.listResources(undefined, { timeout: timeoutMs, maxTotalTimeout: timeoutMs }),
        client.listPrompts(undefined, { timeout: timeoutMs, maxTotalTimeout: timeoutMs })
      ]);

      if (toolsRes.status === 'fulfilled') {
        instance.tools = (toolsRes.value.tools || []).map((t) => ({
          name: t.name,
          description: `[${cfg.name}] ${t.description || 'MCP tool'}`,
          parameters: (t.inputSchema as Record<string, unknown>) || { type: 'object', properties: {} },
          source: `mcp:${cfg.id}` as const
        }));
      }
      if (resourcesRes.status === 'fulfilled') {
        instance.resources = (resourcesRes.value.resources || []).map((r) => ({
          name: r.name,
          uri: r.uri,
          description: r.description,
          mimeType: r.mimeType
        }));
      }
      if (promptsRes.status === 'fulfilled') {
        instance.prompts = (promptsRes.value.prompts || []).map((p) => ({
          name: p.name,
          description: p.description,
          arguments: p.arguments as unknown[]
        }));
      }

      // A healthy connection resets the backoff ladder.
      this.reconnectAttempts.delete(cfg.id);
      this.lastErrors.delete(cfg.id);

      // Auto-reconnect on disconnect
      client.onclose = () => this.handleDisconnect(cfg.id, cfg);
      client.onerror = (err) => logger.warn('mcp', `${cfg.name} transport error: ${err instanceof Error ? err.message : String(err)}`);

      logger.info('mcp', `connected ${cfg.name} (${instance.tools.length} tools, ${instance.resources.length} resources, ${instance.prompts.length} prompts)`);
      this.emitChange();
    } catch (err) {
      instance.status = 'error';
      instance.error = err instanceof Error ? err.message : String(err);
      this.lastErrors.set(cfg.id, instance.error);
      try { await transport.close(); } catch { /* ignore */ }
      this.servers.delete(cfg.id);
      this.emitChange();
      throw err;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  async disconnect(id: string): Promise<void> {
    const timer = this.pendingReconnects.get(id);
    if (timer) { clearTimeout(timer); this.pendingReconnects.delete(id); }
    this.reconnectAttempts.delete(id);
    this.lastErrors.delete(id);
    const inst = this.servers.get(id);
    if (!inst) return;
    // Intentional disconnect — detach the auto-reconnect handler so closing
    // the transport doesn't schedule a reconnect that resurrects the server.
    inst.client.onclose = undefined;
    try { await inst.transport.close(); } catch { /* ignore */ }
    this.servers.delete(id);
    this.emitChange();
  }

  async shutdownAll(): Promise<void> {
    this.shuttingDown = true;
    for (const timer of this.pendingReconnects.values()) clearTimeout(timer);
    this.pendingReconnects.clear();
    this.reconnectAttempts.clear();
    const all = Array.from(this.servers.keys());
    await Promise.allSettled(all.map((id) => this.disconnect(id)));
  }

  getInstance(id: string): McpServerInstance | undefined {
    return this.servers.get(id);
  }

  getAllTools(): ToolDefinition[] {
    const entries = [...this.servers.values()].flatMap((server) =>
      server.tools.map((tool) => ({ server, tool }))
    );
    const counts = new Map<string, number>();
    for (const { tool } of entries) counts.set(tool.name, (counts.get(tool.name) || 0) + 1);
    return entries.map(({ server, tool }) => counts.get(tool.name) === 1
      ? tool
      : { ...tool, name: `mcp:${server.id}:${tool.name}` });
  }

  /**
   * Resolve a tool name — either the raw name advertised to the model, or the
   * explicit `mcp:<serverId>:<tool>` form — to its owning server, along with
   * whether that server is trusted. The caller needs the trust bit *before*
   * running the tool, so resolution cannot happen at dispatch time.
   */
  resolveTool(name: string): { serverId: string; serverName: string; toolName: string; trusted: boolean } | null {
    if (name.startsWith('mcp:')) {
      const qualified = name.slice('mcp:'.length);
      const matches = [...this.servers.values()].flatMap((inst) => {
        const prefix = `${inst.id}:`;
        if (!qualified.startsWith(prefix)) return [];
        const toolName = qualified.slice(prefix.length);
        return inst.tools.some((tool) => tool.name === toolName) ? [{ inst, toolName }] : [];
      });
      if (matches.length !== 1) return null;
      const [{ inst, toolName }] = matches;
      return { serverId: inst.id, serverName: this.configName(inst.id), toolName, trusted: !!inst.trust };
    }
    const matches = [...this.servers.values()].filter((inst) => inst.tools.some((tool) => tool.name === name));
    if (matches.length !== 1) return null;
    const [inst] = matches;
    return { serverId: inst.id, serverName: this.configName(inst.id), toolName: name, trusted: !!inst.trust };
  }

  private configName(id: string): string {
    const row = getDb().prepare('SELECT name FROM mcp_servers WHERE id = ?').get(id) as { name?: string } | undefined;
    return row?.name || id;
  }

  async callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<{ content: unknown; isError?: boolean }> {
    const inst = this.servers.get(serverId);
    if (!inst) throw new Error(`MCP server ${serverId} not connected`);
    const timeoutMs = inst.timeoutMs ?? 60_000;
    const result = await inst.client.callTool(
      { name: toolName, arguments: args },
      undefined,
      { signal, timeout: timeoutMs, maxTotalTimeout: timeoutMs }
    );
    return { content: result.content, isError: result.isError as boolean | undefined };
  }

  getStatuses(): McpServerStatus[] {
    const rows = getDb().prepare('SELECT * FROM mcp_servers ORDER BY name').all() as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const cfg = rowToConfig(row);
      const inst = this.servers.get(cfg.id);
      return {
        id: cfg.id,
        name: cfg.name,
        connected: inst?.status === 'connected',
        error: inst?.error ?? this.lastErrors.get(cfg.id),
        tools: inst?.tools || [],
        resources: inst?.resources || [],
        prompts: inst?.prompts || []
      };
    });
  }

  private handleDisconnect(id: string, cfg: McpServerConfig, cause?: unknown): void {
    // Back off exponentially and eventually give up. A server that fails on
    // every start — a bad command, a crash, a missing binary — would otherwise
    // respawn a child process every two seconds for the lifetime of the app.
    const attempt = (this.reconnectAttempts.get(id) ?? 0) + 1;
    this.servers.delete(id);
    if (cause) this.lastErrors.set(id, cause instanceof Error ? cause.message : String(cause));
    if (this.shuttingDown) return;

    if (attempt > RECONNECT_MAX_ATTEMPTS) {
      this.reconnectAttempts.delete(id);
      this.lastErrors.set(id, `Offline after ${RECONNECT_MAX_ATTEMPTS} reconnect attempts`);
      logger.error('mcp', `${cfg.name} gave up after ${RECONNECT_MAX_ATTEMPTS} reconnect attempts`);
      this.emitChange();
      return;
    }

    this.reconnectAttempts.set(id, attempt);
    const delay = Math.min(RECONNECT_DELAY_MS * 2 ** (attempt - 1), RECONNECT_MAX_DELAY_MS);
    if (!cause) this.lastErrors.set(id, `Disconnected; reconnecting in ${Math.ceil(delay / 1000)}s`);
    logger.warn('mcp', `${cfg.name} disconnected, reconnect attempt ${attempt}/${RECONNECT_MAX_ATTEMPTS} in ${delay}ms`);

    const t = setTimeout(() => {
      this.pendingReconnects.delete(id);
      if (this.shuttingDown) return;
      this.connect(cfg).catch((err) => {
        logger.error('mcp', `reconnect ${cfg.name} failed`, err);
        this.handleDisconnect(id, cfg, err);
      });
    }, delay);
    t.unref?.();
    this.pendingReconnects.set(id, t);
    this.emitChange();
  }

  private emitChange(): void {
    this.emit('change', this.getStatuses());
  }
}

function rowToConfig(row: Record<string, unknown>): McpServerConfig {
  const parsedEnv = safeJson(row.env as string, [] as string[] | Record<string, string>);
  let envKeys: string[];
  if (Array.isArray(parsedEnv)) {
    envKeys = parsedEnv.filter((key): key is string => typeof key === 'string');
  } else {
    // Pre-v7 rows stored environment values in SQLite. Seal them once and
    // immediately replace the column with key names only.
    envKeys = Object.keys(parsedEnv);
    for (const [key, value] of Object.entries(parsedEnv)) {
      if (typeof value === 'string' && value) setSecret(envSecretKey(row.id as string, key), value);
    }
    getDb().prepare('UPDATE mcp_servers SET env = ? WHERE id = ?').run(JSON.stringify(envKeys), row.id);
  }

  const base = {
    id: row.id as string,
    name: row.name as string,
    enabled: row.enabled === 1,
    envKeys,
    timeoutMs: row.timeout_ms as number | undefined,
    trust: row.trust === 1
  };
  if (row.transport === 'http') {
    return {
      ...base,
      transport: 'http' as const,
      url: row.url as string,
      hasBearerToken: !!getSecret(bearerSecretKey(row.id as string))
    };
  }
  return {
    ...base,
    transport: 'stdio' as const,
    command: row.command as string,
    args: safeJson(row.args as string, [] as string[]),
    cwd: row.cwd as string | undefined
  };
}

function safeJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

function sanitizeId(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]/g, '-');
}
