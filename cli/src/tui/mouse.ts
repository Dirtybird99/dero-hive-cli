export const ENABLE_SGR_MOUSE = '\x1b[?1003h\x1b[?1006h';
export const DISABLE_SGR_MOUSE = '\x1b[?1006l\x1b[?1003l';

export type SgrMouseEvent = {
  type: 'move' | 'left-press' | 'left-release' | 'wheel-up' | 'wheel-down';
  x: number;
  y: number;
};

const ESC = '\x1b';
const SGR_REPORT = new RegExp(`${ESC}\\[<(\\d+);(\\d+);(\\d+)([Mm])`, 'g');

const incompleteReport = (input: string) => {
  const start = input.lastIndexOf(ESC);
  if (start < 0) return '';
  const tail = input.slice(start);
  const body = tail.slice(1);
  return tail.length <= 64 &&
    ('[<'.startsWith(body) || /^\[<\d*(?:;\d*){0,2}$/.test(body))
    ? tail
    : '';
};

export class SgrMouseParser {
  private pending = '';

  get hasPendingReport(): boolean {
    return this.pending.length > 0;
  }

  push(chunk: string | Uint8Array): SgrMouseEvent[] {
    let incoming = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    if (!this.pending && incoming.startsWith('[<')) {
      incoming = ESC + incoming.replace(/([Mm])(?=\[<)/g, `$1${ESC}`);
    }
    const input = this.pending + incoming;
    const events: SgrMouseEvent[] = [];

    for (const match of input.matchAll(SGR_REPORT)) {
      const code = Number(match[1]);
      const x = Number(match[2]);
      const y = Number(match[3]);
      if (!Number.isSafeInteger(code) || code > 255 || !Number.isSafeInteger(x) || x < 1 || !Number.isSafeInteger(y) || y < 1) {
        continue;
      }

      const button = code & 3;
      const type = code & 64
        ? button === 0
          ? 'wheel-up'
          : button === 1
            ? 'wheel-down'
            : null
        : code & 32
          ? 'move'
          : button === 0
            ? match[4] === 'm'
              ? 'left-release'
              : 'left-press'
            : null;
      if (type) events.push({ type, x: x - 1, y: y - 1 });
    }

    this.pending = incompleteReport(input);
    return events;
  }
}
