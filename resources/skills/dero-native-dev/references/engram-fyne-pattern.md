# Engram/netrunner pattern: native GUI with Fyne

Sources: https://github.com/DEROFDN/Engram (wallet), https://github.com/DEROFDN/netrunner (CPU miner GUI) — read these repos directly for real code; this file is an orientation map.

## What Fyne gives you that Wails doesn't

Fyne (`fyne.io/fyne/v2`) is a pure-Go, native-widget GUI toolkit — no web frontend, no JS bridge, no bundled webview. It compiles to real desktop binaries **and** iOS/Android via `fyne.io/fyne/v2/driver/mobile`. Choose this pattern over the HOLOGRAM/Wails pattern when:
- mobile support matters,
- the app doesn't need to render arbitrary HTML/JS (i.e. it's not itself a TELA browser),
- you want a smaller dependency footprint (no webview runtime).

Engram still integrates Gnomon and TELA (as a Go package, to interact with TELA content programmatically) even without a web-rendering surface — it just doesn't render TELA apps visually the way HOLOGRAM does.

## Engram file organization

Everything is `package main` at the module root, split by concern:
- `main.go` — Fyne app bootstrap (`app.New()`, window setup, mobile driver detection), plus DERO network port constants (simulator/testnet/mainnet triplets for wallet/daemon/getwork ports — mirror these rather than re-deriving)
- `functions.go` — most of the wallet/chain business logic
- `methods.go` — supporting methods, often UI-model glue
- `layouts.go` — custom Fyne layout implementations
- `theme.go` — custom Fyne theme (Engram ships its own dark theme rather than using Fyne defaults)
- `store.go` — local app state/persistence separate from the DERO wallet file itself
- `custom.go` — custom Fyne widgets
- `bundled.go` / `bundledp1.go` / `bundledp2.go` / `res.go` — bundled resource data (icons, fonts) generated via Fyne's resource bundler, split into parts because generated resource files get large

## netrunner: the miner-only subset

netrunner is a much smaller Fyne app — just a CPU miner GUI wired to `derohe`'s AstroBWT mining path (via a `civilware/derodpkg` convenience wrapper in netrunner's case) plus `docopt-go` for CLI flag parsing and a `difficulty.go`/`miner.go`/`thread.go` split for the actual mining loop, with platform-specific thread pinning (`thread_linux.go` / `thread_windows.go`). Use this as the template for a **standalone miner or mining-tab-within-a-larger-app**, rather than trying to derive mining wiring from HOLOGRAM (which delegates mining/crowd-mining to `epoch` instead of running a raw miner UI).

## go.mod shape (Engram-style, wallet + indexing + TELA, no mining)

```
require (
	fyne.io/fyne/v2 v2.6.2
	fyne.io/x/fyne v0.0.0-latest        // Fyne extras (extra widgets)
	github.com/civilware/Gnomon v0.0.0-latest
	github.com/civilware/epoch v0.0.0-latest   // if crowd-mining monetization is wanted
	github.com/civilware/tela v0.0.0-latest
	github.com/creachadair/jrpc2 v0.35.4        // JSON-RPC client used under walletapi
	github.com/deroproject/derohe v0.0.0-latest
	github.com/deroproject/graviton v0.0.0-latest
	github.com/gorilla/websocket v1.5.3         // Gnomon's wsserver / live indexer updates
	github.com/skip2/go-qrcode v0.0.0-latest    // address QR codes — near-universal in DERO wallet UIs
	mvdan.cc/xurls/v2 v2.4.0                     // detecting dURLs / links in text
)
```

## Scaffold starting point

```bash
go mod init github.com/youruser/my-dero-wallet
go get fyne.io/fyne/v2@latest
go get github.com/deroproject/derohe@latest
go get github.com/civilware/Gnomon@latest
go get github.com/civilware/tela@latest
```
Then structure as: `main.go` (bootstrap + window), `functions.go` (business logic), `theme.go` (visual identity — don't ship default Fyne theme for anything user-facing; Engram's own dark theme is a good reference), and split resource bundling into multiple files once it gets large (Fyne's `fyne bundle` CLI generates these).

## Mobile note

If targeting iOS/Android, budget extra time for Fyne's mobile build tooling (`fyne package -os android`/`-os ios`) and be aware wallet-key handling on mobile needs extra care around OS keystore APIs — check Engram's current mobile-specific code paths (search for `driver/mobile` usage) before assuming desktop wallet-storage code works unchanged on mobile.
