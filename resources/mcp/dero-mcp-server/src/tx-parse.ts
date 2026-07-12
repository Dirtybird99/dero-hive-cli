/**
 * Minimal DERO transaction parser — extracts what the FORGE feature needs.
 *
 * Parses NORMAL, BURN_TX, and SC_TX transactions up through each payload's
 * Statement (in particular, the `C[]` array of ring commitments). Does NOT
 * parse the Bulletproof / sigma proofs at the end of the TX — they are large,
 * complex, and irrelevant to forging a display-only payload proof.
 *
 * Wire format mirrors `transaction/transaction.go:Deserialize` (TX outer
 * structure) and `cryptography/crypto/protocol_structures.go:Statement.Deserialize`
 * (per-payload ring state).
 *
 * COINBASE / PREMINE / REGISTRATION transactions are rejected — they have no
 * payloads, so there is nothing to forge a proof against.
 */

import { deroDecompress, type DeroPoint } from './bn254.js'

export enum TransactionType {
  PREMINE = 0,
  REGISTRATION = 1,
  COINBASE = 2,
  NORMAL = 3,
  BURN_TX = 4,
  SC_TX = 5,
}

const PAYLOAD_LIMIT = 145 // = 1 + 144, per transaction.go:62

// ─────────────────────────────────────────────────────────────────────────────
// Cursor — tracks read position through the TX byte stream.
// ─────────────────────────────────────────────────────────────────────────────

class Cursor {
  offset = 0
  constructor(public readonly bytes: Uint8Array) {}

  remaining(): number {
    return this.bytes.length - this.offset
  }

  readByte(): number {
    if (this.offset >= this.bytes.length) throw new Error('tx-parse: unexpected EOF')
    return this.bytes[this.offset++]
  }

  readBytes(len: number): Uint8Array {
    if (this.offset + len > this.bytes.length) {
      throw new Error(`tx-parse: unexpected EOF (need ${len}, have ${this.remaining()})`)
    }
    const out = this.bytes.slice(this.offset, this.offset + len)
    this.offset += len
    return out
  }

