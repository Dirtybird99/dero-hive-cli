---
name: wallet-rpc-api
description: DERO wallet RPC API reference for programmatic wallet control and smart contract interaction
license: MIT
compatibility: opencode
keywords:
  - dero
  - rpc
  - wallet
  - api
  - smart-contracts
---

# DERO Wallet RPC API

## Table of Contents

- [Introduction](#introduction)
- [Network Ports](#network-ports)
- [Enable RPC Server](#enable-rpc-server)
- [RPC Methods](#rpc-methods)
- [Related Pages](#related-pages)

## Introduction

A wallet RPC (Remote Procedure Call) enables programmatic control of a DERO wallet. This API allows payment processors, exchanges, and applications to automate wallet operations.

**Source:** `rpc/wallet_rpc.go` - All RPC methods verified against Release 142

## Network Ports

| Network | Port | Purpose |
|---------|------|---------|
| Mainnet | 10103 | Production use |
| Testnet | 40403 | Development/testing |

## Enable RPC Server

The RPC server is not enabled by default. Start the wallet with `--rpc-server` to enable it:

### Mainnet without authentication

```bash
./dero-wallet-cli --rpc-server --rpc-bind=127.0.0.1:10103
```

### With authentication

```bash
./dero-wallet-cli --rpc-server --rpc-login=username:password
```

## What You Can Do

- **Manage balances** - Query DERO and asset balances
- **Send transactions** - Transfer DERO and assets with privacy
- **Receive payments** - Generate integrated addresses, monitor transfers
- **Smart contract interaction** - Call SC methods, query state
- **Address management** - Get wallet address, generate integrated addresses

## RPC Methods

### Echo

Test endpoint to verify that the RPC server is enabled and working well on the wallet side.

**Parameters:** Array of strings

**Request Body:**

```json
{
    "jsonrpc": "2.0",
    "id": "1",
    "method": "Echo",
    "params": ["Hello", "World", "!"]
}
```

**cURL Request:**

```bash
curl -X POST \
  http://127.0.0.1:10103/json_rpc \
  -H 'content-type: application/json' \
  -d '{
    "jsonrpc": "2.0",
    "id": "1",
    "method": "Echo",
    "params": ["Hello", "World", "!"]
  }'
```

**Result:**

```json
{
    "jsonrpc": "2.0",
    "id": "1",
    "result": "WALLET Hello World !"
}
```

### GetAddress

Returns the DERO address of the wallet to receive DEROs or other tokens.

**Parameters:** None

**Request Body:**

```json
{
    "jsonrpc": "2.0",
    "id": "1",
    "method": "GetAddress"
}
```

**cURL Request:**

```bash
curl -X POST \
  http://127.0.0.1:10103/json_rpc \
  -H 'content-type: application/json' \
  -d '{
    "jsonrpc": "2.0",
    "id": "1",
    "method": "GetAddress"
  }'
```

**Result:**

```json
{
    "jsonrpc": "2.0",
    "id": "1",
    "result": {
        "address": "deto1qyyhg0xznkaxt5udct6lnlylsexvwprun6jphv89xg008vq29jk4vqqayuknf"
    }
}
```

### GetBalance

Retrieves the current balance of the wallet.

**Parameters:** None

**Note:** The amount is in atomic format. As a reminder, $10^5$ (=100000) is equivalent to 1 DERO.

**cURL Request:**

```bash
curl -X POST \
  http://127.0.0.1:10103/json_rpc \
  -H 'content-type: application/json' \
  -d '{
    "jsonrpc": "2.0",
    "id": "1",
    "method": "GetBalance"
  }'
```

**Result:**

```json
{
    "jsonrpc": "2.0",
    "id": "1",
    "result": {
        "balance": 800000,
        "unlocked_balance": 800000
    }
}
```

### GetHeight

Returns at which block height the wallet is synchronized.

**Parameters:** None

**cURL Request:**

```bash
curl -X POST \
  http://127.0.0.1:10103/json_rpc \
  -H 'content-type: application/json' \
  -d '{
    "jsonrpc": "2.0",
    "id": "1",
    "method": "GetHeight"
  }'
```

### GetTransferbyTXID

Returns the details of the transaction based on its hash.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| txid | hash | true | Transaction hash |

### GetTransfers

Returns all transactions present in the portfolio against the applied filters.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| scid | hash | false | Smart Contract ID |
| coinbase | bool | false | Accept coinbase TX? |
| in | bool | false | Accept incoming TX? |
| out | bool | false | Accept outgoing TX? |
| min_height | uint64 | false | Minimum height |
| max_height | uint64 | false | Maximum height |

### MakeIntegratedAddress

Returns a new integrated address with Payloads included.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| address | string | false | DERO Address |
| payload_rpc | argument | false | Parameters to include |

### QueryKey

Returns the mnemonic key (seed) associated with this portfolio.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| key_type | string | true | Key Type ("mnemonic" only) |

### Transfer

Creates a transaction and returns its hash.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| scid | hash | false | SCID of asset |
| destination | string | false | DERO Address of receiver |
| amount | uint64 | false | Amount of token to send |
| burn | uint63 | false | Amount of token to burn |
| payload_rpc | arguments | false | Payload Arguments |

### Transfer (Multiple Recipients)

Creates a transaction to several distinct addresses and returns its hash.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| transfers | []transfer | false | List of transfers |
| ringsize | uint64 | false | Level of anonymity |

### scinvoke

Creates a transaction to call a Smart Contract function and returns its hash.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| scid | string | true | SCID of asset/token |
| sc_rpc | arguments | true | SC Arguments |
| sc_dero_deposit | uint64 | false | Amount of DERO to deposit |
| ringsize | uint64 | false | Level of anonymity |

## Related Pages

### Getting Started

- [Running a Node](https://derod.org/basics/running-a-node) - Setup wallet RPC server

### Related APIs

- [Daemon RPC API](https://derod.org/rpc-api/daemon-rpc-api) - Node RPC methods
- [Smart Contract Examples](https://derod.org/smartContracts/token) - Deploy contracts via RPC

### Understanding Privacy

- [Transaction Privacy](https://derod.org/privacy/transaction-privacy) - How transfers stay private
- [Homomorphic Encryption](https://derod.org/privacy/homomorphic-encryption) - Encrypted balances
- [Payload Proofs](https://derod.org/privacy/payload-proofs) - Prove transfers cryptographically

### For Developers

- [DVM-BASIC Guide](https://derod.org/dvm/dvm-basic) - Smart contract language
- [DERO Tokens](https://derod.org/basics/tokens) - Send and receive assets

### Additional Resources

- [Official Website](https://dero.io/)
- [TELA Platform](https://tela.derod.org/)
- [GitHub](https://github.com/deroproject/derohe)

---

**License**: MIT  
**Last Updated**: January 2026
