import { lookup } from 'node:dns/promises';
import type { LookupFunction } from 'node:net';
import ipaddr from 'ipaddr.js';
import { Agent } from 'undici';

export const MAX_MEDIA_BYTES = 50 * 1024 * 1024;
export const MAX_MEDIA_API_BODY_BYTES = MAX_MEDIA_BYTES * 2 + 1024 * 1024;
export const MAX_MEDIA_CONTROL_BODY_BYTES = 1024 * 1024;
export const MEDIA_REQUEST_TIMEOUT_MS = 120_000;
export const MEDIA_TEST_TIMEOUT_MS = 15_000;

const MAX_REDIRECTS = 5;

export interface MediaHttpResponse {
  ok: boolean;
  status: number;
  headers: Headers;
  body: Buffer;
}

interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
  dispatcher?: Agent;
}

export type MediaHostResolver = (host: string) => Promise<string[]>;
const realResolver: MediaHostResolver = async (host) => (await lookup(host, { all: true })).map((entry) => entry.address);
let resolveMediaHost: MediaHostResolver = realResolver;

/** Test seam for SSRF and DNS-rebinding checks. Pass null to restore DNS. */
export function __setMediaHostResolverForTest(resolver: MediaHostResolver | null): void {
  resolveMediaHost = resolver ?? realResolver;
}

function blockedAddress(input: string): boolean {
  let address: ReturnType<typeof ipaddr.parse>;
  try { address = ipaddr.parse(input); } catch { return true; }
  if (address.kind() === 'ipv6') {
    const v6 = address as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) return v6.toIPv4Address().range() !== 'unicast';
    return v6.range() !== 'unicast';
  }
  return (address as ipaddr.IPv4).range() !== 'unicast';
}

async function publicAddresses(host: string): Promise<Array<{ address: string; family: 4 | 6 }>> {
  const addresses = await resolveMediaHost(host);
  if (addresses.length === 0) throw new Error(`media host ${host} resolved to no addresses`);
  const records = addresses.map((address) => {
    if (blockedAddress(address)) throw new Error(`media URL resolves to a non-public address (${address})`);
    return { address, family: ipaddr.parse(address).kind() === 'ipv4' ? 4 as const : 6 as const };
  });
  return records;
}

/** Test the same resolver validation used by the actual socket lookup. */
export async function __resolvePublicMediaHostForTest(host: string): Promise<string[]> {
  return (await publicAddresses(host)).map((entry) => entry.address);
}

function publicLookup(): LookupFunction {
  return (hostname, options, callback) => {
    publicAddresses(hostname).then((records) => {
      const requestedFamily = options.family === 4 || options.family === 6 ? options.family : undefined;
      const eligible = requestedFamily ? records.filter((record) => record.family === requestedFamily) : records;
      if (eligible.length === 0) throw new Error(`media host ${hostname} has no IPv${requestedFamily} address`);
      if (options.all) callback(null, eligible);
      else callback(null, eligible[0].address, eligible[0].family);
    }).catch((error: unknown) => {
      callback(Object.assign(error instanceof Error ? error : new Error(String(error)), { code: 'EHOSTUNREACH' }), '');
    });
  };
}

function privateConfiguredOrigin(baseUrl: string): string | undefined {
  try {
    const url = new URL(baseUrl);
    const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '').toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost') || (ipaddr.isValid(host) && blockedAddress(host))) {
      return url.origin;
    }
  } catch { /* invalid provider URLs fail when requested */ }
  return undefined;
}

async function validateRemoteUrl(url: URL): Promise<void> {
  if (url.protocol !== 'https:') throw new Error('remote media URL must use HTTPS');
  if (url.username || url.password) throw new Error('media URL credentials are not allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost')) throw new Error('media URL points to localhost');
  if (ipaddr.isValid(host)) {
    if (blockedAddress(host)) throw new Error(`media URL points to a non-public address (${host})`);
    return;
  }
  if (/^[0-9.]+$/.test(host) || host.includes(':')) throw new Error(`media URL has a malformed IP address (${host})`);
  await publicAddresses(host); // fail closed before fetch; the socket lookup validates again and pins the accepted result
}

