import { EventEmitter } from 'node:events';
import { isIP } from 'node:net';
import { logger } from '../utils/logger';
import type { XswdConnectionState, XswdStatus } from '@shared/types';
import { XswdClient, XSWD_DEFAULT_URL, xswdAppId, type XswdCloseInfo, type XswdWalletEvent } from './client';
import {
  validateXswdWalletAddress,
  validateXswdScInvoke,
  validateXswdTransfer,
  type XswdScInvokeParams,
  type XswdTransferParams
} from './safety';

export type { XswdScInvokeParams, XswdTransferParams } from './safety';

export type XswdSurface = 'cli' | 'desktop';

export interface XswdTransfersFilter {
  in?: boolean;
  out?: boolean;
  coinbase?: boolean;
  min_height?: number;
  max_height?: number;
}

const HANDSHAKE_TIMEOUT_MS = 60_000;

/**
 * Owns the XSWD connection lifecycle for one Hive surface (CLI or desktop).
 * Hive is the dApp side: it connects out to a running wallet's XSWD server
 * (Engram, derotui, HOLOGRAM). There is deliberately no auto-reconnect —
 * reconnecting re-triggers the wallet's approval dialog, so the user stays
 * in control via the toggle (mirrors derotui's behavior).
 */
export class XswdManager extends EventEmitter {
  private client: XswdClient | null = null;
  private state: XswdConnectionState = 'disconnected';
  private lastError: string | null = null;
  private connectedAt: number | null = null;
  private walletAddress: string | null = null;
  private url: string = XSWD_DEFAULT_URL;
  private intentionalClose = false;
  private readonly appName: string;
  private readonly onChange?: (status: XswdStatus) => void;

  constructor(surface: XswdSurface, onChange?: (status: XswdStatus) => void) {
    super();
    this.appName = surface === 'cli' ? 'DERO Hive (CLI)' : 'DERO Hive (Desktop)';
    this.onChange = onChange;
  }

  status(): XswdStatus {
    return {
      state: this.state,
      url: this.url,
      appName: this.appName,
      connectedAt: this.connectedAt,
      error: this.lastError
    };
  }

  /** Connects to the wallet. Idempotent; never throws — failures land in status().error. */
  async connect(): Promise<XswdStatus> {
    if (this.state === 'connecting' || this.state === 'awaiting-approval' || this.state === 'connected') {
      return this.status();
    }
    try {
      this.url = resolveWalletUrl();
    } catch (err) {
      this.url = XSWD_DEFAULT_URL;
      this.setState('error', friendlyConnectError(err, this.url));
      return this.status();
    }
    this.intentionalClose = false;
    const client = new XswdClient(this.url, {
      id: xswdAppId(this.appName),
      name: this.appName,
      description: 'DERO Hive AI development environment',
      url: 'http://localhost'
    });
    this.client = client;
    client.on('awaiting-approval', () => {
      if (this.client === client) this.setState('awaiting-approval');
    });
    client.on('wallet-event', (event: XswdWalletEvent) => {
      if (this.client === client) this.emit('wallet-event', event);
    });
    client.on('closed', (info: XswdCloseInfo) => this.handleClosed(client, info));
    this.setState('connecting');
    try {
      await client.connect(HANDSHAKE_TIMEOUT_MS);
      if (this.client !== client) {
        client.close();
        return this.status();
      }
      this.connectedAt = Date.now();
      this.setState('connected');
      logger.info('xswd', `connected to wallet at ${this.url} as "${this.appName}"`);
      // Cache the address (one RPC) so the write-approval review can be built
      // synchronously at gate time without a per-prompt round-trip. Fire-and-forget
      // so a slow GetAddress never stalls the connect toggle.
      void this.cacheWalletAddress(client);
    } catch (err) {
      if (this.client !== client) return this.status();
      this.client = null;
      client.removeAllListeners('closed');
      client.close();
      this.connectedAt = null;
      this.setState('error', friendlyConnectError(err, this.url));
      logger.warn('xswd', `connect failed: ${this.lastError}`);
    }
    return this.status();
  }

  /** User-intent OFF: tears down the socket without recording an error. */
  async disconnect(): Promise<XswdStatus> {
    this.intentionalClose = true;
    const client = this.client;
    this.client = null;
    this.connectedAt = null;
    this.walletAddress = null;
    if (client) {
      client.removeAllListeners('closed');
      client.close();
    }
    if (this.state !== 'disconnected') this.setState('disconnected');
    return this.status();
  }

  async getAddress(): Promise<string> {
    const result = await this.call('GetAddress');
    const address = typeof result === 'string'
      ? result
      : isRecord(result) && typeof result.address === 'string' ? result.address : null;
    try {
      return validateXswdWalletAddress(address);
    } catch {
      throw malformedResponse('GetAddress');
    }
  }

  /** The connected wallet's own address, cached at connect time. Null when disconnected
   *  or before the initial GetAddress completes. Used to decode write-approval reviews. */
  getConnectedAddress(): string | null {
    return this.walletAddress;
  }

  private async cacheWalletAddress(client: XswdClient): Promise<void> {
    try {
      const address = await this.getAddress();
      if (this.client === client) this.walletAddress = address;
    } catch (err) {
      logger.warn('xswd', 'could not cache connected wallet address', err);
    }
  }

