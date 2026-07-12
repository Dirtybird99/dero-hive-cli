import { createParser, type EventSourceMessage, ParseError } from 'eventsource-parser';
import { logger } from '../utils/logger';

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

  const queue: SseEvent[] = [];
  let resolver: (() => void) | null = null;
  let error: Error | null = null;
  let done = false;

  const wake = (): void => {
    if (resolver) { const r = resolver; resolver = null; r(); }
  };

  const parser = createParser({
    onEvent: (msg: EventSourceMessage) => {
      const raw = msg.data;
      let data: unknown = raw;
      if (raw && raw !== '[DONE]') {
        try { data = JSON.parse(raw); } catch { /* keep as string */ }
      }
      queue.push({ event: msg.event || undefined, data, raw });
      wake();
    },
    onError: (err: ParseError) => {
      logger.debug('sse', `parser error: ${err.type}`);
    }
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const abortHandler = (): void => {
    error = new Error('Aborted');
    done = true;
    try { void reader.cancel(); } catch { /* ignore */ }
    wake();
  };
  if (signal) {
    if (signal.aborted) abortHandler();
    else signal.addEventListener('abort', abortHandler);
  }

  (async () => {
    try {
      while (!done) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) {
          done = true;
          wake();
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        parser.feed(buffer);
        buffer = '';
      }
    } catch (err) {
      error = err as Error;
      done = true;
      wake();
    }
  })();

  try {
    while (true) {
      if (queue.length === 0) {
        if (error) throw error;
        if (done) return;
        await new Promise<void>((r) => { resolver = r; });
        continue;
      }
      yield queue.shift()!;
      if (done && queue.length === 0) return;
    }
  } finally {
    if (signal) signal.removeEventListener('abort', abortHandler);
    try { await reader.cancel(); } catch { /* ignore */ }
  }
}

export function logStreamError(prefix: string, err: unknown): void {
  logger.error('sse', prefix, err instanceof Error ? err.message : String(err));
}