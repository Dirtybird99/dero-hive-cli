/**
 * DERO bn256 (alt_bn128 / bn254) constants and helpers.
 *
 * DERO uses the Pedersen base point `G = HashToPoint(HashtoNumber("DEROG"))`
 * (`cryptography/crypto/algebra_pedersen.go:36`). It is NOT the standard bn254
 * generator. Extracted once from a Go scratch program against the DEROHE
 * Release 142 checkout — see `scripts/extract-g.go` (kept out-of-tree, regen
 * instructions below) — and pinned here so this server does not need to
 * reimplement HashToPoint.
 *
 * Wire format for compressed points (33 bytes, mirrors
 * `cryptography/bn256/changes.go:19-35`):
 *
 *   bytes[0..32]  X coordinate, big-endian (32 bytes)
 *   bytes[32]     sign byte:
 *                   0x00 if the original Y is the smaller of the two
 *                        square roots of x^3 + 3 mod P (i.e. Y < P - Y)
 *                   0x01 if Y is the larger one
 *
 * To re-extract after a DEROHE update, drop this into
 * `<derohe>/cmd/extract_g/main.go` and `go run ./cmd/extract_g/`:
 *
 *   package main
 *   import (
 *     "fmt"; "math/big"
 *     "github.com/deroproject/derohe/cryptography/bn256"
 *     "github.com/deroproject/derohe/cryptography/crypto"
 *   )
 *   func main() {
 *     dump := func(l string, p *bn256.G1) { fmt.Printf("%s: %x\n", l, p.EncodeCompressed()) }
 *     dump("G", crypto.G)
 *     two := new(bn256.G1).Add(crypto.G, crypto.G); dump("2G", two)
 *     dump("-G", new(bn256.G1).Neg(crypto.G))
 *     dump("G*100000", new(bn256.G1).ScalarMult(crypto.G, new(big.Int).SetUint64(100_000)))
 *   }
 */

/** Pedersen base point G, 33-byte compressed hex (DERO format). */
export const DERO_G_COMPRESSED_HEX =
  '02eacfbf92b94015c9b0b3d901dae37ec68f74dea7e4484c76d505aade4ad7c001'

/** bn254 prime field modulus. */
export const BN254_P =
  0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47n

/** bn254 curve order (subgroup order r). */
export const BN254_R =
  0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n

/** Curve equation constant: y^2 = x^3 + B. */
export const BN254_B = 3n

/**
 * Cross-implementation verification fixtures — produced by the Go scratch
 * program above and used by the TS bn254 wrapper's self-tests. If the TS
 * implementation cannot reproduce these compressed bytes from the underlying
 * scalar operations, the noble-curves wiring or the DERO compression format
 * is wrong — bail before forging anything.
 */
export const CURVE_FIXTURES = {
  /** G itself. */
  G: '02eacfbf92b94015c9b0b3d901dae37ec68f74dea7e4484c76d505aade4ad7c001',
  /** 2G = G + G. */
  twoG: '1723c9b5c0c573e9d202fea0243d5ffa5ca5e1adcfd50d0c0d53c48e1f190e0b00',
  /** 3G = 2G + G. */
  threeG: '187768b7ba4478fd947490d31d6f10ce393c7429e1166f42a5bbc1d9a487a33600',
  /** -G (negation). */
  negG: '02eacfbf92b94015c9b0b3d901dae37ec68f74dea7e4484c76d505aade4ad7c000',
  /** G * 100_000 (= 1 DERO in atomic units — the smallest "real" forge scalar). */
  gMul1Dero: '1d03a5cf6ceb36e69d4e312d9f3d8413dd463f5f3498a31468bf9b46abbdd2e001',
  /**
   * G * int64(uint64(18446744073709451616)) = G * -100000 — the proof.go:89
   * scalar for the docs-page demo's -1 DERO forge. Verifies the TS
   * uint64→signed-scalar reduction matches Go's int64 cast.
   */
  gMulNeg1DeroAtoms:
    '1d03a5cf6ceb36e69d4e312d9f3d8413dd463f5f3498a31468bf9b46abbdd2e000',
  /**
   * G * int64(uint64(18446743853709551435)) = G * -220000000181 — the scalar
   * proof.Prove() actually uses for the cited 2022 inflation-claim proof's V.
   * Verifies the TS path reproduces the on-the-wire scalar for the
   * real-world adversarial input.
   */
  gMulCited2022V: '0a5d16be695e5ca24f8f83e6a2f39a1bafe5251b69e182efbb90d41801782d1b00',
} as const

/** Atomic units per DERO. */
export const DERO_ATOMIC = 100_000n
