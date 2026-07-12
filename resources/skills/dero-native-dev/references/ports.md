# Ports & network reference

From `deroproject/derohe`'s `config/config.go` (`config.Mainnet` / `config.Testnet`) — prefer reading these constants in code over hardcoding, but use this table for quick orientation and for anything documentation-only:

| Environment | Daemon RPC | Wallet RPC | P2P | GetWork |
|---|---|---|---|---|
| Mainnet (Stargate) | 10102 | 10103 | 10101 | 10100 |
| Testnet | 40402 | 40403 | 40401 | 40400 |
| Simulator (`derod --simulator`) | 20000 | 30000 | n/a | n/a |

XSWD (wallet↔web-app permission bridge): port `44326` on all networks.

## Running a local daemon

```bash
# Simulator — instant blocks, disposable, for dev/testing
./derod --simulator

# Testnet
./derod --testnet

# Mainnet
./derod
```

## Wallet RPC

Wallets don't expose an RPC server by default — start one explicitly:
```bash
./dero-wallet-cli --rpc-server --rpc-bind=127.0.0.1:10103 --wallet-file mywallet.db
```

## Daemon RPC quick checks

```bash
curl http://127.0.0.1:10102/json_rpc -d '{"jsonrpc":"2.0","id":"0","method":"get_info"}'
```

For the current, canonical, and versioned list of every daemon/wallet RPC method (these do get added to over time), `web_fetch`:
- https://derod.org/rpc-api/daemon-rpc-api
- https://derod.org/rpc-api/wallet-rpc-api

rather than relying on a memorized method list.
