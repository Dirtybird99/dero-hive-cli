import assert from 'node:assert/strict';
import { sanitizeTerminalText } from './terminal.js';

assert.equal(sanitizeTerminalText('plain\r\ntext\tstays'), 'plain\ntext\tstays');
assert.equal(sanitizeTerminalText('a\u001b[31mred\u001b[0mz'), 'aredz');
assert.equal(sanitizeTerminalText('before\u001b]52;c;c2VjcmV0\u0007after'), 'beforeafter');
assert.equal(sanitizeTerminalText('x\u001bPpayload\u001b\\y'), 'xy');
assert.equal(sanitizeTerminalText('safe\u009b2Jtext\u202Espoof'), 'safetextspoof');
// A sequence split between stream chunks is still harmless: its ESC/control
// introducer is removed even when the remainder has not arrived yet.
assert.equal(sanitizeTerminalText('\u001b]52;c;'), '52;c;');

console.log('terminal sanitization tests passed');
