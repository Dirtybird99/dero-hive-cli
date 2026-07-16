import { decodeDeroBech32 } from '../../../resources/mcp/dero-mcp-server/src/proof-decode';

export interface XswdTransferParams {
  destination: string;
  amount: number;
  scid?: string;
  ringsize?: number;
}

export interface XswdScInvokeParams {
  scid: string;
  entrypoint: string;
  parameters?: Array<{ name: string; datatype: 'S' | 'U'; value: string | number }>;
  sc_dero_deposit?: number;
  sc_token_deposit?: number;
  ringsize?: number;
}

export interface WalletWriteReview<T> {
  action: 'SEND' | 'INVOKE';
  params: T;
  lines: string[];
}

const SCID = /^[0-9a-f]{64}$/i;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const DERO_ATOMIC = 100_000n;

export function validateXswdWalletAddress(value: unknown): string {
  if (typeof value !== 'string' || value !== value.trim() || value.length > 256) {
    throw new Error('Connected wallet returned an invalid DERO address.');
  }
  const decoded = decodeAddress(value, 'Connected wallet');
  if (decoded.is_proof || (decoded.hrp !== 'dero' && decoded.hrp !== 'deto')) {
    throw new Error('Connected wallet returned an invalid DERO address.');
  }
  return value;
}

export function parseDeroAmount(value: string): number {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,5}))?$/.exec(value.trim());
  if (!match) throw new Error('DERO amount must be a decimal value with at most 5 fractional digits.');
  const atomic = BigInt(match[1]) * DERO_ATOMIC + BigInt((match[2] || '').padEnd(5, '0'));
  if (atomic > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('DERO amount is too large.');
  return Number(atomic);
}

export function formatDeroAmount(atomic: number | bigint): string {
  if (typeof atomic === 'number') assertAtomic(atomic, 'amount', true);
  else if (atomic < 0n || atomic >= 1n << 64n) throw new Error('amount is outside uint64 range.');
  const value = BigInt(atomic);
  return `${value / DERO_ATOMIC}.${(value % DERO_ATOMIC).toString().padStart(5, '0')}`;
}

export function validateXswdTransfer(
  input: XswdTransferParams,
  walletAddress: string,
  now = new Date()
): Required<Pick<XswdTransferParams, 'destination' | 'amount' | 'ringsize'>> & Pick<XswdTransferParams, 'scid'> {
  if (typeof input.destination !== 'string') throw new Error('Destination is not a valid DERO address.');
  const destination = input.destination.trim();
  assertAtomic(input.amount, 'amount');
  const ringsize = validateRingSize(input.ringsize ?? 16);
  if (input.scid !== undefined && typeof input.scid !== 'string') throw new Error('scid must be a 64-character hex string.');
  const scid = input.scid?.trim().toLowerCase() || undefined;
  if (scid && !SCID.test(scid)) throw new Error('scid must be a 64-character hex string.');

  const validatedWalletAddress = validateXswdWalletAddress(walletAddress);
  const wallet = decodeAddress(validatedWalletAddress, 'Connected wallet');
  const recipient = decodeAddress(destination, 'Destination');
  if (wallet.is_proof || recipient.is_proof) throw new Error('A DERO proof cannot be used as a wallet address.');
  if (wallet.mainnet !== recipient.mainnet) {
    throw new Error(`Destination is ${recipient.mainnet ? 'mainnet' : 'testnet/simulator'}, but the connected wallet is ${wallet.mainnet ? 'mainnet' : 'testnet/simulator'}.`);
  }

  if (recipient.hrp === 'deroi' || recipient.hrp === 'detoi') {
    const malformedReserved = recipient.arguments.find((item) =>
      (item.name === 'E' && item.type !== 'T')
      || (item.name === 'V' && item.type !== 'U')
      || (item.name === 'A' && item.type !== 'H'));
    if (malformedReserved) {
      throw new Error(`Integrated address has an invalid reserved ${malformedReserved.name} argument.`);
    }
    const expiry = recipient.arguments.find((item) => item.name === 'E' && item.type === 'T');
    if (expiry) {
      if (!(expiry.value instanceof Date) || Number.isNaN(expiry.value.getTime())) {
        throw new Error('Integrated address has an invalid expiry.');
      }
      if (now.getTime() > expiry.value.getTime()) throw new Error('This integrated payment address has expired.');
    }
    const requestedAsset = recipient.arguments.find((item) => item.name === 'A' && item.type === 'H');
    const requested = recipient.arguments.find((item) => item.name === 'V' && item.type === 'U');
    if (requested && BigInt(String(requested.value)) !== BigInt(input.amount)) {
      throw new Error(requestedAsset
        ? `This integrated address requests exactly ${String(requested.value)} token atomic units.`
        : `This integrated address requests exactly ${formatDeroAmount(BigInt(String(requested.value)))} DERO.`);
    }
    if (requestedAsset) {
      const requestedScid = String(requestedAsset.value).toLowerCase();
      if (!scid) throw new Error(`This integrated address requests token SCID ${requestedScid}.`);
      if (scid !== requestedScid) throw new Error(`This integrated address requests token SCID ${requestedScid}, not ${scid}.`);
    } else if (scid) {
      throw new Error('This integrated address requests native DERO, not a token transfer.');
    }
  }

  return { destination, amount: input.amount, ringsize, ...(scid ? { scid } : {}) };
}

