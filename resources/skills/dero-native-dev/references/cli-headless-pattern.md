# CLI / headless service pattern

For bots, backend services, indexers, or CLI tools with no GUI — just the chain-facing packages, no Wails/Fyne dependency.

## When to use this instead of HOLOGRAM/Engram patterns

- A backend service that watches the chain and reacts (webhook bot, notification service, analytics pipeline)
- A CLI utility (deploy a TELA app from the command line, batch-query SC state, generate wallets in bulk)
- A headless indexer feeding some other system (Gnomon as a library, no UI at all)

## Core loop shape

```go
package main

import (
	"log"
	"github.com/deroproject/derohe/walletapi"
	"github.com/civilware/Gnomon/indexer"
	"github.com/civilware/Gnomon/storage"
)

func main() {
	endpoint := "127.0.0.1:10102" // see references/ports.md for network table

	// Optional: wallet access, if the service needs to sign/send
	walletapi.SetDaemonAddress(endpoint)
	wallet, err := walletapi.Open_Encrypted_Wallet("service.wallet", "password")
	if err != nil {
		log.Fatal(err)
	}
	wallet.SetOnlineMode()

	// Indexing, if the service needs to watch chain activity
	grav := storage.NewGravDB("./gnomondb", "./gnomondb/backups")
	idx := indexer.NewIndexer(grav, nil, "gravdb", []string{}, 1, endpoint, "daemon", false, true, false, nil)
	go idx.StartDaemonMode(1)

	select {} // block forever; replace with real service lifecycle (signal handling, graceful shutdown)
}
```

## Patterns worth carrying over from the reference GUI apps even in headless mode

- **Simulator-first.** Default any example/dev-mode config to `derod --simulator` (port 20000) and make mainnet/testnet an explicit flag, not a default.
- **Search filters over blanket indexing.** Pass a real `search_filter` to `NewIndexer` (e.g. targeting a specific `Function InitializePrivate` signature) instead of indexing every SC on chain, unless the service genuinely needs full chain coverage — full indexing is expensive.
- **Structured shutdown.** Call `idx.Close()` and `wallet.Save_Wallet()` (if using a disk wallet) on SIGINT/SIGTERM — don't just let the process die; Graviton/BoltDB backends want a clean close.
- **TELA without a browser.** If the service needs to *read* on-chain TELA content (not host it visually), use `tela.Clone(scid, endpoint)` to pull files locally, or the lower-level `getContractCode`/`getContractVars`-style helpers in `tela.go`, rather than reimplementing SC-variable parsing.

## Embedding a node instead of connecting to one

If the service should run its own `derod` rather than connecting to an external one, either shell out to a `derod` binary (simplest, matches how HOLOGRAM's `node_manager.go` does it) or import `github.com/deroproject/derohe/cmd/derod`'s underlying packages directly (heavier — only worth it if you need in-process access to blockchain internals rather than just RPC). Prefer shelling out unless you have a concrete reason not to.
