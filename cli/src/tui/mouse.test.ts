import assert from 'node:assert/strict';
import { DISABLE_SGR_MOUSE, ENABLE_SGR_MOUSE, SgrMouseParser } from './mouse.js';

assert.equal(ENABLE_SGR_MOUSE, '\x1b[?1003h\x1b[?1006h');
assert.equal(DISABLE_SGR_MOUSE, '\x1b[?1006l\x1b[?1003l');

const parser = new SgrMouseParser();
assert.deepEqual(
  parser.push('\x1b[<0;1;1M\x1b[<35;8;4M\x1b[<64;8;4M\x1b[<65;8;4M\x1b[<0;8;4m'),
  [
    { type: 'left-press', x: 0, y: 0 },
    { type: 'move', x: 7, y: 3 },
    { type: 'wheel-up', x: 7, y: 3 },
    { type: 'wheel-down', x: 7, y: 3 },
    { type: 'left-release', x: 7, y: 3 }
  ]
);

assert.deepEqual(parser.push(Buffer.from('ignored\x1b[<16;12')), []);
assert.equal(parser.hasPendingReport, true);
assert.deepEqual(parser.push(Buffer.from(';6M')), [{ type: 'left-press', x: 11, y: 5 }]);
assert.equal(parser.hasPendingReport, false);
assert.deepEqual(parser.push('\x1b[<2;1;1M\x1b[<0;0;1M'), []);

assert.deepEqual(
  new SgrMouseParser().push('[<35;4;3M[<0;4;3M'),
  [{ type: 'move', x: 3, y: 2 }, { type: 'left-press', x: 3, y: 2 }]
);

// --- Out-of-range parameters and unknown buttons ---

const once = (s: string) => new SgrMouseParser().push(s);

// Button codes above 255 and coordinates below 1 are rejected outright.
assert.deepEqual(once('\x1b[<256;1;1M'), []);
assert.deepEqual(once('\x1b[<0;5;0M'), []);
// Coordinates too large for a safe integer are rejected too.
assert.deepEqual(once('\x1b[<0;99999999999999999999;1M'), []);

// Unknown buttons produce no event: middle press, wheel-left/right (buttons 2/3
// of the wheel group).
assert.deepEqual(once('\x1b[<1;2;2M'), []);
assert.deepEqual(once('\x1b[<66;3;4M'), []);
assert.deepEqual(once('\x1b[<67;3;4M'), []);

// Modifier bits (shift=4, ctrl=16) do not change the decoded button.
assert.deepEqual(once('\x1b[<4;10;5M'), [{ type: 'left-press', x: 9, y: 4 }]);
assert.deepEqual(once('\x1b[<4;10;5m'), [{ type: 'left-release', x: 9, y: 4 }]);
assert.deepEqual(once('\x1b[<68;3;4M'), [{ type: 'wheel-up', x: 2, y: 3 }]);
assert.deepEqual(once('\x1b[<81;3;4M'), [{ type: 'wheel-down', x: 2, y: 3 }]);

// Drag reports (motion bit 32 + a held button) decode as plain moves.
assert.deepEqual(once('\x1b[<32;6;7M'), [{ type: 'move', x: 5, y: 6 }]);
assert.deepEqual(once('\x1b[<34;6;7M'), [{ type: 'move', x: 5, y: 6 }]);

// The final M/m byte only distinguishes press vs release for the left button:
// wheel and motion reports decode the same for either final byte.
assert.deepEqual(once('\x1b[<64;9;9m'), [{ type: 'wheel-up', x: 8, y: 8 }]);
assert.deepEqual(once('\x1b[<35;9;9m'), [{ type: 'move', x: 8, y: 8 }]);

// --- Reports split across chunk boundaries ---

// A chunk boundary immediately after ESC keeps the lone ESC pending and the
// report completes on the next chunk (no ESC re-injection while pending).
{
  const p = new SgrMouseParser();
  assert.deepEqual(p.push('\x1b'), []);
  assert.equal(p.hasPendingReport, true);
  assert.deepEqual(p.push('[<65;10;20M'), [{ type: 'wheel-down', x: 9, y: 19 }]);
  assert.equal(p.hasPendingReport, false);
}

// A complete report followed by a truncated one in the same chunk: the first
// is emitted immediately, the tail is buffered and completed by the next chunk.
{
  const p = new SgrMouseParser();
  assert.deepEqual(p.push('\x1b[<0;3;3M\x1b[<0;4'), [{ type: 'left-press', x: 2, y: 2 }]);
  assert.equal(p.hasPendingReport, true);
  assert.deepEqual(p.push(';4m'), [{ type: 'left-release', x: 3, y: 3 }]);
}

// Pending fragments longer than 64 bytes are discarded, not buffered forever.
{
  const p = new SgrMouseParser();
  assert.deepEqual(p.push('\x1b[<' + '1'.repeat(70)), []);
  assert.equal(p.hasPendingReport, false);
  assert.deepEqual(p.push(';1;1M'), []);
}

// Non-mouse escape sequences and malformed params are not buffered as pending.
{
  const p = new SgrMouseParser();
  assert.deepEqual(p.push('\x1b[A'), []);
  assert.equal(p.hasPendingReport, false);
  assert.deepEqual(p.push('\x1b[<a;1;1M'), []);
  assert.equal(p.hasPendingReport, false);
  assert.deepEqual(p.push('\x1b[<0;1;2;3'), []);
  assert.equal(p.hasPendingReport, false);
}