  async getBalance(scid?: string): Promise<{ balance: number; unlocked_balance: number }> {
    const params = scid ? { scid } : undefined;
    const result = expectRecord('GetBalance', await this.call('GetBalance', params));
    return {
      balance: expectUnsignedInteger('GetBalance', result.balance),
      unlocked_balance: expectUnsignedInteger('GetBalance', result.unlocked_balance)
    };
  }

  async getHeight(): Promise<number> {
    const result = expectRecord('GetHeight', await this.call('GetHeight'));
    return expectUnsignedInteger('GetHeight', result.height);
  }

  async getTransfers(filter: XswdTransfersFilter = {}): Promise<{ entries: unknown[] }> {
    const result = expectRecord('GetTransfers', await this.call('GetTransfers', filter));
    if (result.entries !== null && !Array.isArray(result.entries)) throw malformedResponse('GetTransfers');
    return { entries: result.entries ?? [] };
  }

  async transfer(params: XswdTransferParams): Promise<{ txid: string }> {
    const walletAddress = await this.getAddress();
    const { destination, amount, scid, ringsize } = validateXswdTransfer(params, walletAddress);
    const result = await this.call('transfer', {
      transfers: [{ destination, amount, ...(scid ? { scid } : {}) }],
      ringsize
    });
    return expectTxid('transfer', result);
  }

  async scinvoke(params: XswdScInvokeParams): Promise<{ txid: string }> {
    const { scid, entrypoint, parameters, sc_dero_deposit, sc_token_deposit, ringsize } = validateXswdScInvoke(params);
    const result = await this.call('scinvoke', {
      scid,
      ringsize,
      sc_rpc: [{ name: 'entrypoint', datatype: 'S', value: entrypoint }, ...parameters],
      sc_dero_deposit,
      sc_token_deposit
    });
    return expectTxid('scinvoke', result);
  }

  private call(method: string, params?: unknown): Promise<unknown> {
    if (this.state !== 'connected' || !this.client) {
      return Promise.reject(new Error('XSWD wallet is not connected. Toggle it on with Alt+X or /xswd on.'));
    }
    return this.client.call(method, params);
  }

  private handleClosed(client: XswdClient, info: XswdCloseInfo): void {
    if (this.client !== client) return;
    // The pending connect() owns handshake failures and supplies the useful
    // refusal/denial/timeout message.
    if (!info.wasConnected) return;
    this.client = null;
    this.connectedAt = null;
    this.walletAddress = null;
    if (this.intentionalClose) {
      this.setState('disconnected');
      return;
    }
    this.setState('disconnected', 'The wallet closed the XSWD connection.');
    logger.warn('xswd', 'wallet closed the connection');
  }

  private setState(state: XswdConnectionState, error: string | null = null): void {
    this.state = state;
    this.lastError = error;
    const status = this.status();
    this.onChange?.(status);
    this.emit('status', status);
  }
}

function resolveWalletUrl(): string {
  const override = process.env.DERO_WALLET_URL?.trim();
  return override ? normalizeXswdUrl(override) : XSWD_DEFAULT_URL;
}

export function normalizeXswdUrl(value: string): string {
  const raw = value.trim();
  if (!raw) throw new Error('XSWD wallet URL is empty.');
  const explicitProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  let url: URL;
  try {
    url = new URL(explicitProtocol ? raw : `ws://${raw}`);
  } catch {
    throw new Error('XSWD wallet URL is invalid.');
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error('XSWD wallet URL must use ws:// or wss://.');
  if (url.username || url.password) throw new Error('XSWD wallet URL must not contain credentials.');
  if (raw.includes('?') || raw.includes('#')) throw new Error('XSWD wallet URL must not contain a query or fragment.');
  if (url.pathname !== '/xswd' && url.pathname !== '/xswd/') throw new Error('XSWD wallet URL path must be /xswd.');
  url.pathname = '/xswd';
  if (classifyXswdHost(url.hostname) === 'public' && url.protocol !== 'wss:') {
    if (explicitProtocol) throw new Error('Public XSWD wallet URLs must use wss://.');
    url.protocol = 'wss:';
  }
  return url.toString();
}

function classifyXswdHost(hostname: string): 'loopback' | 'lan' | 'public' {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host)) return 'loopback';
  if (isIP(host) === 4) {
    const [a, b] = host.split('.').map(Number);
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) return 'lan';
  }
  if (isIP(host) === 6) {
    const first = Number.parseInt(host.split(':')[0], 16);
    if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80) return 'lan';
  }
  return 'public';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function malformedResponse(method: string): Error {
  return new Error(`Wallet returned a malformed ${method} response.`);
}

function expectRecord(method: string, value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw malformedResponse(method);
  return value;
}

function expectUnsignedInteger(method: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw malformedResponse(method);
  return value;
}

function expectTxid(method: string, value: unknown): { txid: string } {
  const result = expectRecord(method, value);
  if (typeof result.txid !== 'string' || !/^[0-9a-f]{64}$/i.test(result.txid)) throw malformedResponse(method);
  return { txid: result.txid };
}

function friendlyConnectError(err: unknown, url: string): string {
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string } | null)?.code;
  if (code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH/.test(message)) {
    return `No XSWD wallet found at ${url}. Start Engram, Hologram, or derotui with XSWD enabled, then toggle again.`;
  }
  if (/Timed out waiting for wallet approval/.test(message)) {
    return 'Timed out waiting for wallet approval (60s). Approve DERO Hive in the wallet and toggle again.';
  }
  if (/XSWD connection closed/.test(message)) {
    return 'The wallet closed the connection before approving it.';
  }
  return message;
}
