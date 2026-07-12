/**
 * Thin wrapper around `@noble/curves` bn254 G1 for the FORGE feature.
 *
 * Two responsibilities:
 *   1. Expose DERO's custom Pedersen base point `G` (not the standard bn254
 *      generator). See [src/dero-curve.ts](./dero-curve.ts) for the source.
 *   2. Compress/decompress points in **DERO format** (big-endian X + 1 sign
 *      byte), not the SEC1 format noble uses natively.
 *
 * Compression format mirrors `derohe/cryptography/bn256/changes.go:19-35`:
 *   bytes[0..32] = X big-endian
 *   bytes[32]    = 0x01 if Y is the larger of the two square roots of x^3 + 3
 *                  mod P (i.e. Y > P - Y), else 0x00.
 *
 * Scalar handling mirrors `proof.go:89` — DERO casts `uint64 → int64` before
 * passing to `big.Int.SetInt64`, so the uint64 wraparound `18446744073709451616`
 * becomes scalar `-100000`. `scalarMult` accepts arbitrary signed bigints and
 * reduces mod the curve order before multiplication.
 */

import { bn254 } from '@noble/curves/bn254.js'

import {
  BN254_B,
  BN254_P,
  BN254_R,
  CURVE_FIXTURES,
  DERO_G_COMPRESSED_HEX,
} from './dero-curve.js'

const Point = bn254.G1.Point
const Fp = bn254.G1.Point.Fp

export type DeroPoint = InstanceType<typeof Point>

// ─────────────────────────────────────────────────────────────────────────────
// Hex / bytes helpers (private — proof-decode.ts has its own copies).
// ─────────────────────────────────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error(`hex: odd length ${hex.length}`)
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    const b = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    if (Number.isNaN(b)) throw new Error(`hex: invalid byte "${hex.slice(i * 2, i * 2 + 2)}"`)
    out[i] = b
  }
  return out
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return hex
}

function bigIntToBE32(value: bigint): Uint8Array {
  if (value < 0n || value >= 1n << 256n) {
    throw new Error(`bigIntToBE32: out of range ${value}`)
  }
  const out = new Uint8Array(32)
  let v = value
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return out
}

function be32ToBigInt(bytes: Uint8Array, offset = 0): bigint {
  let v = 0n
  for (let i = 0; i < 32; i++) v = (v << 8n) | BigInt(bytes[offset + i])
  return v
}

// ─────────────────────────────────────────────────────────────────────────────
// DERO-format compress / decompress
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Decompress a 33-byte DERO point. Throws on malformed input or x not on curve.
 *
 * Logic mirrors `Decompress` in `cryptography/bn256/changes.go:215-241`:
 * compute both square roots of x^3 + 3 mod P, then pick smaller/larger based
 * on the sign byte.
 */
export function deroDecompress(bytes: Uint8Array): DeroPoint {
  if (bytes.length !== 33) {
    throw new Error(`deroDecompress: expected 33 bytes, got ${bytes.length}`)
  }
  const sign = bytes[32]
  if (sign !== 0 && sign !== 1) {
    throw new Error(`deroDecompress: invalid sign byte 0x${sign.toString(16).padStart(2, '0')}`)
  }
  const x = be32ToBigInt(bytes, 0)
  if (x >= BN254_P) throw new Error(`deroDecompress: x >= P`)

  // rhs = x^3 + B mod P, computed in the field.
  const xF = Fp.create(x)
  const x3 = Fp.mul(Fp.mul(xF, xF), xF)
  const rhs = Fp.add(x3, Fp.create(BN254_B))

  const y1 = Fp.sqrt(rhs)
  if (y1 === undefined) throw new Error('deroDecompress: x not on curve (no sqrt)')
  const y2 = Fp.neg(y1)

  // Confirm we actually got a square root (defensive — Fp.sqrt may return any root).
  if (Fp.mul(y1, y1) !== rhs) throw new Error('deroDecompress: sqrt verification failed')

  const smaller = y1 < y2 ? y1 : y2
  const larger = y1 < y2 ? y2 : y1
  const y = sign === 0 ? smaller : larger

  return Point.fromAffine({ x: xF, y })
}

/**
 * Compress a point to DERO 33-byte format.
 *
 * Mirrors `Compress` in `cryptography/bn256/changes.go:19-35`:
 *   sign = 0 if Y < P - Y, else 1.
 */
