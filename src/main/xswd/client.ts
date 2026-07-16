import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';

export const XSWD_DEFAULT_URL = 'ws://127.0.0.1:44326/xswd';

// Wallets enforce roughly 10 requests per second before disconnecting the app;
// spacing outbound frames keeps Hive safely under that ceiling.
const SEND_SPACING_MS = 125;
const MAX_WALLET_FRAME_BYTES = 1024 * 1024;
export const MAX_XSWD_SEND_QUEUE = 100;

export interface XswdAppInfo {
  id: string;
  name: string;
  description: string;
  url: string;
}

export interface XswdWalletEvent {
  event: string;
  value: unknown;
}

export interface XswdCloseInfo {
  code: number;
  reason: string;
  wasConnected: boolean;
}

/** Deterministic 64-hex application id (the XSWD handshake requires exactly 64 hex chars). */
export function xswdAppId(name: string): string {
  return createHash('sha256').update(name).digest('hex');
}

export class XswdRpcError extends Error {
  constructor(
    public readonly code: number,
    message: string
  ) {
    super(message);
    this.name = 'XswdRpcError';
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface QueuedFrame {
  id: number;
  frame: string;
}

interface HandshakeWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Minimal XSWD protocol client: WebSocket handshake with ApplicationData, then
 * JSON-RPC 2.0 with id correlation, outbound throttling, and wallet event
 * notifications. Connection lifecycle policy (reconnects, friendly errors)
 * lives in XswdManager, not here.
 */
export class XswdClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private sendQueue: QueuedFrame[] = [];
  private lastSentAt = 0;
  private flushTimer: NodeJS.Timeout | null = null;
  private accepted = false;

  constructor(
    private readonly url: string,
    private readonly app: XswdAppInfo
  ) {
    super();
  }

  get open(): boolean {
    return this.accepted && this.ws?.readyState === WebSocket.OPEN;
  }

  connect(handshakeTimeoutMs = 60_000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url, { followRedirects: false, maxPayload: MAX_WALLET_FRAME_BYTES });
      this.ws = ws;
      const timer = setTimeout(() => {
        reject(new Error('Timed out waiting for wallet approval'));
        this.close();
      }, handshakeTimeoutMs);
      const handshake: HandshakeWaiter = { resolve, reject, timer };
      ws.once('open', () => {
        ws.send(JSON.stringify(this.app));
        this.emit('awaiting-approval');
      });
      ws.once('error', (err: Error) => {
        clearTimeout(timer);
        reject(err);
      });
      ws.on('message', (data) => this.onMessage(String(data), handshake));
      ws.on('close', (code, reason) => {
        clearTimeout(timer);
        reject(new Error('XSWD connection closed'));
        this.onClose(code, reason.toString());
      });
    });
  }

  call(method: string, params?: unknown, timeoutMs = 60_000): Promise<unknown> {
    if (!this.open) return Promise.reject(new Error('XSWD connection closed'));
    if (this.sendQueue.length >= MAX_XSWD_SEND_QUEUE) {
      return Promise.reject(new Error(`XSWD send queue is full (${MAX_XSWD_SEND_QUEUE} requests)`));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.sendQueue = this.sendQueue.filter((queued) => queued.id !== id);
        reject(new Error(`XSWD request ${method} timed out (${timeoutMs / 1000}s) — check the wallet for a pending prompt`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.enqueue(id, JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) }));
    });
  }

  subscribe(event: string): Promise<unknown> {
    return this.call('Subscribe', { event });
  }

  unsubscribe(event: string): Promise<unknown> {
    return this.call('Unsubscribe', { event });
  }

  close(): void {
    const ws = this.ws;
    if (!ws) return;
    ws.removeAllListeners('error');
    ws.on('error', () => {});
    try {
      ws.close();
    } catch {
      // socket already closing/closed
    }
  }

  private onMessage(raw: string, handshake: HandshakeWaiter): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;
    const msg = parsed as Record<string, unknown>;
    if (!this.accepted && typeof msg.accepted === 'boolean') {
      clearTimeout(handshake.timer);
      if (msg.accepted) {
        this.accepted = true;
        handshake.resolve();
      } else {
        handshake.reject(new Error(String(msg.message || 'The wallet denied the connection request.')));
        this.close();
      }
      return;
    }
    const id = typeof msg.id === 'number' ? msg.id : null;
    if (id !== null) {
      const entry = this.pending.get(id);
      if (entry) {
        this.pending.delete(id);
        clearTimeout(entry.timer);
        const error = msg.error as { code?: number; message?: string } | undefined;
        if (error) entry.reject(new XswdRpcError(error.code ?? 0, friendlyRpcError(error)));
        else entry.resolve(msg.result);
      }
      return;
    }
    // Unsolicited frame = wallet event notification (new_topoheight, new_balance, new_entry).
    const params = msg.params as Record<string, unknown> | undefined;
    const event = String(params?.event ?? msg.method ?? 'unknown');
    const value = params && 'value' in params ? params.value : (msg.result ?? params);
    this.emit('wallet-event', { event, value } satisfies XswdWalletEvent);
  }

  private enqueue(id: number, frame: string): void {
    this.sendQueue.push({ id, frame });
    this.flush();
  }

  private flush(): void {
    if (this.flushTimer || this.sendQueue.length === 0) return;
    const wait = Math.max(0, this.lastSentAt + SEND_SPACING_MS - Date.now());
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      let queued = this.sendQueue.shift();
      while (queued && !this.pending.has(queued.id)) queued = this.sendQueue.shift();
      if (queued && this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(queued.frame);
        this.lastSentAt = Date.now();
      }
      this.flush();
    }, wait);
  }

  private onClose(code: number, reason: string): void {
    const wasConnected = this.accepted;
    this.accepted = false;
    this.ws = null;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.sendQueue = [];
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('XSWD connection closed'));
    }
    this.pending.clear();
    this.emit('closed', { code, reason, wasConnected } satisfies XswdCloseInfo);
  }
}

function friendlyRpcError(error: { code?: number; message?: string }): string {
  switch (error.code) {
    case -32043:
      return 'Permission denied in the wallet';
    case -32044:
      return 'Permission permanently denied in the wallet — reset it in the wallet settings';
    case -32070:
      return 'Wallet rate limit exceeded; retry in a moment';
    default:
      return error.message || 'Wallet RPC error';
  }
}
