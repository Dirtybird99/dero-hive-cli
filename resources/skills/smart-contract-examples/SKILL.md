---
name: smart-contract-examples
description: Collection of working DERO smart contract examples with deployment instructions
license: MIT
compatibility: opencode
keywords:
  - dero
  - smart-contracts
  - dvm-basic
  - examples
  - lottery
  - token
  - assets
  - name-service
---

# DERO Smart Contract Examples

## Table of Contents

- [Lottery Smart Contract](#lottery-smart-contract)
- [Token Smart Contract](#token-smart-contract)
- [Assets Interchange Smart Contract](#assets-interchange-smart-contract)
- [Name Service Smart Contract](#name-service-smart-contract)

---

## Lottery Smart Contract

### Overview

A provably fair lottery smart contract where players deposit DERO and a winner is randomly selected.

**SCID:** `30b84e9ab5baeee7195e7e1ccb1f533b7402beb2d3cfa97216a6d80c01056f66`

### Setup (Testnet)

```bash
# Start Dero daemon in testnet mode
./derod-linux-amd64 --testnet

# Start Dero wallet in testnet
dero-wallet-cli-linux-amd64 --rpc-server --wallet-file testnet.wallet --testnet

# Start second wallet instance
dero-wallet-cli-linux-amd64 --wallet-file testnet2.wallet --testnet --rpc-server --rpc-bind=127.0.0.1:40403
```

### Install Smart Contract

```bash
curl --request POST --data-binary @lottery.bas http://127.0.0.1:40403/install_sc
```

### Query Contract

```bash
# Get full contract code
curl http://127.0.0.1:40402/json_rpc \
  -d '{"jsonrpc":"2.0","id":"0","method":"getsc","params":{"scid":"30b84e9ab5baeee7195e7e1ccb1f533b7402beb2d3cfa97216a6d80c01056f66", "code":true}}' \
  -H 'Content-Type: application/json'
```

### Functions

#### Play Lottery

```bash
curl http://127.0.0.1:40403/json_rpc \
  -d '{
    "jsonrpc": "2.0",
    "id": "0",
    "method": "scinvoke",
    "params": {
        "sc_dero_deposit": 200000,
        "scid": "30b84e9ab5baeee7195e7e1ccb1f533b7402beb2d3cfa97216a6d80c01056f66",
        "sc_rpc": [
            {"name": "entrypoint", "datatype": "S", "value": "Lottery"}
        ]
    }
  }' \
  -H 'Content-Type: application/json'
```

#### Withdraw Balance (Owner Only)

```bash
curl http://127.0.0.1:40403/json_rpc \
  -d '{
    "jsonrpc": "2.0",
    "id": "0",
    "method": "scinvoke",
    "params": {
        "scid": "30b84e9ab5baeee7195e7e1ccb1f533b7402beb2d3cfa97216a6d80c01056f66",
        "sc_rpc": [
            {"name": "entrypoint", "datatype": "S", "value": "Withdraw"},
            {"name": "amount", "datatype": "U", "value": 100000}
        ]
    }
  }' \
  -H 'Content-Type: application/json'
```

#### Transfer Ownership (Owner Only)

```bash
curl http://127.0.0.1:40403/json_rpc \
  -d '{
    "jsonrpc": "2.0",
    "id": "0",
    "method": "scinvoke",
    "params": {
        "scid": "30b84e9ab5baeee7195e7e1ccb1f533b7402beb2d3cfa97216a6d80c01056f66",
        "sc_rpc": [
            {"name": "entrypoint", "datatype": "S", "value": "TransferOwnership"},
            {"name": "newowner", "datatype": "S", "value": "deto1qy..."}
        ]
    }
  }' \
  -H 'Content-Type: application/json'
```

### Complete Contract Code

```basic
/* Lottery Smart Contract in DVM-BASIC
   This lottery smart contract will give lottery wins every xth try. */

Function Lottery(value Uint64) Uint64
    10 dim deposit_count,winner as Uint64
    20 LET deposit_count =  LOAD("deposit_count")+1
    25 IF value == 0 THEN GOTO 110
    30 STORE("depositor_address" + (deposit_count-1), SIGNER())
    40 STORE("deposit_total", LOAD("deposit_total") + value )
    50 STORE("deposit_count", deposit_count)
    60 IF LOAD("lotteryeveryXdeposit") > deposit_count THEN GOTO 110
    70 LET winner  = RANDOM() % deposit_count
    80 SEND_DERO_TO_ADDRESS(LOAD("depositor_address" + winner), 
       LOAD("lotterygiveback")*LOAD("deposit_total")/10000)
    90 STORE("deposit_count", 0)
    100 STORE("deposit_total", 0)
    110 RETURN 0
End Function

Function Initialize() Uint64
    10 STORE("owner", SIGNER())
    20 STORE("lotteryeveryXdeposit", 2)
    30 STORE("lotterygiveback", 9900)
    33 STORE("deposit_count", 0)
    34 STORE("deposit_total", 0)
    40 RETURN 0
End Function

Function TuneLotteryParameters(lotteryeveryXdeposit Uint64, lotterygiveback Uint64) Uint64
    10 IF LOAD("owner") == SIGNER() THEN GOTO 100
    40 RETURN 1
    100 STORE("lotteryeveryXdeposit", lotteryeveryXdeposit)
    130 STORE("lotterygiveback", lotterygiveback)
    140 RETURN 0
End Function

Function TransferOwnership(newowner String) Uint64
    10 IF LOAD("owner") == SIGNER() THEN GOTO 30
    20 RETURN 1
    30 STORE("tmpowner", ADDRESS_RAW(newowner))
    40 RETURN 0
End Function

Function ClaimOwnership() Uint64
    10 IF LOAD("tmpowner") == SIGNER() THEN GOTO 30
    20 RETURN 1
    30 STORE("owner", SIGNER())
    40 RETURN 0
End Function

Function Withdraw(amount Uint64) Uint64
    10 IF LOAD("owner") == SIGNER() THEN GOTO 30
    20 RETURN 1
    30 SEND_DERO_TO_ADDRESS(SIGNER(), amount)
    40 RETURN 0
End Function

Function UpdateCode(code String) Uint64
    10 IF LOAD("owner") == SIGNER() THEN GOTO 30
    20 RETURN 1
    30 UPDATE_SC_CODE(code)
    40 RETURN 0
End Function
```

---

## Token Smart Contract

### Overview

A private token smart contract with homomorphic encryption for hidden balances.

**Testnet SCID:** `aacaa7bb2388d06e523e5bc0783e4e131738270641406c12978155ba033373af`

### Install Token Contract

```bash
curl --request POST --data-binary @token.bas http://127.0.0.1:40403/install_sc
```

### Functions

#### Send Private Tokens

```bash
curl http://127.0.0.1:40403/json_rpc \
  -d '{"jsonrpc":"2.0","id":"0","method":"transfer","params":{"transfers":[{"amount":111111,"destination":"deto1qxqqen6lqmksmzmxmfqmxp2y8zvkldtcq8jhkzqflmyczepjw9dp46gc3cczu","scid": "aacaa7bb2388d06e523e5bc0783e4e131738270641406c12978155ba033373af"}]}}' \
  -H 'Content-Type: application/json'
```

#### Convert DERO to Tokens (1:1 Swap)

```bash
curl http://127.0.0.1:40403/json_rpc \
  -d '{"jsonrpc":"2.0","id":"0","method":"transfer","params":{"transfers":[{"amount":1,"destination":"deto1qxqqen6lqmksmzmxmfqmxp2y8zvkldtcq8jhkzqflmyczepjw9dp46gc3cczu", "burn":44}],"scid":"aacaa7bb2388d06e523e5bc0783e4e131738270641406c12978155ba033373af", "sc_rpc":[{"name":"entrypoint","datatype":"S","value":"IssueTOKENX"}]}}' \
  -H 'Content-Type: application/json'
```

#### Convert Tokens to DERO (1:1 Swap)

```bash
curl http://127.0.0.1:40403/json_rpc \
  -d '{"jsonrpc":"2.0","id":"0","method":"transfer","params":{"transfers":[{"scid":"aacaa7bb2388d06e523e5bc0783e4e131738270641406c12978155ba033373af", "amount":1,"destination":"deto1qxqqen6lqmksmzmxmfqmxp2y8zvkldtcq8jhkzqflmyczepjw9dp46gc3cczu", "burn":9}],"scid":"aacaa7bb2388d06e523e5bc0783e4e131738270641406c12978155ba033373af", "sc_rpc":[{"name":"entrypoint","datatype":"S","value":"ConvertTOKENX"}]}}' \
  -H 'Content-Type: application/json'
```

### Complete Contract Code

```basic
/* Private Token Smart Contract Example in DVM-BASIC. */

Function IssueTOKENX() Uint64
    10  SEND_ASSET_TO_ADDRESS(SIGNER(), DEROVALUE(), SCID())
    20  RETURN 0
End Function

Function ConvertTOKENX() Uint64
    10  SEND_DERO_TO_ADDRESS(SIGNER(), ASSETVALUE(SCID()))
    20  RETURN 0
End Function

Function InitializePrivate() Uint64
    10  STORE("owner", SIGNER())
    30  SEND_ASSET_TO_ADDRESS(SIGNER(), 1600000, SCID())
    40  RETURN 0
End Function

Function TransferOwnership(newowner String) Uint64
    10  IF LOAD("owner") == SIGNER() THEN GOTO 30
    20  RETURN 1
    30  STORE("tmpowner", ADDRESS_RAW(newowner))
    40  RETURN 0
End Function

Function ClaimOwnership() Uint64
    10  IF LOAD("tmpowner") == SIGNER() THEN GOTO 30
    20  RETURN 1
    30  STORE("owner", SIGNER())
    40  RETURN 0
End Function

Function Withdraw(amount Uint64) Uint64
    10  IF LOAD("owner") == SIGNER() THEN GOTO 30
    20  RETURN 1
    30  SEND_DERO_TO_ADDRESS(SIGNER(), amount)
    40  RETURN 0
End Function

Function UpdateCode(code String) Uint64
    10  IF LOAD("owner") == SIGNER() THEN GOTO 30
    20  RETURN 1
    30  UPDATE_SC_CODE(code)
    40  RETURN 0
End Function
```

---

## Assets Interchange Smart Contract

### Overview

A token swap contract that converts assetOne to assetTwo at a defined ratio.

### Steps to Create

1. Create first token and deposit into exchange
2. Create second token and deposit into exchange
3. Install Asset Exchange Smart Contract
4. Deposit assets to the exchange contract

### Install Exchange Contract

```bash
curl --request POST --data-binary @asset_exchange.bas http://127.0.0.1:40403/install_sc
```

### Deposit AssetOne

```bash
curl --silent http://127.0.0.1:40403/json_rpc \
  -d '{
    "jsonrpc":"2.0",
    "id":"0",
    "method":"transfer",
    "params":{
        "scid":"Interchange-SCID",
        "ringsize":2,
        "sc_rpc":[{"name":"entrypoint","datatype":"S","value":"Deposit"}],
        "transfers": [
            {"scid":"ASSET_ONE_SCID", "burn":AssetOneCount_DEPOSITED_TO_EXCHANGE}
        ]
    }
  }' \
  -H 'Content-Type: application/json'
```

### Complete Contract Code

```basic
// Asset Interchange Smart Contract Example in DVM-BASIC

Function Deposit() Uint64
    20  RETURN 0
End Function

Function Interchange(incoming String, outgoing String) Uint64
    10  SEND_ASSET_TO_ADDRESS(SIGNER(), ASSETVALUE(incoming) / 2, outgoing)
    20  RETURN 0
End Function

Function Initialize() Uint64
    10 STORE("owner", SIGNER())
    40  RETURN 0
End Function

Function TransferOwnership(newowner String) Uint64
    10  IF LOAD("owner") == SIGNER() THEN GOTO 30
    20  RETURN 1
    30  STORE("tmpowner", ADDRESS_RAW(newowner))
    40  RETURN 0
End Function

Function ClaimOwnership() Uint64
    10  IF LOAD("tmpowner") == SIGNER() THEN GOTO 30
    20  RETURN 1
    30  STORE("owner", SIGNER())
    40  RETURN 0
End Function

Function Withdraw(amount Uint64, asset String) Uint64
    10  IF LOAD("owner") == SIGNER() THEN GOTO 30
    20  RETURN 1
    30  SEND_ASSET_TO_ADDRESS(SIGNER(), amount, asset)
    40  RETURN 0
End Function

Function UpdateCode(code String) Uint64
    10  IF LOAD("owner") == SIGNER() THEN GOTO 30
    20  RETURN 1
    30  UPDATE_SC_CODE(code)
    40  RETURN 0
End Function
```

---

## Name Service Smart Contract

### Overview

Register and associate a DERO wallet with a username using the Nameservice.

**Reserved SCID:** `0000000000000000000000000000000000000000000000000000000000000001`

### Check Username Availability

```bash
curl http://127.0.0.1:40402/json_rpc \
  -d '{"jsonrpc":"2.0","id":"0","method":"nametoaddress","params":{"name":"TESTUSERNAME"}}' \
  -H 'Content-Type: application/json'
```

### Register Username

```bash
curl http://127.0.0.1:40403/json_rpc \
  -d '{"jsonrpc":"2.0","id":"0","method":"scinvoke","params":{"scid":"0000000000000000000000000000000000000000000000000000000000000001","ringsize":2, "sc_rpc":[{"name":"entrypoint","datatype":"S","value":"Register"}, {"name":"name","datatype":"S","value":"TESTUSERNAME"}]}}' \
  -H 'Content-Type: application/json'
```

### Complete Contract Code

```basic
/* Name Service SMART CONTRACT in DVM-BASIC. */

Function Initialize() Uint64
    10  RETURN 0
End Function

Function Register(name String) Uint64
    10  IF EXISTS(name) THEN GOTO 50
    20  IF STRLEN(name) >= 6 THEN GOTO 40
    30  IF SIGNER() != address_raw("deto1qyvyeyzrcm2fzf6kyq7egkes2ufgny5xn77y6typhfx9s7w3mvyd5qqynr5hx") 
        THEN GOTO 50
    40  STORE(name,SIGNER())
    50  RETURN 0
End Function

Function TransferOwnership(name String, newowner String) Uint64
    10  IF LOAD(name) != SIGNER() THEN GOTO 30
    20  STORE(name,ADDRESS_RAW(newowner))
    30  RETURN 0
End Function
```

---

**License**: MIT  
**Last Updated**: January 2026
