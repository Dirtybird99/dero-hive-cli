import { createParser, type EventSourceMessage, ParseError } from 'eventsource-parser';
import { logger } from '../utils/logger';
import { MAX_PROVIDER_SSE_EVENT_BYTES, MAX_PROVIDER_STREAM_BYTES } from './http';

export interface SseEvent {
  event?: string;
  data: unknown;
  raw: string;
}

// Generic SSE parser that yields JSON-decoded data events.
// Works with both OpenAI's `data: {json}` lines and Anthropic's `event: ...` style.
export async function* parseSSE(
  response: Response,
  signal?: AbortSignal
): AsyncGenerator<SseEvent> {
  if (!response.body) throw new Error('No response body');

  const declared = Number(response.headers.get('content-length'));
  if (Number.isSafeInteger(declared) && declared > MAX_PROVIDER_STREAM_BYTES) {
    void response.body.cancel().catch(() => undefined);
    throw new Error(`Provider stream exceeds ${MAX_PROVIDER_STREAM_BYTES} byte limit`);
  }

  const queue: SseEvent[] = [];

  const parser = createParser({
    onEvent: (msg: EventSourceMessage) => {
      const raw = msg.data;
      if (Buffer.byteLength(raw, 'utf8') > MAX_PROVIDER_SSE_EVENT_BYTES) {
        throw new Error(`Provider SSE event exceeds ${MAX_PROVIDER_SSE_EVENT_BYTES} byte limit`);
      }
      let data: unknown = raw;
      if (raw && raw !== '[DONE]') {
        try { data = JSON.parse(raw); } catch { /* keep as string */ }
      }
      queue.push({ event: msg.event || undefined, data, raw });
    },
    onError: (err: ParseError) => {
      logger.debug('sse', `parser error: ${err.type}`);
    }
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let frame = Buffer.allocUnsafe(Math.min(4096, MAX_PROVIDER_SSE_EVENT_BYTES));
  let frameLength = 0;
  let lineBytes = 0;
  let pendingCr = false;
  let totalBytes = 0;
  let rejectAbort!: (error: unknown) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const abortHandler = (): void => rejectAbort(signal?.reason || new DOMException('Aborted', 'AbortError'));
  if (signal) {
    if (signal.aborted) abortHandler();
    else signal.addEventListener('abort', abortHandler, { once: true });
  }

  const appendByte = (byte: number): void => {
    if (frameLength >= MAX_PROVIDER_SSE_EVENT_BYTES) {
      throw new Error(`Provider SSE event exceeds ${MAX_PROVIDER_SSE_EVENT_BYTES} byte limit`);
    }
    if (frameLength === frame.length) {
      const expanded = Buffer.allocUnsafe(Math.min(MAX_PROVIDER_SSE_EVENT_BYTES, Math.max(1, frame.length) * 2));
      frame.copy(expanded, 0, 0, frameLength);
      frame = expanded;
    }
    frame[frameLength] = byte;
    frameLength += 1;
  };

  const feedFrame = (): void => {
    parser.feed(decoder.decode(frame.subarray(0, frameLength)));
    frameLength = 0;
  };

  try {
    for (;;) {
      const read = reader.read();
      const { value, done } = signal ? await Promise.race([read, aborted]) : await read;
      if (done) break;
      if (!value?.byteLength) continue;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_PROVIDER_STREAM_BYTES) {
        throw new Error(`Provider stream exceeds ${MAX_PROVIDER_STREAM_BYTES} byte limit`);
      }
      for (const byte of value) {
        if (pendingCr) {
          if (byte === 0x0a) {
            appendByte(byte);
            const boundary = lineBytes === 0;
            pendingCr = false;
            lineBytes = 0;
            if (boundary) {
              feedFrame();
              while (queue.length) yield queue.shift()!;
            }
            continue;
          }
          const boundary = lineBytes === 0;
          pendingCr = false;
          lineBytes = 0;
          if (boundary) {
            feedFrame();
            while (queue.length) yield queue.shift()!;
          }
        }

        appendByte(byte);
        if (byte === 0x0d) {
          pendingCr = true;
        } else if (byte === 0x0a) {
          const boundary = lineBytes === 0;
          lineBytes = 0;
          if (boundary) {
            feedFrame();
            while (queue.length) yield queue.shift()!;
          }
        } else {
          lineBytes += 1;
        }
      }
    }
    if (pendingCr && lineBytes === 0) {
      feedFrame();
      while (queue.length) yield queue.shift()!;
      pendingCr = false;
    }
    if (frameLength) {
      feedFrame();
      while (queue.length) yield queue.shift()!;
    }
  } finally {
    if (signal) signal.removeEventListener('abort', abortHandler);
    // A custom/hostile stream may never settle cancel(); cleanup cannot be
    // allowed to outlive the request deadline. Keep any rejection handled.
    try { void reader.cancel().catch(() => undefined); } catch { /* ignore */ }
  }
}

export function logStreamError(prefix: string, err: unknown): void {
  logger.error('sse', prefix, err instanceof Error ? err.message : String(err));
}