async function readBoundedBody(response: Response, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error(`Response exceeds ${Math.round(maxBytes / 1024 / 1024)} MB limit`);
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let bytes = 0;
  let rejectAbort!: (error: unknown) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = (): void => rejectAbort(signal.reason || new DOMException('Aborted', 'AbortError'));
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    if (signal.aborted) onAbort();
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      if (!value?.byteLength) continue;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error(`Response exceeds ${Math.round(maxBytes / 1024 / 1024)} MB limit`);
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, bytes);
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (bytes > maxBytes || signal.aborted) void reader.cancel().catch(() => undefined);
  }
}

export async function fetchMediaResponse(
  input: string,
  init: RequestInit = {},
  options: RequestOptions = {}
): Promise<MediaHttpResponse> {
  const controller = new AbortController();
  const timeoutMs = Math.max(1, options.timeoutMs ?? MEDIA_REQUEST_TIMEOUT_MS);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`Media request timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  timer.unref?.();
  const onAbort = (): void => controller.abort(options.signal?.reason);
  if (options.signal) {
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const response = await fetch(input, {
      ...init,
      signal: controller.signal,
      ...(options.dispatcher ? { dispatcher: options.dispatcher } : {})
    } as RequestInit & { dispatcher?: Agent });
    if (init.redirect === 'manual' && response.status >= 300 && response.status < 400) {
      void response.body?.cancel().catch(() => undefined);
      return { ok: response.ok, status: response.status, headers: response.headers, body: Buffer.alloc(0) };
    }
    const body = await readBoundedBody(response, options.maxBytes ?? MAX_MEDIA_CONTROL_BODY_BYTES, controller.signal);
    return { ok: response.ok, status: response.status, headers: response.headers, body };
  } catch (error) {
    if (!controller.signal.aborted) controller.abort(error);
    if (timedOut) throw new Error(`Media request timed out after ${timeoutMs}ms`, { cause: error });
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

/** Download a URL supplied by a provider response. Only an explicitly configured
 * private provider origin may remain private; every other hop is HTTPS, resolved
 * fail-closed, and revalidated by the lookup used for the actual connection. */
export async function downloadReturnedMedia(
  startUrl: string,
  providerBaseUrl: string,
  options: Omit<RequestOptions, 'dispatcher'> & { init?: RequestInit } = {}
): Promise<MediaHttpResponse> {
  const dispatcher = new Agent({ connect: { lookup: publicLookup() } });
  const deadline = Date.now() + Math.max(1, options.timeoutMs ?? MEDIA_REQUEST_TIMEOUT_MS);
  const localOrigin = privateConfiguredOrigin(providerBaseUrl);
  let localChain = false;
  let current = startUrl;
  let init = options.init || {};
  try {
    if (new URL(startUrl).origin !== new URL(providerBaseUrl).origin) init = { ...init, headers: undefined };
  } catch { /* URL validation below provides the user-facing error */ }
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      let url: URL;
      try { url = new URL(current); } catch { throw new Error('provider returned an invalid media URL'); }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('media URL must use HTTP or HTTPS');
      if (url.username || url.password) throw new Error('media URL credentials are not allowed');
      const sameConfiguredLocalOrigin = !!localOrigin && url.origin === localOrigin;
      localChain = hop === 0 ? sameConfiguredLocalOrigin : localChain && sameConfiguredLocalOrigin;
      if (!localChain) await validateRemoteUrl(url);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('Media download timed out');
      const response = await fetchMediaResponse(url.toString(), { ...init, redirect: 'manual' }, {
        signal: options.signal,
        timeoutMs: remaining,
        maxBytes: options.maxBytes ?? MAX_MEDIA_BYTES,
        dispatcher: localChain ? undefined : dispatcher
      });
      if (response.status < 300 || response.status >= 400) return response;
      const location = response.headers.get('location');
      if (!location) return response;
      const next = new URL(location, url);
      if (next.origin !== url.origin) init = { ...init, headers: undefined };
      current = next.toString();
    }
    throw new Error(`Media download exceeded ${MAX_REDIRECTS} redirects`);
  } finally {
    try { await dispatcher.destroy(); } catch { /* best effort */ }
  }
}

export function abortableMediaDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason || new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason || new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
