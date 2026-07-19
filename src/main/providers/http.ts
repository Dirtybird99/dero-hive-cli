export const PROVIDER_CONTROL_TIMEOUT_MS = 30_000;
export const PROVIDER_STREAM_TIMEOUT_MS = 10 * 60_000;
export const MAX_PROVIDER_JSON_BYTES = 8 * 1024 * 1024;
export const MAX_PROVIDER_ERROR_BYTES = 64 * 1024;
export const MAX_PROVIDER_STREAM_BYTES = 32 * 1024 * 1024;
export const MAX_PROVIDER_SSE_EVENT_BYTES = 1024 * 1024;

export function providerRequestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(Math.max(1, timeoutMs));
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function readProviderText(response: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  const header = response.headers.get('content-length');
  const parsedLength = header === null ? undefined : Number(header);
  const declared = parsedLength !== undefined && Number.isSafeInteger(parsedLength) && parsedLength >= 0
    ? parsedLength
    : undefined;
  if (declared !== undefined && declared > maxBytes) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error(`Provider response exceeds ${maxBytes} byte limit`);
  }
  const reader = response.body?.getReader();
  if (!reader) return '';
  let bytes = 0;
  let body = Buffer.allocUnsafe(Math.min(maxBytes, declared || 64 * 1024));
  let complete = false;
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
      if (bytes > maxBytes) throw new Error(`Provider response exceeds ${maxBytes} byte limit`);
      if (bytes > body.length) {
        const expanded = Buffer.allocUnsafe(Math.min(maxBytes, Math.max(bytes, Math.max(1, body.length) * 2)));
        body.copy(expanded, 0, 0, bytes - value.byteLength);
        body = expanded;
      }
      body.set(value, bytes - value.byteLength);
    }
    complete = true;
    return new TextDecoder().decode(body.subarray(0, bytes));
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (!complete) void reader.cancel().catch(() => undefined);
  }
}

export async function readProviderJson<T>(response: Response, maxBytes: number, signal: AbortSignal): Promise<T> {
  return JSON.parse(await readProviderText(response, maxBytes, signal)) as T;
}
