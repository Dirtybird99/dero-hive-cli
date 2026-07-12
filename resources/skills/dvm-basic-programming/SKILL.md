---
name: dvm-basic-programming
description: Reference for DVM-BASIC smart contract language with syntax, functions, and examples
license: MIT
compatibility: opencode
keywords:
  - dero
  - dvm-basic
  - smart-contracts
  - blockchain
  - programming-language
---

# DVM-BASIC Programming Guide

## Table of Contents

- [Introduction](#introduction)
- [Language Features](#language-features)
- [Quick Start](#quick-start)
- [Data Types & Variables](#data-types--variables)
- [Operators](#operators)
- [Control Flow](#control-flow)
- [Comments](#comments)
- [Functions](#functions)
- [Blockchain Functions](#blockchain-functions)
- [Best Practices](#best-practices)
- [Example: Token Contract](#example-token-contract)
- [Learn More](#learn-more)

## Introduction

DVM-BASIC is DERO's smart contract programming language - a blockchain-optimized BASIC variant that's easy to learn yet powerful enough for complex dApps with privacy features.

## Language Features

- Line-numbered syntax (like GW-BASIC)
- Strong typing: `Uint64` and `String`
- Built-in blockchain functions
- Privacy-preserving operations
- Deterministic execution

## Quick Start

### Initialize Function

```basic
Function Initialize() Uint64
    10 STORE("owner", SIGNER())
    20 STORE("counter", 0)
    30 RETURN 0
End Function
```

### Increment Function

```basic
Function Increment() Uint64
    10 DIM current as Uint64
    20 LET current = LOAD("counter")
    30 STORE("counter", current + 1)
    40 RETURN 0
End Function
```

## Data Types & Variables

| Type | Range | Default | Use Cases |
|------|-------|---------|-----------|
| `Uint64` | 0 to 18,446,744,073,709,551,615 | 0 | Numbers, balances, counts |
| `String` | Variable (size limits apply) | "" | Text, addresses, keys |

### Declare Variables

```basic
10 DIM counter as Uint64
20 DIM name, symbol as String
```

## Operators

### Arithmetic

- `+` Addition
- `-` Subtraction
- `*` Multiplication
- `/` Division
- `%` Modulo

### Bitwise

- `&` AND
- `|` OR
- `^` XOR
- `!` NOT
- `>>` Right shift
- `<<` Left shift

### Comparison

- `>` Greater than
- `>=` Greater than or equal
- `<` Less than
- `<=` Less than or equal
- `==` Equal
- `!=` Not equal

### String Operations

- `+` Concatenation
- `==` Equal
- `!=` Not equal

## Control Flow

### IF-THEN-ELSE

```basic
10 IF value > 100 THEN GOTO 30 ELSE GOTO 50
```

### Loops with GOTO

```basic
10 LET counter = 0
20 LET counter = counter + 1
30 IF counter < 10 THEN GOTO 20
```

## Comments

DVM-BASIC supports multiple comment formats:

```basic
' Single-line comment

// Alternative single-line

/* Multi-line
   comment */
```

## Functions

### Syntax

```basic
Function Name(param1 Type, param2 Type) ReturnType
    10 RETURN value
End Function
```

### Visibility Rules

- **Uppercase first letter** - Public (callable externally)
- **Lowercase first letter** - Private (internal only)

### Return Values

- `0` = success
- Non-zero = error code

## Blockchain Functions

### State Management

| Function | Purpose |
|----------|---------|
| `STORE(key, value)` | Save to blockchain state |
| `LOAD(key)` | Read from blockchain state |
| `EXISTS(key)` | Check if key exists |

### Identity & Transaction

| Function | Purpose |
|----------|---------|
| `SIGNER()` | Get transaction sender address |
| `TXID()` | Get current transaction ID |
| `ADDRESS_RAW(string)` | Convert address string to raw format |
| `IS_ADDRESS_VALID(string)` | Validate address format |

### Asset Operations

| Function | Purpose |
|----------|---------|
| `SEND_DERO_TO_ADDRESS(addr, amount)` | Transfer DERO |
| `SEND_ASSET_TO_ADDRESS(addr, amount, scid)` | Transfer asset/token |
| `DEROVALUE()` | Get DERO sent in transaction |
| `ASSETVALUE(scid)` | Get asset sent in transaction |

### Blockchain Info

| Function | Purpose |
|----------|---------|
| `BLOCK_HEIGHT()` | Current block height |
| `BLOCK_TIMESTAMP()` | Current block timestamp |
| `SCID()` | This contract's ID |

### Cryptographic

| Function | Purpose |
|----------|---------|
| `SHA256(data)` | Compute SHA256 hash |
| `KECCAK256(data)` | Compute Keccak256 hash |

## Best Practices

1. **Security** - Always validate inputs and permissions
2. **Gas efficiency** - Minimize STORE/LOAD operations
3. **Line spacing** - Use increments of 10 for future insertions
4. **Error codes** - Return meaningful error codes
5. **Testing** - Use Simulator before deployment

## Example: Token Contract

### Initialize Function

```basic
Function Initialize() Uint64
    10 STORE("owner", SIGNER())
    20 STORE("supply", 1000000)
    30 STORE("balance:" + SIGNER(), 1000000)
    40 RETURN 0
End Function
```

### Transfer Function

```basic
Function Transfer(to String, amount Uint64) Uint64
    10 DIM sender as String
    20 DIM sender_bal, recipient_bal as Uint64
    
    30 LET sender = SIGNER()
    40 IF IS_ADDRESS_VALID(to) != 1 THEN GOTO 200
    50 IF amount <= 0 THEN GOTO 200
    
    60 LET sender_bal = LOAD("balance:" + sender)
    70 IF sender_bal < amount THEN GOTO 200
    
    80 IF EXISTS("balance:" + to) THEN GOTO 100
    90 STORE("balance:" + to, 0)
    
    100 LET recipient_bal = LOAD("balance:" + to)
    110 STORE("balance:" + sender, sender_bal - amount)
    120 STORE("balance:" + to, recipient_bal + amount)
    130 RETURN 0
    
    200 RETURN 1  ' Error
End Function
```

### BalanceOf Function

```basic
Function BalanceOf(address String) Uint64
    10 IF EXISTS("balance:" + ADDRESS_RAW(address)) THEN GOTO 30
    20 RETURN 0
    30 RETURN LOAD("balance:" + ADDRESS_RAW(address))
End Function
```

## Learn More

- [DERO Documentation](https://docs.dero.io/) - Official documentation
- [DERO Virtual Machine](https://derod.org/dvm/dero-virtual-machine) - DVM architecture
- [DERO GitHub](https://github.com/deroproject/derohe) - Source code and examples

**Tip:** The DVM-BASIC language evolves with DERO. Check official docs for updates!

---

**License**: MIT  
**Last Updated**: January 2026
