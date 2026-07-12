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