  /** Go binary.Uvarint — little-endian base-128. */
  readUvarint(): bigint {
    let result = 0n
    let shift = 0n
    while (true) {
      const b = this.readByte()
      result |= BigInt(b & 0x7f) << shift
      if ((b & 0x80) === 0) return result
      shift += 7n
      if (shift > 70n) throw new Error('tx-parse: uvarint overflow')
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export type ParsedStatement = {
  ring_size: number
  bytes_per_publickey: number
  fees: bigint
  /** Compressed ephemeral key D = rG (sender's blinding scalar × G). */
  D: DeroPoint
  D_hex: string
  /** Ring-member pointers (sha256 prefixes; cannot recover full addresses from these alone). */
  publickey_pointers: Uint8Array
  /** Per-ring-slot commitment C[i] = amount_i × G + blinder_i. */
  C: DeroPoint[]
  C_hex: string[]
  roothash: Uint8Array
}

export type ParsedPayload = {
  burn_value: bigint
  scid_hex: string
  rpc_type: number
  rpc_payload: Uint8Array
  statement: ParsedStatement
}

export type ParsedTransaction = {
  version: bigint
  source_network: bigint
  dest_network: bigint
  type: TransactionType
  height: bigint
  blid_hex: string
  payloads: ParsedPayload[]
  /** Bytes consumed up through the last payload's Statement (proofs/SCDATA ignored). */
  bytes_consumed: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Parser
// ─────────────────────────────────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  if (clean.length % 2 !== 0) throw new Error(`tx-parse: odd hex length ${clean.length}`)
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return hex
}

function parseStatement(cur: Cursor): ParsedStatement {
  const power = cur.readByte()
  if (power > 7) throw new Error(`tx-parse: ring power ${power} exceeds 128 ring size`)
  const ringSize = 1 << power
  const bytesPerPublickey = cur.readByte()
  const fees = cur.readUvarint()
  const dRaw = cur.readBytes(33)
  const D = deroDecompress(dRaw)
  const publickeyPointers = cur.readBytes(ringSize * bytesPerPublickey)
  const C: DeroPoint[] = []
  const C_hex: string[] = []
  for (let i = 0; i < ringSize; i++) {
    const raw = cur.readBytes(33)
    C.push(deroDecompress(raw))
    C_hex.push(bytesToHex(raw))
  }
  const roothash = cur.readBytes(32)
  return {
    ring_size: ringSize,
    bytes_per_publickey: bytesPerPublickey,
    fees,
    D,
    D_hex: bytesToHex(dRaw),
    publickey_pointers: publickeyPointers,
    C,
    C_hex,
    roothash,
  }
}

function parsePayload(cur: Cursor): ParsedPayload {
  const burnValue = cur.readUvarint()
  const scid = cur.readBytes(32)
  const rpcType = cur.readByte()
  const rpcPayload = cur.readBytes(PAYLOAD_LIMIT)
  const statement = parseStatement(cur)
  return {
    burn_value: burnValue,
    scid_hex: bytesToHex(scid),
    rpc_type: rpcType,
    rpc_payload: rpcPayload,
    statement,
  }
}

/**
 * Parse a hex-encoded DERO transaction up through each payload's Statement.
 * Proofs and SCDATA (after payloads) are intentionally skipped.
 */
export function parseTransaction(hex: string): ParsedTransaction {
  const bytes = hexToBytes(hex)
  const cur = new Cursor(bytes)

  const version = cur.readUvarint()
  if (version !== 1n) throw new Error(`tx-parse: unsupported version ${version}`)

  const sourceNetwork = cur.readUvarint()
  const destNetwork = cur.readUvarint()
  const txType = Number(cur.readUvarint()) as TransactionType

  if (
    txType !== TransactionType.NORMAL &&
    txType !== TransactionType.BURN_TX &&
    txType !== TransactionType.SC_TX
  ) {
    throw new Error(
      `tx-parse: unsupported transaction type ${TransactionType[txType] ?? txType} — only NORMAL, BURN_TX, and SC_TX carry payloads with C[] commitments`,
    )
  }

  // SC_TX prefixes Value (gas).
  if (txType === TransactionType.SC_TX) {
    cur.readUvarint() // gas — we don't need the value
  }

  const height = cur.readUvarint()
  const blid = cur.readBytes(32)
  const assetCount = cur.readUvarint()
  if (assetCount < 1n) throw new Error('tx-parse: asset_count < 1')
  // Bound the payload loop by the protocol max so a corrupt/hostile uvarint
  // gives a clear error instead of a cryptic EOF after over-reading.
  if (assetCount > BigInt(PAYLOAD_LIMIT)) {
    throw new Error(`tx-parse: asset_count ${assetCount} exceeds protocol maximum ${PAYLOAD_LIMIT}`)
  }

  const payloads: ParsedPayload[] = []
  for (let i = 0n; i < assetCount; i++) payloads.push(parsePayload(cur))

  return {
    version,
    source_network: sourceNetwork,
    dest_network: destNetwork,
    type: txType,
    height,
    blid_hex: bytesToHex(blid),
    payloads,
    bytes_consumed: cur.offset,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Convenience: extract a single commitment.
// ─────────────────────────────────────────────────────────────────────────────

export function getRingCommitment(
  tx: ParsedTransaction,
  ringSlot: number,
  payloadIndex = 0,
): DeroPoint {
  if (payloadIndex < 0 || payloadIndex >= tx.payloads.length) {
    throw new Error(`tx-parse: payload_index ${payloadIndex} out of range (have ${tx.payloads.length})`)
  }
  const stmt = tx.payloads[payloadIndex].statement
  if (ringSlot < 0 || ringSlot >= stmt.ring_size) {
    throw new Error(`tx-parse: ring_slot ${ringSlot} out of range (ring size ${stmt.ring_size})`)
  }
  return stmt.C[ringSlot]
}
