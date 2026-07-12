---
name: dero-native-dev
description: Build native applications on the DERO privacy blockchain in Go, wiring together derod/derohe (chain, wallet, RPC), Gnomon (indexing), TELA (decentralized web/dApp hosting), Graviton (storage), AstroBWT (mining/PoW), and epoch (crowd-mining). Use this skill whenever the user says "use dero skill", "dero", "gnomon", "tela", "derod", "derohe", "engram", "hologram", "netrunner", "epoch", or asks to build/scaffold/wire up a DERO wallet app, DERO desktop/native app, TELA dApp, blockchain indexer, or anything that touches the DERO ecosystem repos — even if they don't use the word "skill" explicitly. This skill is for BUILDING code (scaffolding go.mod, writing wallet/indexer/server integration code, architecting a native app). For read-only chain lookups (querying live blocks/contracts/docs) prefer an installed dero-mcp-server MCP connection if available; this skill is for writing/generating applications, not querying chain data.
---

# DERO Native App Development

This skill turns Claude into a DERO ecosystem native-app builder. It captures the module map, import paths, wiring patterns, and reference architectures needed to scaffold real Go applications that pull together the DERO chain (`derohe`/`derod`), the indexer (`Gnomon`), the decentralized web standard (`TELA`), wallet functionality (`walletapi`), storage (`Graviton`), mining (`AstroBWT`), and crowd-mining (`epoch`) — the same way DHEBP's HOLOGRAM, DERO Foundation's Engram/netrunner do it.

## Repo map — what each piece is and why it's used