export function deroCompress(point: DeroPoint): Uint8Array {
  const { x, y } = point.toAffine()
  const out = new Uint8Array(33)
  out.set(bigIntToBE32(x), 0)
  const negY = (BN254_P - y) % BN254_P
  out[32] = y < negY ? 0 : 1
  return out
}

/** Convenience: hex string round-trip. */
export function deroDecompressHex(hex: string): DeroPoint {
  return deroDecompress(hexToBytes(hex))
}

/** Convenience: returns lowercase hex of the 33-byte compressed form. */
export function deroCompressHex(point: DeroPoint): string {
  return bytesToHex(deroCompress(point))
}

// ─────────────────────────────────────────────────────────────────────────────
// Point operations
// ─────────────────────────────────────────────────────────────────────────────

/** DERO's Pedersen base point G (custom — not the standard bn254 generator). */
export const G: DeroPoint = deroDecompressHex(DERO_G_COMPRESSED_HEX)

/**
 * Scalar multiplication mirroring `proof.go:89`.
 *
 * DERO casts `uint64 → int64 → big.Int` before multiplying, so the uint64
 * wraparound `2^64 - n` for small `n` becomes the negative scalar `-n`. We
 * accept arbitrary signed bigints here and reduce mod the curve order before
 * delegating to noble.
 */
export function scalarMult(point: DeroPoint, scalar: bigint): DeroPoint {
  const r = BN254_R
  let s = scalar % r
  if (s < 0n) s += r
  if (s === 0n) return Point.ZERO
  return point.multiply(s)
}

/**
 * Treat `value` as a Go `uint64`, mimic `big.Int.SetInt64(int64(value))`, and
 * return the resulting signed scalar reduced mod the curve order.
 *
 * For the cited 2022 proof's V = 18446743853709551435, this returns the
 * curve-order reduction of -220000000181 — the same scalar `proof.Prove()` uses.
 */
export function uint64ToSignedScalar(uintValue: bigint): bigint {
  if (uintValue < 0n || uintValue >= 1n << 64n) {
    throw new Error(`uint64ToSignedScalar: out of uint64 range ${uintValue}`)
  }
  return uintValue >= 1n << 63n ? uintValue - (1n << 64n) : uintValue
}

export function add(a: DeroPoint, b: DeroPoint): DeroPoint {
  return a.add(b)
}

export function subtract(a: DeroPoint, b: DeroPoint): DeroPoint {
  return a.subtract(b)
}

export function negate(point: DeroPoint): DeroPoint {
  return point.negate()
}

export function pointsEqual(a: DeroPoint, b: DeroPoint): boolean {
  return a.equals(b)
}

// ─────────────────────────────────────────────────────────────────────────────
// Self-test against the Go-extracted fixtures.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Re-derive each fixture from scalar operations and compare against the
 * compressed bytes printed by the Go scratch program. Throws on any mismatch.
 *
 * This is the cross-implementation correctness gate — if the wiring is wrong
 * (custom G missing, SEC1 vs DERO compression confused, sqrt root inversion),
 * one of the six fixtures will fail and forging anything else is unsafe.
 */
export function verifyDeroBn254(): void {
  const checks: Array<[string, string, DeroPoint]> = [
    ['G', CURVE_FIXTURES.G, G],
    ['2G', CURVE_FIXTURES.twoG, G.double()],
    ['3G', CURVE_FIXTURES.threeG, G.double().add(G)],
    ['-G', CURVE_FIXTURES.negG, G.negate()],
    ['G*100000', CURVE_FIXTURES.gMul1Dero, scalarMult(G, 100_000n)],
    [
      'G*int64(uint_wrap)',
      CURVE_FIXTURES.gMulNeg1DeroAtoms,
      scalarMult(G, uint64ToSignedScalar(18446744073709451616n)),
    ],
    [
      'G*int64(cited2022V)',
      CURVE_FIXTURES.gMulCited2022V,
      scalarMult(G, uint64ToSignedScalar(18446743853709551435n)),
    ],
  ]
  for (const [label, expectedHex, point] of checks) {
    const actualHex = deroCompressHex(point)
    if (actualHex !== expectedHex) {
      throw new Error(
        `verifyDeroBn254: ${label} mismatch\n  expected: ${expectedHex}\n  actual:   ${actualHex}`,
      )
    }
  }
}
