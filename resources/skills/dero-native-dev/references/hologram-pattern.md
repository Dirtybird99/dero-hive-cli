# HOLOGRAM pattern: full desktop app (Wails)

Source: https://github.com/DHEBP/HOLOGRAM — read this repo directly for the real code; this file is an orientation map, not a copy.

## What it is

A single Wails v2 (Go backend + web frontend, compiled to a native desktop binary) app that is simultaneously:
- a block/tx **explorer** (with time-travel SC state via Graviton snapshots)
- a **browser** for TELA apps (dURL navigation, offline caching)
- a **wallet** (create/restore/manage, full tx history)
- a dev **studio** (local dev server, hot reload, batch TELA deploy)
- a **discovery** layer (Gnomon-powered search/ratings)

## Why Wails for this shape

Wails lets you write the UI in HTML/JS/CSS (so it can literally host/preview TELA apps using the same rendering surface the OS browser would) while all chain/wallet/indexing logic stays in Go, called from JS via Wails' auto-generated bindings. This is the right choice whenever the native app itself needs to render arbitrary web content (TELA apps) inside itself, not just make chain calls.

## File organization (mirror this, don't necessarily copy exact names)

HOLOGRAM splits by domain rather than by layer — each concern gets its own `*.go` file at the module root, all still `package main`, all with access to the shared Wails `app` struct's context:

- `app.go` — Wails `App` struct + `startup(ctx)` + shared state
- `daemon_client.go` — connects to a `derod` (local or remote), health checks
- `node_manager.go` / `node_manager_helpers.go` — optionally spawn and manage a local `derod` process (embedded node option)
- `wallet.go` / `wallet_genesis_service.go` — wallet lifecycle wrapping `walletapi`
- `blockchain.go`, `explorer_service.go`, `time_travel_explorer.go` — read-path chain/explorer views, using Graviton snapshots for "time travel" (viewing SC state at a past height)
- `gnomon.go`, `app_gnomon.go`, `gnomon_ws_server.go`, `gnomon_tags.go` — Gnomon indexer lifecycle + a websocket bridge so the frontend gets live index updates
- `tela_service.go`, `tela_deploy_helpers.go` — clone/serve/deploy TELA apps via the `tela` package
- `xswd_server.go`, `xswd_client.go`, `xswd_router.go`, `xswd_permissions.go`, `app_xswd_bridge.go` — XSWD (wallet↔web-app permission bridge) support, so hosted TELA apps can request wallet actions with per-request user approval
- `local_dev_server.go`, `app_devsupport.go`, `dev_support_worker.go` — the "studio" hot-reload dev server for building TELA apps
- `simulator_manager.go`, `simulator_wallets.go`, `simulator_developer.go` — one-click simulator environment (instant blocks, disposable wallets) for local development
- `epoch_handler.go` — crowd-mining integration (see `civilware/epoch`)
- `content_filter.go`, `network_filter.go`, `rating_system.go` — ratings/content-safety layer over Gnomon-indexed TELA apps
- `frontend/` — the actual web UI (Svelte/React/vanilla — check the repo's current frontend stack before assuming)

## Key architectural decisions worth reusing

1. **XSWD as the trust boundary.** Never let hosted/TELA-served JS call wallet functions directly through Wails bindings — route everything through the XSWD permission bridge so each wallet-affecting request gets explicit per-call user approval. This is the same boundary a real browser enforces between a webpage and OS-level APIs.
2. **Simulator-first dev loop.** The "studio" always targets the local simulator (port 20000) by default; switching to testnet/mainnet is an explicit user action, never a default.
3. **Graviton snapshots power "time travel."** Because Graviton versions every write, the explorer can show SC state as of any past topoheight without needing a second indexer — reuse this instead of building a separate history table.
4. **Domain-split files, shared struct.** Keeping one `App` struct but splitting methods across many files by concern (as above) keeps a Wails app navigable even as it grows past 50+ Go files — prefer this over one giant `app.go`.
5. **Replace directive for patched forks.** HOLOGRAM pins `replace github.com/deroproject/derohe => github.com/DHEBP/derohe ...` to get fixes ahead of upstream. Only do this if you actually hit a bug that's fixed in a fork but not yet upstream — check the fork's commit log/README for why it exists before pinning it.

## Scaffold starting point

```bash
go install github.com/wailsapp/wails/v2/cmd/wails@latest
wails init -n my-dero-app -t vanilla   # or -t svelte / -t react
cd my-dero-app
go get github.com/deroproject/derohe@latest
go get github.com/deroproject/graviton@latest
go get github.com/civilware/Gnomon@latest
go get github.com/civilware/tela@latest
```
Then split `app.go` by domain as above from the start rather than letting one file grow unbounded.