| Repo | Import path | Role | Use it when the app needs... |
|---|---|---|---|
| [deroproject/derohe](https://github.com/deroproject/derohe) | `github.com/deroproject/derohe` | The core L1: node (`derod`), P2P, DVM smart contracts, `walletapi` (wallet logic), `rpc` (types + RPC client), `cryptography/crypto`, `config` (ports/network params), `transaction`, `block`/`blockchain` | Any interaction with the chain at all — this is the foundation dependency for everything else |
| [deroproject/graviton](https://github.com/deroproject/graviton) | `github.com/deroproject/graviton` | Embedded, versioned, authenticated key-value store ("ZFS for key-value stores") used by the node and by Gnomon for local indexed storage | Custom local storage for indexed chain data, app state, or anything needing versioned/snapshot-able storage |
| [deroproject/astrobwt](https://github.com/deroproject/astrobwt) | `github.com/deroproject/astrobwt` | DERO's CPU-friendly proof-of-work algorithm (BWT + Salsa20 + SHA3) | Mining features, or "crowd mining" hash generation (see epoch) |
| [civilware/Gnomon](https://github.com/civilware/Gnomon) | `github.com/civilware/Gnomon` | Decentralized indexer: reads/indexes SC deployments, invokes, and transactions straight from a connected `derod` — no custom daemon needed. **⚠️ Dormant since Nov 2023** — use fork (nexus/gnomon-fork, simple-gnomon, HyperGnomon) for production | The app needs to search/filter/index smart contracts or transactions (SC discovery, TELA app discovery, analytics) |
| [civilware/tela](https://github.com/civilware/tela) (DHEBP fork tracks the same module path) | `github.com/civilware/tela` | TELA: decentralized web standard. `TELA-INDEX-1` (entrypoint contract) + `TELA-DOC-1` (immutable file-storage contracts) let HTML/CSS/JS/JSON/Markdown apps live entirely on-chain and be served locally. **Most active civilware repo (May 2026)** | The app hosts, serves, deploys, or browses on-chain dApps ("TELA apps") |
| [civilware/epoch](https://github.com/civilware/epoch) | `github.com/civilware/epoch` | "Crowd Mining": turns user interaction into AstroBWT hash submissions as an ad-free monetization layer for dApps/games | The user wants an alternative-to-ads monetization mechanic in a game or app |
| [civilware/derodpkg](https://github.com/civilware/derodpkg) | `github.com/civilware/derodpkg` | Importable package to run derod as a service within other Go applications | Embed a DERO daemon inside your app without managing a separate binary |
| [civilware/dM](https://github.com/civilware/dM) | `github.com/civilware/dM` | 100% on-chain encrypted messaging using DVM-BASIC smart contracts with homomorphic encryption | Private on-chain messaging with ring-signature deniability |
| [civilware/artificer-nfa-standard](https://github.com/civilware/artificer-nfa-standard) | `github.com/civilware/artificer-nfa-standard` | Non-Fungible Asset (NFA) standard for DERO — provides header structure used by TELA contracts | NFT/minting standards and TELA contract identification |
| [DHEBP/HOLOGRAM](https://github.com/DHEBP/HOLOGRAM) | n/a (reference app) | **Reference architecture**: a Wails (Go + web frontend) desktop app that is simultaneously an explorer, TELA browser/host, wallet, dev studio, and Gnomon-powered discovery tool. Read this first when scaffolding a full "everything" native app | Modeling a full desktop DERO browser/wallet/studio combo app |
| [DEROFDN/Engram](https://github.com/DEROFDN/Engram) | n/a (reference app) | Reference DERO Foundation wallet app built with **Fyne** (native cross-platform Go GUI, incl. mobile) wiring `derohe`, `Gnomon`, `tela`, `epoch` together | Modeling a Fyne-based (rather than Wails/web-based) native wallet/app, especially if mobile matters |
| [DEROFDN/netrunner](https://github.com/DEROFDN/netrunner) | n/a (reference app) | Fyne-based DERO CPU miner GUI | Modeling a standalone miner GUI, or the mining half of an app |
| [DHEBP/dero-docs](https://github.com/DHEBP/dero-docs) | n/a (docs source) | Source of https://derod.org — canonical docs for derod, TELA, HOLOGRAM, deropay | Deep-diving a specific mechanic (privacy math, DVM-BASIC syntax, RPC methods) — fetch the relevant page under derod.org rather than guessing |
| [DHEBP/dero-mcp-server](https://github.com/DHEBP/dero-mcp-server) | n/a (MCP server, not a library) | Gives an agent live read-only chain access + a bundled docs index via MCP tools | The user wants Claude itself to *look up* live chain state / docs while chatting, as opposed to writing app code. Complements this skill; doesn't replace it |
| https://derod.org | n/a | Canonical up-to-date docs site (rendered from dero-docs) | Any time you need current RPC method signatures, port numbers, or DVM-BASIC syntax — `web_fetch` the specific page |

## Architecture decision: which reference pattern to follow

Ask (or infer from context) which shape the user wants, then follow that reference pattern:

1. **Full desktop app with web-tech UI (explorer + wallet + TELA browser + dev studio in one)** → follow the **HOLOGRAM/Wails pattern**. See `references/hologram-pattern.md`.
2. **Native GUI wallet, especially if mobile/cross-platform matters** → follow the **Engram/Fyne pattern**. See `references/engram-fyne-pattern.md`.
3. **CLI tool or headless service (indexer, bot, backend)** → no GUI framework needed; just wire `derohe` + `Gnomon` (+ `tela` if serving content) directly. See `references/cli-headless-pattern.md`.
4. **A TELA dApp itself** (on-chain HTML/JS/CSS app, not a native Go host) → this is a smart-contract deployment task, not a Go app — see `references/tela-dapp-authoring.md`.

If the shape is genuinely unclear and it materially changes the scaffold, ask one concise question (Wails desktop app vs. Fyne native GUI vs. CLI/headless service vs. on-chain TELA dApp) before generating a full project. Otherwise pick the most reasonable default (Wails, since it's the most complete reference) and state the assumption.

## Core wiring: the go.mod pattern every app shares

Every native DERO app pins `derohe` (and often a community-patched fork of it) plus whichever of Gnomon/tela/graviton it needs. Example, modeled on HOLOGRAM's `go.mod`:

```go
module github.com/youruser/your-dero-app

go 1.24

require (
	github.com/civilware/Gnomon v0.0.0-latest
	github.com/civilware/tela v0.0.0-latest
	github.com/deroproject/derohe v0.0.0-latest
	github.com/deroproject/graviton v0.0.0-latest
	github.com/wailsapp/wails/v2 v2.11.0 // only if Wails desktop UI
)

// Community forks sometimes patch derohe faster than upstream tags.
// HOLOGRAM pins the DHEBP fork for sender-attribution fixes; only do this
// if you actually need a patch that isn't upstream yet.
// replace github.com/deroproject/derohe => github.com/DHEBP/derohe v0.0.0-latest
```

Run `go get <module>@latest` for each rather than hand-writing pseudo-versions — always fetch real current versions instead of guessing, since these repos update frequently. If `go get` needs a replace directive (a patched fork), check the target fork's latest commit first.

## Minimal wiring example (headless, no GUI)

```go
package main

import (
	"fmt"
	"github.com/deroproject/derohe/rpc"
	"github.com/deroproject/derohe/walletapi"
	"github.com/civilware/Gnomon/indexer"
	"github.com/civilware/Gnomon/storage"
)

func main() {
	// 1. Point wallet/RPC client at a daemon (see references/ports.md for network ports)
	walletapi.SetDaemonAddress("127.0.0.1:10102") // mainnet RPC port
	walletapi.Connect("127.0.0.1:10102")

	// 2. Open (or create) a disk wallet
	wallet, err := walletapi.Open_Encrypted_Wallet("mywallet.db", "password")
	if err != nil {
		panic(err)
	}
	wallet.SetOnlineMode()
	fmt.Println("Address:", wallet.GetAddress().String())

	// 3. Spin up a Gnomon indexer against the same daemon to watch SC activity
	gravDB := storage.NewGravDB("./gnomondb", "./gnomondb/backups")
	idx := indexer.NewIndexer(gravDB, nil, "gravdb", []string{}, 1, "127.0.0.1:10102", "daemon", false, true, false, nil)
	go idx.StartDaemonMode(1)
}
```

This is illustrative, not exact — **always check current function signatures against `references/api-cheatsheet.md` first**, and re-verify against the live source on GitHub if the app is doing something non-trivial (constructor signatures do change between versions).

## Network / port reference

| Environment | Daemon RPC | Wallet RPC | P2P | GetWork |
|---|---|---|---|---|
| Mainnet | 10102 | 10103 | 10101 | 10100 |
| Testnet | 40402 | 40403 | 40401 | 40400 |
| Simulator (`derod --simulator`) | 20000 | 30000 | — | — |

XSWD (wallet↔browser-app permission bridge) listens on port `44326` regardless of network.

## Workflow when the user asks to build something

1. Identify the shape (see Architecture decision above) — ask only if it truly changes the scaffold.
2. Identify which subsystems are actually needed (wallet? indexing/search? TELA hosting? mining?) — don't wire in Gnomon or TELA if the app is a pure miner, for instance.
3. Read the matching `references/*.md` file(s) for the chosen pattern before writing code.
4. Scaffold `go.mod` with real, current versions (`go get` — don't guess pseudo-versions).
5. Write the integration code, citing the actual function signatures from `references/api-cheatsheet.md`, and cross-check anything load-bearing against the live GitHub source (these repos move fast; a cloned snapshot or memorized signature can go stale).
6. For anything about current RPC methods, DVM-BASIC syntax, or privacy mechanics that isn't in the references below, `web_fetch` the relevant page under `https://derod.org` rather than relying on training memory.
7. Default to **simulator** (`derod --simulator`, port 20000) for any runnable example or dev instructions, per DERO ecosystem convention — cheap, instant blocks, no real funds at risk.

## Reference files

- `references/api-cheatsheet.md` — condensed function signatures for `walletapi`, `rpc`, `Gnomon/indexer`, and `tela` packages
- `references/hologram-pattern.md` — Wails full-app architecture (explorer + wallet + TELA + studio)
- `references/engram-fyne-pattern.md` — Fyne native GUI wallet architecture
- `references/cli-headless-pattern.md` — minimal headless service pattern (indexer/bot/backend)
- `references/tela-dapp-authoring.md` — authoring an actual on-chain TELA dApp (TELA-INDEX-1/TELA-DOC-1), as opposed to a Go host app
- `references/ports.md` — full port/network table + daemon flags
- `references/case-study-villager.md` — a real shipped TELA app (on-chain avatar/identicon registry) worked in full: DVM-BASIC index contract, DocShards for a large WASM runtime, signed-appData authenticity pattern, dual XSWD/direct-daemon socket architecture. Point to this whenever the user is building a "register once, store user content, browse others'" pattern, bundling a large binary into TELA, or asking how to make a TELA app impersonation-resistant.

## Gnomon documentation (derod.org)

| Resource | URL | Content |
|----------|-----|---------|
| Main Gnomon Page | https://derod.org/tools/gnomon | Overview, features, use cases |
| Deep-Dive Guide | https://tela.derod.org/tela-cli/gnomon-guide | Complete indexing guide (primary reference) |
| Command Reference | https://tela.derod.org/tela-cli/command-reference | All `gnomon` subcommands |
| Search Guide | https://tela.derod.org/tela-cli/search-guide | Search powered by Gnomon |
| Troubleshooting | https://tela.derod.org/tela-cli/troubleshooting | Gnomon connection issues |
| Hologram API Reference | https://hologram.derod.org/api-reference | Full Gnomon API methods (350+) |
| Hologram Settings | https://hologram.derod.org/settings | Auto-start, resync, WebSocket, search exclusions |
| WebSocket API | Port 9190 (JSON-RPC 2.0) | External tool integration |

**Gnomon status indicators**: `[G:▲]` = online, `[G:▼]` = offline

## Gnomon integration gotchas (from production experience)

1. **Fresh DB panics** — nexus fork's `StartDaemonMode()` panics on empty DBs. Fix: change panic to fallback to 0 in `indexer.go:183-196`
2. **Testnet DB path** — must use `gnomon` (no suffix), not `gnomon_testnet`
3. **Stale height** — after simulator restart, stored height > daemon chain height. Must check and reset DB (HOLOGRAM pattern)
4. **GravDB bloat** — issue #24 open 2+ years. Consider BoltDB for production
5. **No fsync in Graviton** — data loss possible on OS crash
6. **Goroutine leak** — `getInfo()` uses `time.Sleep(5s)` instead of `select` on `done` channel
7. **Scheme stripping** — happens 3 times redundantly (networks.go, gnomon.go, client.go)

## Complementary skills (install alongside this one)

If installed, these six companion skills cover ground this skill doesn't (DVM-BASIC language reference, working SC examples, wallet RPC method reference, and TELA JS/Go authoring patterns) — consult them instead of re-deriving that material here:
- `dero-dapps-guide` — end-to-end dApp building guide (privacy features, dApp categories, front-end integration options)
- `dvm-basic-programming` — DVM-BASIC syntax/operators/control-flow/blockchain-function reference
- `smart-contract-examples` — working Lottery/Token/Assets-exchange/Name-service contracts
- `wallet-rpc-api` — full wallet JSON-RPC method reference with curl examples
- `tela-javascript` — verified JS/CSS patterns, XSWD integration, TELA design system
- `tela-go` — full `civilware/tela` Go package API reference

This skill (`dero-native-dev`) is the odd one out in that set: it's about **native Go application architecture** (Wails/Fyne/headless, wiring derohe+Gnomon+tela together), not language/RPC/JS reference material — reach for the companions above for those.
