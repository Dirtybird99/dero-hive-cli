# Case study: Villager (real working TELA app)

The actual source (SC + JS, minus the multi-megabyte Rive WASM/JS shards) is bundled alongside this file in `references/villager-example/` — open those files directly rather than re-deriving patterns from this summary alone when writing similar code.

This is an orientation map of a real, shipped TELA app ("Villager" — a 24x24-pixel on-chain avatar/identicon system), based on its actual source files. Use it as a concrete worked example when the user is scaffolding something similar (on-chain user-generated content, signed authenticity metadata, or bundling large binary assets like WASM into TELA).

## What it is

Villager lets any DERO address register once and store exactly one 576-character string encoding a 24×24 pixel avatar in a DVM-BASIC smart contract. A deterministic backdrop (frame/background style) is derived from a hash of the user's address, so every Villager has both a user-chosen part (the pixel grid) and a non-forgeable identity-tied part (the backdrop) — an identicon pattern worth reusing whenever an app wants "user customizable but still address-verifiable" visuals.

## The smart contract (`villager2.bas`)

A minimal index-pattern DVM-BASIC contract:
- `Initialize()` — sets owner, a `population` counter, header metadata (`nameHdr`, `descrHdr`, `typeHdr`, `iconURLHdr`, `tagsHdr` — the same header convention TELA-INDEX-1 uses), a `devAddr`, and a `devFee`.
- `RegisterAccount()` / `UnRegisterAccount()` — per-address opt-in/opt-out, gated with `EXISTS("registered_" + address)` checks, maintaining an accurate `population` count.
- `StoreAvatar(avatar String)` — requires prior registration, enforces exact length (`STRLEN(avatar) == 576`), optionally forwards any attached `DEROVALUE()` to `devAddr` as a voluntary tip (**not** an enforced fee — the contract never requires payment, it just plumbs an optional donation through if the frontend attaches one), then stores the avatar and a `BLOCK_HEIGHT()` timestamp.
- `UpdateDevFee(newFee Uint64)` — owner-gated, changes the *suggested* fee the frontend displays; never enforced on-chain.

Reusable pattern: **on-chain data contracts should store their own header metadata** (name/description/icon/tags) rather than relying purely on an external TELA-INDEX-1 wrapper, so the contract remains self-describing even if queried directly. Also reusable: keeping monetization (`devFee`) advisory and frontend-enforced rather than contract-enforced, so the contract itself stays minimal and can't be seen as extracting mandatory rent.

## The TELA app bundle

Files, as actually shipped:
- `index.html` — a bare canvas (`#riveCanvas`) plus four script tags; almost all logic lives in JS, not markup
- `main.js` — global state, XSWD connection, wallet/daemon socket handling, avatar validation, SC calls
- `stage.js`, `gallery.js`, `villager-identicon.js` — rendering split by concern (single avatar editor "stage" vs. browsing a "gallery" of others' avatars vs. the identicon/backdrop generation algorithm)
- `villager-sample-generator.html` — a standalone tool page for previewing/generating sample avatars, shipped alongside the main app rather than as a separate deployment
- `blank-frame.png` — a static asset
- `villager-r3.riv` — a **Rive** (real-time interactive vector animation) file driving the avatar's animated presentation
- `rive.js.shards/`, `rive.wasm.shards/` — the Rive JS runtime and WASM binary, **pre-split into DocShards** (`rive-1.wasm.gz` … `rive-50.wasm.gz`, reassembled at runtime) because the raw WASM binary is too large for a single `TELA-DOC-1`. This is the practical, load-bearing example of `tela.GetTotalShards`/`ConstructFromShards` from `references/api-cheatsheet.md` — large third-party runtime binaries (WASM engines, ML models, etc.) are exactly the case DocShards exist for.
- `appData.txt` / `appData.txt.signed` — see below

## The signed-appData authenticity pattern

`appData.txt` holds a short hex token; `appData.txt.signed` wraps that same content in a `-----BEGIN DERO SIGNED MESSAGE-----` block, signed by the app's declared owner address (`ADDRESS_STRING(SIGNER())` used at contract `Initialize()` time is the same address that produces this signature). The app's JS hardcodes `valid_sc_owner` and can verify, off-chain, that:
1. the SCID's on-chain `owner` variable matches the expected dev address, **and**
2. `appData.txt.signed` is a valid signature over `appData.txt` from that same address,

giving users/host-apps a way to confirm "this deployed contract is really the developer's, not a copy-paste impersonation with a lookalike UI." This is worth reusing any time an app cares about impersonation resistance beyond just SCID pinning — pin the SCID **and** ship a signed authenticity file, since SCIDs alone don't stop someone from cloning your frontend and pointing it at their own (different) contract, but a bad actor can't forge your signature.

## Connectivity: dual-socket pattern

`main.js` opens **two** separate connections rather than one:
1. `ws://localhost:44326/xswd` — the wallet's XSWD bridge, used for wallet address/`scinvoke` calls (registration, storing avatars, tips), gated by the wallet's own per-request user approval.
2. A direct daemon websocket (`ws://<daemon-host>/ws`, host supplied by the wallet's XSWD response) — used for read-only chain queries (contract state, gallery browsing) so that every single read doesn't have to round-trip through the wallet approval flow.

Reusable takeaway: **split read-path and write-path connections**. Route anything wallet-signing/spending through XSWD (with per-call user approval), but query-only chain reads through a direct daemon connection the wallet hands you — this keeps the UI responsive for browsing/reading while still gating anything that touches funds or signatures.

## When to point the user at this case study

- They're building an on-chain "gallery"/registry pattern (register once, store one piece of user content, browse others') → the SC + gallery/stage split is the template.
- They need to ship a large binary (WASM runtime, font, model weights) inside a TELA app → point at the DocShards usage here, not a hand-rolled chunking scheme.
- They want tamper/impersonation resistance for a TELA app beyond "just trust the SCID" → the signed-appData pattern.
- They're deciding how many sockets/connections a TELA frontend needs → the XSWD-for-writes / direct-daemon-for-reads split.
