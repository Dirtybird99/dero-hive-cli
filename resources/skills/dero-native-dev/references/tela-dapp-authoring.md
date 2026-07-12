# Authoring a TELA dApp (on-chain, not a Go host app)

This is for when the user wants to build the **thing hosted on-chain** (an HTML/JS/CSS app living in DVM-BASIC smart contracts) rather than a Go application that hosts/browses TELA content. Source of truth: `civilware/tela` repo's `TELA-INDEX-1/README.md`, `TELA-DOC-1/README.md`, `TELA-MOD-1/README.md` — read these directly for exact DVM-BASIC syntax; this file is an orientation map.

## The three contract types

1. **`TELA-DOC-1`** — an *immutable* contract holding one file's content (HTML, CSS, JS, JSON, or Markdown — plus a generic "Static" type for anything else like build/asset files). This is where actual app code lives.
2. **`TELA-INDEX-1`** — a *mutable* entrypoint contract. Its `STORE` values point at one or more installed `TELA-DOC-1` SCIDs (`DOC1`, `DOC2`, ...), with `DOC1` as the required entrypoint. Also stores app metadata: `var_header_name`, `var_header_description`, `var_header_icon`, and the app's unique `dURL` (e.g. `myapp.tela`).
3. **`TELA-MOD-1`** — optional reusable building blocks (variable get/set, DERO/asset deposit-withdraw, ownership transfer) that a `TELA-INDEX-1` can pull in via a `mods` tag, instead of hand-writing that DVM-BASIC boilerplate every time.

## Why the DOC/INDEX split

Splitting immutable content (`DOC`) from a mutable pointer (`INDEX`) gives TELA apps a commit-based update model: you can install a new `TELA-DOC-1` version and repoint `INDEX`'s `DOC1` at it, while old commits remain retrievable (host apps like HOLOGRAM use this for "time travel" / viewing a past version of an app). Never try to make `TELA-DOC-1` content mutable to "simplify" this — the immutability is what makes old versions and integrity checks meaningful.

## Practical authoring flow

1. Prepare your file content (HTML/CSS/JS/JSON/Markdown), following the language-specific guidelines in `TELA-DOC-1/README.md` (there are minimal formatting constraints to reduce parse errors — check the current guidelines rather than assuming plain source works unmodified).
2. If the file is large, it may need to be split into DocShards — `civilware/tela`'s `GetTotalShards`/`ConstructFromShards`/`CreateShardFiles` functions handle this; don't hand-rollchunking.
3. Deploy the `TELA-DOC-1` (get a SCID back) — the recommended path is a compliant host app like **TELA-CLI** (`civilware/tela/cmd/tela-cli`) rather than manual `InitializePrivate()` fills, since the CLI automates and validates the fields.
4. Deploy a `TELA-INDEX-1` pointing its `DOC1` at that SCID, plus the header metadata and `dURL`.
5. To update later: deploy a new `TELA-DOC-1`, then update `TELA-INDEX-1`'s `DOC1` (or `DOC2`, etc.) to point at the new SCID — the old one remains retrievable by commit/txid via `tela.CloneAtCommit`/`tela.ServeAtCommit`.

## Serving/testing locally while authoring

Use the `civilware/tela` Go package (or TELA-CLI) to round-trip what you just deployed:
```go
link, err := tela.ServeTELA(scid, "127.0.0.1:20000") // simulator endpoint
// open `link` in a browser to see the live rendered app
```
Always test against the **simulator** (port 20000) while iterating — instant blocks mean no waiting for confirmations between deploy → view → tweak cycles.

## Connectivity for interactive apps: XSWD

If the TELA app needs wallet interaction (send DERO, invoke a paid SC function) from inside the rendered page, it does so via **XSWD** — a permissioned websocket bridge between the page and a running wallet, not a direct chain call. Every wallet-affecting XSWD request should be presented to the user for explicit approval by the host app (see `references/hologram-pattern.md` for how a host app implements that boundary) — a TELA app should never assume silent wallet access.
