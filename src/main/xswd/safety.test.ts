import assert from 'node:assert/strict';
import {
  bech32Encode,
  cborDecode,
  convertBits,
  decodeDeroBech32,
  encodeDeroBech32
} from '../../../resources/mcp/dero-mcp-server/src/proof-decode.js';
import {
  formatDeroAmount,
  parseDeroAmount,
  reviewXswdScInvoke,
  reviewXswdTransfer,
  validateXswdScInvoke,
  validateXswdTransfer
} from './safety.js';

const MAINNET = 'dero1qy976ssakhfynpd4lnh39u7gw9spfzr9z55ckfd0yhrhsdr235glgqq28xlvm';
const point = Uint8Array.from(Buffer.from(decodeDeroBech32(MAINNET).public_key_hex, 'hex'));
const TESTNET = encodeDeroBech32('deto', point);
const encodeRaw = (hrp: string, bytes: Uint8Array): string => bech32Encode(hrp, convertBits(Array.from(bytes), 8, 5, true));

// MAINNET is a real DERO wallet address. Checksum-only lookalikes with a bad
// curve point or an HRP/payload shape DERO's Go parser rejects must also fail.
const badPoint = Uint8Array.from([1, ...point]);
badPoint[33] = 2;
assert.throws(() => decodeDeroBech32(encodeRaw('dero', badPoint)), /compressed public key/i);
assert.throws(() => decodeDeroBech32(encodeRaw('dero', Uint8Array.from([1, ...point, 0xa0]))), /must not contain/i);
assert.throws(() => decodeDeroBech32(encodeRaw('deroi', Uint8Array.from([1, ...point]))), /missing.*CBOR/i);
assert.throws(() => decodeDeroBech32(encodeDeroBech32('deroi', point, { VX: 1n })), /unknown datatype/i);
assert.throws(() => cborDecode(Uint8Array.from([0xa2, 0x62, 0x56, 0x55, 0x01, 0x62, 0x56, 0x55, 0x02])), /duplicate map key/i);
assert.throws(() => cborDecode(Uint8Array.from([0x61, 0xff])), /encoded data was not valid/i);

assert.equal(parseDeroAmount('1'), 100_000);
assert.equal(parseDeroAmount('0.00001'), 1);
assert.equal(parseDeroAmount('2.5'), 250_000);
assert.equal(formatDeroAmount(150_001), '1.50001');
assert.throws(() => parseDeroAmount('0.000001'), /at most 5/i);
assert.throws(() => parseDeroAmount('1e2'), /decimal/i);

assert.deepEqual(validateXswdTransfer({ destination: MAINNET, amount: 100_000 }, MAINNET), {
  destination: MAINNET,
  amount: 100_000,
  ringsize: 16
});
assert.throws(
  () => validateXswdTransfer({ destination: TESTNET, amount: 1 }, MAINNET),
  /testnet\/simulator.*mainnet/i
);
assert.throws(
  () => validateXswdTransfer({ destination: 'dero1invalid', amount: 1 }, MAINNET),
  /valid DERO address/i
);

const amountInvoice = encodeDeroBech32('deroi', point, { VU: 500_000n });
assert.equal(validateXswdTransfer({ destination: amountInvoice, amount: 500_000 }, MAINNET).amount, 500_000);
assert.throws(
  () => validateXswdTransfer({ destination: amountInvoice, amount: 500_000, scid: 'ab'.repeat(32) }, MAINNET),
  /native DERO, not a token/i
);
assert.throws(
  () => validateXswdTransfer({ destination: amountInvoice, amount: 400_000 }, MAINNET),
  /exactly 5\.00000 DERO/i
);
const expiredInvoice = encodeDeroBech32('deroi', point, { ET: new Date('2024-01-01T00:00:00Z'), VU: 500_000n });
assert.throws(
  () => validateXswdTransfer({ destination: expiredInvoice, amount: 500_000 }, MAINNET, new Date('2024-01-02T00:00:00Z')),
  /expired/i
);
const futureInvoice = encodeDeroBech32('deroi', point, { ET: new Date('2024-01-03T00:00:00Z'), VU: 500_000n });
assert.equal(
  validateXswdTransfer({ destination: futureInvoice, amount: 500_000 }, MAINNET, new Date('2024-01-02T00:00:00Z')).amount,
  500_000
);
const wrongExpiryType = encodeDeroBech32('deroi', point, { EU: 1n });
assert.throws(
  () => validateXswdTransfer({ destination: wrongExpiryType, amount: 1 }, MAINNET),
  /reserved E argument/i
);
const tokenScid = 'ab'.repeat(32);
const tokenInvoice = encodeDeroBech32('deroi', point, { AH: Uint8Array.from(Buffer.from(tokenScid, 'hex')), VU: 5n });
assert.throws(() => validateXswdTransfer({ destination: tokenInvoice, amount: 5 }, MAINNET), /requests token SCID/i);
assert.throws(
  () => validateXswdTransfer({ destination: tokenInvoice, amount: 5, scid: 'cd'.repeat(32) }, MAINNET),
  /not cd/i
);
assert.equal(validateXswdTransfer({ destination: tokenInvoice, amount: 5, scid: tokenScid }, MAINNET).scid, tokenScid);
const displayEscapeInvoice = encodeDeroBech32('deroi', point, { CS: '\u001b[2J' });
const displayReview = reviewXswdTransfer({ destination: displayEscapeInvoice, amount: 1 }, MAINNET).lines.join('\n');
assert.equal(displayReview.includes(String.fromCharCode(27)), false);
assert.match(displayReview, /\\u001b\[2J/);

const invoke = validateXswdScInvoke({
  scid: 'AB'.repeat(32),
  entrypoint: 'Vote',
  parameters: [{ name: 'choice', datatype: 'U', value: 1 }],
  sc_dero_deposit: 100_000
});
assert.equal(invoke.scid, 'ab'.repeat(32));
assert.equal(invoke.ringsize, 2);
assert.match(reviewXswdScInvoke(invoke).lines.join('\n'), /burned\/deposited into contract/i);
assert.throws(() => validateXswdScInvoke({ scid: 'ab'.repeat(32), entrypoint: 'Bad name' }), /identifier/i);
assert.throws(
  () => validateXswdScInvoke({ scid: 'ab'.repeat(32), entrypoint: 'Vote', sc_dero_deposit: -1 }),
  /non-negative/i
);
assert.throws(
  () => validateXswdScInvoke({ scid: 'ab'.repeat(32), entrypoint: 'Vote', ringsize: 3 }),
  /power of 2/i
);

console.log('xswd safety tests passed');
