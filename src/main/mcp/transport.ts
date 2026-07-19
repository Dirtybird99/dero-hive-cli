import { StdioClientTransport, type StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import { deserializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

export const MCP_FRAME_MAX_BYTES = 4 * 1024 * 1024;

export class McpFrameLimitError extends Error {
  constructor(bytes: number, maxBytes: number) {
    super(`MCP frame exceeded ${maxBytes} bytes (${bytes} bytes received)`);
    this.name = 'McpFrameLimitError';
  }
}

/** SDK-compatible newline buffer that never retains or parses an oversized stdio frame. */
export class BoundedMcpReadBuffer {
  private tail?: Buffer;
  private tailLength = 0;
  private queue: Array<JSONRPCMessage | Error> = [];
  private cursor = 0;
  private failed = false;

  constructor(
    private maxBytes = MCP_FRAME_MAX_BYTES,
    private onLimit: () => void = () => undefined
  ) {}

  append(chunk: Buffer): void {
    if (this.failed) return;
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      if (newline === -1) {
        const rest = chunk.subarray(offset);
        const bytes = this.tailLength + rest.length;
        const last = rest[rest.length - 1];
        if (bytes > this.maxBytes && !(bytes === this.maxBytes + 1 && last === 0x0d)) {
          this.reject(bytes);
          return;
        }
        this.appendTail(rest, bytes);
        return;
      }

      const part = chunk.subarray(offset, newline);
      const frameLength = this.tailLength + part.length;
      const last = part.length > 0 ? part[part.length - 1] : this.tail?.[this.tailLength - 1];
      const bytes = last === 0x0d ? frameLength - 1 : frameLength;
      if (bytes > this.maxBytes) {
        this.reject(bytes);
        return;
      }
      let frame = part;
      if (this.tailLength > 0) {
        this.appendTail(part, frameLength);
        frame = this.tail!.subarray(0, frameLength);
      }
      this.tail = undefined;
      this.tailLength = 0;
      try {
        this.queue.push(deserializeMessage(frame.toString('utf8', 0, bytes)));
      } catch (error) {
        this.queue.push(error instanceof Error ? error : new Error(String(error)));
      }
      offset = newline + 1;
    }
  }

  readMessage(): JSONRPCMessage | null {
    const next = this.queue[this.cursor];
    if (next === undefined) return null;
    this.cursor += 1;
    if (this.cursor === this.queue.length) {
      this.queue = [];
      this.cursor = 0;
    }
    if (next instanceof Error) throw next;
    return next;
  }

  clear(): void {
    this.tail = undefined;
    this.tailLength = 0;
    this.queue = [];
    this.cursor = 0;
  }

  private reject(bytes: number): void {
    this.failed = true;
    this.tail = undefined;
    this.tailLength = 0;
    this.queue.push(new McpFrameLimitError(bytes, this.maxBytes));
    this.onLimit();
  }

  private appendTail(part: Buffer, bytes: number): void {
    if (!this.tail || this.tail.length < bytes) {
      const capacity = Math.min(
        this.maxBytes + 1,
        Math.max(bytes, Math.max(1024, (this.tail?.length ?? 0) * 2))
      );
      const expanded = Buffer.allocUnsafe(capacity);
      if (this.tailLength) this.tail?.copy(expanded, 0, 0, this.tailLength);
      this.tail = expanded;
    }
    part.copy(this.tail, this.tailLength);
    this.tailLength = bytes;
  }
}

/** Keep the SDK's cross-platform process spawning while replacing its unbounded private read buffer. */
export class BoundedStdioClientTransport extends StdioClientTransport {
  constructor(server: StdioServerParameters, maxBytes = MCP_FRAME_MAX_BYTES) {
    super(server);
    const sdk = this as unknown as { _readBuffer?: unknown };
    if (!('_readBuffer' in sdk)) throw new Error('Installed MCP SDK has an incompatible stdio transport');
    sdk._readBuffer = new BoundedMcpReadBuffer(maxBytes, () => {
      queueMicrotask(() => {
        void this.close().catch((error: unknown) => {
          this.onerror?.(error instanceof Error ? error : new Error(String(error)));
        });
      });
    });
  }
}

function limitedBody(body: ReadableStream<Uint8Array>, sse: boolean, maxBytes: number): ReadableStream<Uint8Array> {
  let bytes = 0;
  let lineBytes = 0;
  let previousCr = false;
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (sse) {
        for (const byte of chunk) {
          bytes += 1;
          if (byte === 0x0d) {
            if (lineBytes === 0) bytes = 0;
            lineBytes = 0;
            previousCr = true;
          } else if (byte === 0x0a) {
            if (!previousCr && lineBytes === 0) bytes = 0;
            if (!previousCr) lineBytes = 0;
            previousCr = false;
          } else {
            lineBytes += 1;
            previousCr = false;
          }
          if (bytes > maxBytes) {
            controller.error(new McpFrameLimitError(bytes, maxBytes));
            return;
          }
        }
      } else {
        bytes += chunk.byteLength;
        if (bytes > maxBytes) {
          controller.error(new McpFrameLimitError(bytes, maxBytes));
          return;
        }
      }
      controller.enqueue(chunk);
    }
  }));
}

/** Bound direct JSON responses and each individual SSE event before the SDK parses them. */
export function createBoundedMcpFetch(
  baseFetch: FetchLike = fetch,
  maxBytes = MCP_FRAME_MAX_BYTES
): FetchLike {
  return async (url, init) => {
    const response = await baseFetch(url, init);
    if (!response.body) return response;
    const sse = response.headers.get('content-type')?.includes('text/event-stream') ?? false;
    return new Response(limitedBody(response.body, sse, maxBytes), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  };
}