export function reviewXswdTransfer(
  input: XswdTransferParams,
  walletAddress: string,
  now = new Date()
): WalletWriteReview<ReturnType<typeof validateXswdTransfer>> {
  const params = validateXswdTransfer(input, walletAddress, now);
  const network = decodeAddress(walletAddress, 'Connected wallet').mainnet ? 'Mainnet' : 'Testnet / simulator';
  const recipient = decodeAddress(params.destination, 'Destination');
  const integrated = recipient.hrp === 'deroi' || recipient.hrp === 'detoi';
  return {
    action: 'SEND',
    params,
    lines: [
      `Network: ${network}`,
      `Destination: ${params.destination}`,
      params.scid ? `Token amount: ${params.amount} atomic · SCID ${params.scid}` : `Amount: ${formatDeroAmount(params.amount)} DERO (${params.amount} atomic)`,
      ...(integrated ? [`Integrated invoice fields: ${recipient.arguments.map((item) => `${reviewText(item.semantic_name || item.name)}=${reviewValue(item.value)}`).join(', ') || 'none'}`] : []),
      `Ring size: ${params.ringsize}`,
      'The connected wallet must approve this transaction before broadcast.'
    ]
  };
}

export function validateXswdScInvoke(input: XswdScInvokeParams): Required<XswdScInvokeParams> {
  if (typeof input.scid !== 'string') throw new Error('scid must be a 64-character hex string.');
  if (typeof input.entrypoint !== 'string') throw new Error('entrypoint must be a valid DVM identifier.');
  const scid = input.scid.trim().toLowerCase();
  const entrypoint = input.entrypoint.trim();
  if (!SCID.test(scid)) throw new Error('scid must be a 64-character hex string.');
  if (!IDENTIFIER.test(entrypoint)) throw new Error('entrypoint must be a valid DVM identifier.');
  const seen = new Set<string>(['entrypoint']);
  const parameters = (input.parameters ?? []).map((item) => {
    if (!item || typeof item !== 'object' || typeof item.name !== 'string') {
      throw new Error('Each parameter name must be a valid DVM identifier.');
    }
    const name = item.name.trim();
    if (!IDENTIFIER.test(name)) throw new Error('Each parameter name must be a valid DVM identifier.');
    if (seen.has(name)) throw new Error(`Duplicate smart-contract parameter: ${name}.`);
    seen.add(name);
    if (item.datatype === 'U') {
      assertAtomic(item.value, `parameter ${name}`, true);
      return { name, datatype: 'U' as const, value: item.value as number };
    }
    if (item.datatype !== 'S' || typeof item.value !== 'string') {
      throw new Error(`Parameter ${name} must match datatype S or U.`);
    }
    if (item.value.length > 8_192) throw new Error(`Parameter ${name} is too long.`);
    return { name, datatype: 'S' as const, value: item.value };
  });
  if (parameters.length > 64) throw new Error('Smart-contract calls support at most 64 parameters.');
  if (new TextEncoder().encode(JSON.stringify(parameters)).byteLength > 32 * 1024) {
    throw new Error('Smart-contract parameters are too large.');
  }
  const sc_dero_deposit = input.sc_dero_deposit ?? 0;
  const sc_token_deposit = input.sc_token_deposit ?? 0;
  assertAtomic(sc_dero_deposit, 'DERO burn/deposit', true);
  assertAtomic(sc_token_deposit, 'token burn/deposit', true);
  return {
    scid,
    entrypoint,
    parameters,
    sc_dero_deposit,
    sc_token_deposit,
    ringsize: validateRingSize(input.ringsize ?? 2)
  };
}

export function reviewXswdScInvoke(input: XswdScInvokeParams): WalletWriteReview<Required<XswdScInvokeParams>> {
  const params = validateXswdScInvoke(input);
  return {
    action: 'INVOKE',
    params,
    lines: [
      `Contract: ${params.scid}`,
      `Entrypoint: ${params.entrypoint}`,
      `Parameters: ${params.parameters.length ? JSON.stringify(params.parameters) : 'none'}`,
      `DERO burned/deposited into contract: ${formatDeroAmount(params.sc_dero_deposit)} DERO (${params.sc_dero_deposit} atomic)`,
      `Token burned/deposited into contract: ${params.sc_token_deposit} atomic`,
      `Ring size: ${params.ringsize}`,
      'The connected wallet must approve this contract call.'
    ]
  };
}

function decodeAddress(value: string, label: string): ReturnType<typeof decodeDeroBech32> {
  try {
    if (typeof value !== 'string') throw new Error('not a string');
    return decodeDeroBech32(value);
  } catch {
    throw new Error(`${label} is not a valid DERO address.`);
  }
}

function reviewValue(value: unknown): string {
  return value instanceof Date ? value.toISOString() : reviewText(String(value));
}

function reviewText(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

function assertAtomic(value: unknown, label: string, allowZero = false): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new Error(`${label} must be ${allowZero ? 'a non-negative' : 'a positive'} safe integer in atomic units.`);
  }
}

function validateRingSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 2 || value > 128 || (value & (value - 1)) !== 0) {
    throw new Error('ringsize must be a power of 2 between 2 and 128.');
  }
  return value;
}
