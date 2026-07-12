/**
 * Agent-instruction-style descriptions for every MCP tool registered by this server.
 *
 * Each description follows the same four-section template so MCP hosts (Cursor,
 * Claude Desktop, OpenCode) can present consistent guidance to the model:
 *
 *   - "When to call:" — call timing and sequencing relative to other tools.
 *   - "Input Requirements:" — explicit MUST/PREFER blocks. Use "none." when
 *     the tool takes no inputs (keeps the contract uniform so the CI guard
 *     can enforce the section's presence everywhere).
 *   - "Output:" — one-line description of the response shape so the model
 *     does not need to invoke the tool to discover its return type.
 *   - "PREFER ..." — optional. Citation/sequencing hints (e.g. point the
 *     model at bundled docs for context).
 *
 * The map is exported as a frozen object so descriptions cannot drift at
 * runtime. `scripts/check-mcp-descriptions.ts` imports this map and enforces
 * the four-section template in CI; do not bypass it by inlining descriptions
 * in src/server.ts.
 */

export const TOOL_DESCRIPTIONS = {
  dero_daemon_ping: `DERO daemon connectivity check via DERO.Ping.

When to call: as the first step in any chain investigation to confirm the daemon is reachable. Call before dero_get_info if you are unsure whether DERO_DAEMON_URL is correctly configured.

Input Requirements: none.

Output: a "Pong" string when the daemon is healthy. On failure this tool returns a structured _meta.error with code RPC_UNREACHABLE and a retry hint.`,

  dero_daemon_echo: `Echo strings through the daemon via DERO.Echo. Useful for round-trip sanity checks.

When to call: when you need to confirm that string payloads reach the daemon intact (e.g. before debugging a malformed call to a more complex tool). PREFER dero_daemon_ping for a lighter-weight liveness probe.

Input Requirements (CRITICAL):
- \`words\` MUST be a non-empty array of strings.

Output: the echoed string concatenated by the daemon.`,

  dero_get_info: `Get DERO daemon and chain metadata: height, topoheight, stableheight, difficulty, version, network, mempool size, and total supply (DERO.GetInfo).

When to call: first thing in any chain-state investigation or sync-health check. Call this BEFORE dero_get_sc, dero_get_transaction, or dero_get_block when you do not already know the current tip. PREFER citing dero_docs_search("DERO.GetInfo") so the user can verify field semantics.

Input Requirements: none.

Output: full chain info JSON including \`topoheight\`, \`stableheight\`, \`height\`, \`network\`, \`version\`, \`difficulty\`, \`tx_pool_size\`, and \`total_supply\`.`,

  dero_get_height: `Get the current block heights: tip height, stable height (finalized), and topoheight (canonical ordering) via DERO.GetHeight.

When to call: when you need a quick height snapshot without the full chain-info payload. PREFER dero_get_info when you also need network, version, or difficulty.

Input Requirements: none.

Output: \`{ height, stableheight, topoheight }\`.`,

  dero_get_block_count: `Get the total block count via DERO.GetBlockCount. This is a tip count, not a topoheight.

When to call: when you need just the block count (e.g. for delta math against a reference height). PREFER dero_get_height when you need tip and stable heights together.

Input Requirements: none.

Output: \`{ count }\`.`,

  dero_get_last_block_header: `Get the header of the current tip block via DERO.GetLastBlockHeader (no full block body).

When to call: when you need tip block metadata (hash, miner, timestamp, difficulty) without the transactions or miner_tx payload. PREFER dero_get_block when you need transactions or the miner_tx.

Input Requirements: none.

Output: \`{ block_header: { hash, height, topoheight, timestamp, difficulty, ... } }\`.`,

  dero_get_block: `Fetch a full block (header + miner_tx + transactions + topo position) by height OR hash via DERO.GetBlock.

When to call: when investigating a specific block or verifying a transaction's inclusion. Call dero_get_height first if you do not have a target height. PREFER citing dero_docs_search("block structure") so the user can verify field semantics.

Input Requirements (CRITICAL):
- You MUST provide exactly ONE of \`hash\` or \`height\`. Providing both or neither returns a structured INVALID_INPUT error.
- \`hash\` MUST be exactly 64 hex characters.
- \`height\` MUST be a non-negative integer.

Output: full block with \`block_header\`, \`miner_tx\`, \`txs\`, and topo position fields.`,

  dero_get_block_header_by_topo_height: `Get a block header by topological height (canonical ordering) via DERO.GetBlockHeaderByTopoHeight.

When to call: when you need a header keyed by topo position rather than chain height. Topoheight is the canonical ordering used by DERO indexers; height is the consensus block height.

Input Requirements (CRITICAL):
- \`topoheight\` MUST be a non-negative integer no greater than the current topoheight (call dero_get_info first if unsure).

Output: \`{ block_header: { hash, height, topoheight, timestamp, ... } }\`.`,

  dero_get_block_header_by_hash: `Get a block header by its 64-char hex hash via DERO.GetBlockHeaderByHash.

When to call: when you have a block hash (e.g. from a tx confirmation) and need its header without the full block body. PREFER dero_get_block when you also need the txs or miner_tx.

Input Requirements (CRITICAL):
- \`hash\` MUST be exactly 64 hex characters (matches /^[0-9a-fA-F]{64}$/).

Output: \`{ block_header: {...} }\`.`,

  dero_get_tx_pool: `List pending mempool transaction hashes via DERO.GetTxPool.

When to call: when checking unconfirmed activity, watching for a specific tx to land, or estimating mempool pressure. NOTE: \`tx_hashes\` may be \`null\` or an empty array when the mempool is empty — treat both as "no pending".

Input Requirements: none.

Output: \`{ tx_hashes: string[] | null }\`.`,

  dero_get_random_address: `Get random registered addresses from the chain (used for ring construction in private transfers) via DERO.GetRandomAddress.

When to call: when building a transfer ring in external wallet tooling, or sampling chain participants. Optional asset SCID limits sampling to holders of that asset.

Input Requirements:
- \`scid\` is OPTIONAL. When provided it MUST be exactly 64 hex characters.

Output: \`{ address: string[] }\`.`,

  dero_get_transaction: `Fetch one or more transactions by hash via DERO.GetTransaction. Each tx is returned with confirmation status, block hash, and (optionally) decoded JSON fields.

When to call: when tracing a tx by hash. Pair with dero_get_sc when the tx invokes a contract. PREFER citing dero_docs_search("transaction structure") so the user can interpret confirmations, ring members, and SC fields.

Input Requirements (CRITICAL):
- \`txs_hashes\` MUST be a non-empty array of 64-char hex strings.
- \`decode_as_json\` is OPTIONAL. PREFER \`1\` (any non-zero value) when you want JSON-decoded fields instead of raw blobs.

Output: \`{ txs: [...], txs_as_hex: [...] }\` with per-tx confirmation, block hash, and (when decoded) parsed payload.`,

  dero_get_encrypted_balance: `Get the ENCRYPTED balance blob for a DERO address at a topo height via DERO.GetEncryptedBalance.

CRITICAL: this returns an opaque encrypted blob, NOT a cleartext balance. Only the wallet holding the spend key can decrypt it. Do NOT present the encrypted bytes as a balance to the user.

When to call: when verifying that an address has on-chain encrypted state (e.g. before attempting a transfer with a wallet you control), or as a sub-step in another tool. PREFER citing dero_docs_search("encrypted balance") so the user understands the opacity.

Input Requirements (CRITICAL):
- \`address\` MUST start with \`dero1\` (mainnet) or \`deto1\` (testnet).
- \`topoheight\` MUST be an integer; use \`-1\` for the latest chain tip.
- \`scid\` is OPTIONAL. Omit for native DERO; provide 64-hex SCID for asset balances.

Output: \`{ status, registration, balance (encrypted blob), ... }\`.`,

  dero_get_sc: `Read smart contract state (code and/or stored variables) by SCID via DERO.GetSC. This is the primary entry point for any contract inspection on DERO.

When to call: as the first step in any DVM contract investigation. Pair with dero_docs_search("DVM-BASIC") to interpret the returned code blob. PREFER citing dero_docs_search("smart contract") or dero_docs_get_page on a relevant DVM page so the user can interpret the contract's state model.

Input Requirements (CRITICAL):
- \`scid\` MUST be exactly 64 hex characters (the contract id).
- \`code\` is OPTIONAL (defaults to true). Set false to skip the source blob when you only need stored variables.
- \`variables\` is OPTIONAL (defaults to true). Set false to skip variables when you only need the source.
- \`topoheight\` is OPTIONAL. Omit or use \`-1\` for the latest committed state.

Output: \`{ code, balances, variables: { stringkeys, uint64keys }, ... }\`.`,

  dero_get_gas_estimate: `Estimate gas (compute + storage) for transfers, SC deploys, or SC invokes via DERO.GetGasEstimate. This is a PRE-FLIGHT check; nothing is submitted.

When to call: BEFORE any wallet-side transfer/scinvoke (using external wallet tooling) to size fees, OR when explaining deploy costs to a user. PREFER citing dero_docs_search("gas estimate" or "fees") so the user understands how compute vs storage gas are charged.

Input Requirements (CRITICAL):
- At least ONE of \`transfers\`, \`sc\`, or \`sc_rpc\` MUST be provided.
- \`sc\` is the DVM-BASIC contract source string when estimating a deploy.
- \`sc_rpc\` is an array of \`{ name, datatype, value }\` invocation arguments (entrypoint + SC_ID + caller-provided params).
- \`signer\` is OPTIONAL but PREFERRED; pass the \`dero1.../deto1...\` address that would sign the eventual tx.

Output: \`{ gascompute, gasstorage, status }\`.`,

  dero_name_to_address: `Resolve a DERO on-chain registered name to its address via DERO.NameToAddress.

When to call: when a user supplies a human-readable name (e.g. "myname") instead of a \`dero1.../deto1...\` address.

Input Requirements (CRITICAL):
- \`name\` MUST be a non-empty string. Resolution is case-sensitive on the daemon side.
- \`topoheight\` MUST be an integer; use \`-1\` for the latest registry state.

Output: \`{ name, address }\`. On NOT_FOUND the daemon's RPC error is surfaced as a structured _meta.error.`,

  dero_get_block_template: `Get a mining block template for a miner payout address via DERO.GetBlockTemplate.

When to call: ONLY when you are actually mining. PREFER dero_get_last_block_header for general chain-tip inspection.

Input Requirements (CRITICAL):
- \`wallet_address\` MUST be a valid DERO address (\`dero1...\` or \`deto1...\`) that will receive the block reward.
- \`block\` is OPTIONAL. Set true to include the raw block blob in the response.
- \`miner\` is an OPTIONAL label.

Output: block template payload suitable for a mining client. Does NOT submit a block; submission requires the excluded DERO.SubmitBlock method.`,

  dero_docs_search: `Search the bundled DERO documentation index across derod, tela, hologram, and deropay (145+ pages). In-process — no network round trip.

When to call: when you need authoritative docs to answer a DERO question, OR before constructing a citation in your response. Call this BEFORE explaining DVM, RPC methods, TELA contracts, Hologram simulator, or DeroPay webhooks. PREFER returning the top match's \`canonical_url\` and \`slug\` to the user as a citation.

Input Requirements (CRITICAL):
- \`query\` MUST be a non-empty search string.
- \`product\` is OPTIONAL. Provide when you know the scope to reduce noise (e.g. \`tela\` for TELA-DOC-1 questions).
- \`section\` is OPTIONAL. Provide a slug prefix to scope further (e.g. \`rpc-api\` under \`product=derod\`).
- \`limit\` is OPTIONAL (default 8, max 25).

Output: ranked matches with \`title\`, \`slug\`, \`headings\`, \`excerpt\`, \`canonical_url\`, and \`score\`.`,

  dero_docs_get_page: `Get a single bundled docs page by slug, with plain-text content and headings.

When to call: AFTER dero_docs_search has returned a candidate slug, OR when you have a known slug from a prior citation. PREFER dero_docs_search first when you only have a topic in mind.

Input Requirements (CRITICAL):
- \`slug\` MUST be a non-empty doc slug relative to pages/ (e.g. \`rpc-api/daemon-rpc-api\`, \`tutorials/first-app\`, \`dero-pay/quick-start\`).
- \`product\` is OPTIONAL but RECOMMENDED to disambiguate identical slugs across docs sites (\`derod\`, \`tela\`, \`hologram\`, \`deropay\`).
- \`offset\` is OPTIONAL. Long pages (the Captain archive, deep RPC references) are returned in 60000-char chunks; if \`content_truncated\` is true in the response, call again with \`offset: next_offset\` to fetch the next chunk.

Output: \`{ product, slug, title, headings, content, content_offset, content_length, content_truncated, next_offset, canonical_url, last_updated, source_path }\`. \`content_length\` is the total page size; \`content_truncated\` + \`next_offset\` signal whether to paginate.`,

  dero_docs_list: `List indexed bundled docs pages across all four products with slugs, titles, and canonical URLs.

When to call: when surveying available docs (e.g. "what TELA tutorials exist?"), OR when you need a slug catalog before invoking dero_docs_get_page. PREFER dero_docs_search when you have a specific question.

Input Requirements:
- \`product\` is OPTIONAL. Provide to scope to one of \`derod | tela | hologram | deropay\`.
- \`limit\` is OPTIONAL (default 120, max 500).

Output: \`{ docs_source, total, products, pages: [{ product, slug, title, canonical_url, last_updated }] }\`.`,

  trace_transaction_with_context: `Composite: look up a DERO transaction by hash, classify its confirmation status (confirmed | mempool | unknown) and kind (sc_install | transfer_or_invocation | coinbase | unknown), extract the SC surface inline when the tx is a contract install, and stitch the right DERO tx + DVM docs pages as citations.

When to call: as the FIRST step when investigating any tx by hash — the user asks "what is this tx", "is this confirmed", "what contract did this deploy", or "what does this tx do". PREFER this over chaining dero_get_transaction with dero_get_sc yourself: for SC INSTALL txs the composite already extracts the deployed function surface inline (no second RPC needed because the source is embedded in the tx record), classifies the kind so the agent does not have to inspect the raw shape, and protects against the "empty record" failure mode by surfacing structured TX_NOT_FOUND when the daemon does not know the hash.

Input Requirements:
- \`tx_hash\` is REQUIRED. Must be 64 hex chars.
- \`decode\` is OPTIONAL (default true). Pass false to ask the daemon to skip the JSON-decoded view (raw hex still comes back; the field hint that the binary is available).
- \`include_sc_context\` is OPTIONAL (default true). Set false to skip the inline extractScSurface call for SC install txs (useful when you only need confirmation / ring info).

Output: \`{ tx_hash, confirmation: { status, block_height, valid_block, invalid_blocks, in_pool }, kind, ring: { groups, first_group_size }, reward, signer_visible, native_balance, sc_install: { scid, surface, raw_code_length, has_code } | null, raw_tx_hex_length, narrative, related_docs, _diagnostics }\`. \`sc_install\` is non-null ONLY when the tx is a contract install AND the surface extractor produced something (tx_hash IS the resulting SCID in that case). SC invocation arg decoding is NOT performed — that requires walking the binary tx blob with the DERO tx codec, which is not bundled in this MCP. The composite surfaces \`raw_tx_hex_length\` so the agent knows the binary is available via dero_get_transaction. On unknown hash the daemon returns an empty record and the composite returns a structured \`_meta.error\` with code \`TX_NOT_FOUND\`.`,

  estimate_deploy_cost: `Composite: send a DVM-BASIC contract source to the daemon's gas estimator, then return the raw estimate alongside a plain-text breakdown (what each gas number means), the parsed contract surface, and curated DVM deploy docs as citations.

When to call: BEFORE asking a wallet to broadcast a deploy transaction, OR when explaining the cost of a contract to a user. PREFER this over chaining dero_get_gas_estimate yourself: this composite already explains gascompute vs gasstorage in plain language, parses the SC source to show what functions the user is about to deploy (reusing extractScSurface from explain_smart_contract), and protects against fabricating a breakdown when the daemon reports 0/0 with a non-OK status.

Input Requirements:
- \`sc\` is REQUIRED. The full DVM-BASIC contract source — must contain at least one \`Function ... End Function\` block. A function body alone will fail with INVALID_INPUT.
- \`signer\` is OPTIONAL. A dero1.../deto1... address that will sign the eventual deploy tx. The daemon uses it for fee context; omitting it still returns a meaningful estimate.
- \`include_breakdown\` is OPTIONAL (default true). Set false when you only need the raw numbers (e.g. piping into a fee table).

Output: \`{ estimate: { gascompute, gasstorage, status }, breakdown: { compute_note, storage_note, total_units } | null, signer_used, include_breakdown, sc_surface: { functions, stringkeys, uint64keys, raw_code_length, function_count }, related_docs }\`. \`breakdown\` is null when \`include_breakdown=false\` OR when the daemon returned 0/0 with a non-OK status (never fabricated). On DVM compile failure the composite returns a structured \`_meta.error\` with code \`INVALID_INPUT\` and the daemon's exact compile message in \`_meta.error.raw\`.`,

  recommend_docs_path: `Composite: take a natural-language intent, fan out parallel scoped searches across the bundled docs for all four DERO products (derod, tela, hologram, deropay), boost any product_hint matches by 1.5×, and return a ranked recommendation list with per-result rationale plus ready-to-cite related_docs.

When to call: at the START of any "where do I read about X?" or "which docs cover Y?" investigation, BEFORE calling dero_docs_search directly. PREFER this over guessing the right product: this composite already runs all four products in parallel, dedupes overlap, surfaces the top heading per result as rationale, and gives you the top-2 citations pre-built. Pass product_hint when the user has already said e.g. "TELA" or "DeroPay" so that product's matches float to the top.

Input Requirements:
- \`intent\` is REQUIRED. Free-text description of what the user is trying to do (min 8 chars). Drop verbs and use product nouns like "deploy a TELA app" or "verify a DeroPay webhook signature" for best results.
- \`product_hint\` is OPTIONAL. One of \`derod | tela | hologram | deropay\`. Multiplies hint-product scores by 1.5×.
- \`limit_per_product\` is OPTIONAL (default 2, max 5). Cap per-product hits before merging.

Output: \`{ intent, product_hint, limit_per_product, recommended: [{ product, slug, title, canonical_url, score, boosted_score, rationale }], by_product: { derod | tela | hologram | deropay: { count, top_slug, top_score } }, related_docs: DeroCitation[] }\`. \`related_docs\` is the top-2 picks pre-built as citations the agent can drop straight into a response. On zero matches across every product the composite returns a structured \`_meta.error\` with code \`NO_DOCS_MATCH\` and a hint to rephrase or drop the product_hint.`,

  explain_smart_contract: `Composite: fetch a DERO smart contract (code + variables + balances) and return its function surface, a classification of the contract pattern (tela_index | tela_doc | token | registry | minimal | generic), a plain-language narrative, and curated DVM docs citations re-ordered so the most relevant page is first. TELA contracts (apps/files) are detected first and cite the TELA spec; for a deep TELA parse use tela_inspect.

When to call: when the user wants to UNDERSTAND a smart contract — its functions, state shape, or which DVM concept to read about. PREFER this over chaining dero_get_sc with a docs lookup yourself: this composite already parses the DVM-BASIC source for function declarations, sorts stringkeys/uint64keys deterministically, and picks the right docs page from a heuristic so the agent does not have to learn DVM-BASIC syntax to summarize a contract.

Input Requirements:
- \`scid\` is REQUIRED. Must be 64 hex chars (the smart contract id). Use \`0000…0001\` for the on-chain name registry as a known-good example.
- \`topoheight\` is OPTIONAL. Provide to inspect the contract at a specific topo height; omit for latest tip.

Output: \`{ scid, topoheight, kind, surface: { functions[], stringkeys[], uint64keys[], balances }, narrative, raw_code_length, has_code, related_docs }\`. \`kind\` is one of \`tela_index | tela_doc | token | registry | minimal | generic\`. \`surface.functions\` items are \`{ name, args, returns }\`. \`has_code\` is false when the SCID is unknown or has no on-chain code; \`functions\` is then \`[]\` and the narrative explains the gap. \`raw_code_length\` is always present so the agent knows when to fall back to \`dero_get_sc\` for the full source.`,

  tela_inspect: `Composite: fetch a TELA contract by SCID (DERO.GetSC code + variables) and parse it as either a TELA-INDEX-1 app manifest or a TELA-DOC-1 file contract, auto-detecting which standard it is from the stored keys. TELA is DERO's on-chain web-app platform: an INDEX is the app manifest (like package.json) and DOCs are the individual files (HTML/CSS/JS) stored on chain.

When to call: as the FIRST step whenever a user references a TELA SCID, a \`.tela\` dURL app, or asks "what is this TELA contract/app", "what files does this TELA app have", or "is this a TELA INDEX or DOC". PREFER this over dero_get_sc + manual parsing or explain_smart_contract: explain_smart_contract treats TELA contracts as generic DVM and its surface CAPS stored keys at 50, which silently drops DOCn entries on large manifests — tela_inspect reads the raw stringkeys directly so it enumerates ALL DOC references, and it decodes the TELA header/mods/commit schema the generic tool does not understand.

Input Requirements:
- \`scid\` is REQUIRED. Must be 64 hex chars (the TELA contract id).
- \`topoheight\` is OPTIONAL. Provide to inspect at a specific topo height; omit for the latest committed state.

Output: a discriminated union on \`kind\`. \`tela_index\` → \`{ scid, topoheight, kind, index: { name, description, icon, durl, mods[], docs:[{position, key, scid, is_entrypoint, malformed}], doc_count, commit, version_history[], current_commit_hash, owner, updateable:'unknown', updateable_note, parse_notes[] }, narrative, related_docs }\`. \`tela_doc\` → \`{ ..., doc: { filename, doc_type, sub_dir, durl, signature, content_embedded, code_size_bytes, immutable }, narrative, related_docs }\`. \`not_tela\` → \`{ ..., kind:'not_tela', reason, observed:{ stringkey_sample[], stringkeys_total, has_code, markers[] }, narrative }\` — returned (NOT an error) when the SCID is unknown or lacks TELA markers. Updateability cannot be derived from chain state (ringsize is not in GetSC) so it is honestly reported as 'unknown'.`,

  tela_get_doc_content: `Composite: fetch the actual file content stored in a TELA-DOC-1 contract. A DOC's file (HTML/CSS/JS/...) lives inside a DVM-BASIC comment block in the contract code — NOT in a stored variable — so this tool fetches DERO.GetSC, confirms the SCID is a DOC, and extracts the file bytes. Gzip-compressed files (a \`.gz\` filename, the TELA-CLI default) are transparently base64-decoded + decompressed to plaintext. Large files paginate via offset.

When to call: when a user wants to READ or inspect the actual code/markup a TELA app file holds (e.g. "show me the HTML of this TELA DOC", "what does this app's app.js contain"). Get DOC SCIDs from tela_inspect on an INDEX first. PREFER this over dero_get_sc: that returns the raw DVM contract wrapper; this extracts just the embedded file content and reports docType, size, and signature presence.

Input Requirements:
- \`scid\` is REQUIRED. Must be 64 hex chars and reference a TELA-DOC-1 contract (an INDEX or non-TELA SCID returns INVALID_INPUT with guidance).
- \`offset\` is OPTIONAL. Byte offset into the extracted content; pass \`next_offset\` to read the next chunk of a large file.
- \`topoheight\` is OPTIONAL. Omit for the latest committed state.

Output: \`{ scid, topoheight, filename, doc_type, sub_dir, content_embedded, content, content_offset, content_length, content_truncated, next_offset, compressed, decompressed, stored_filename, signature, signature_note, note, narrative, related_docs }\`. \`content\` is the plaintext file (a 60000-char chunk; paginate via \`next_offset\`), or null when content is not embedded (DocShard/STATIC/external). \`compressed\` is true for \`.gz\` files; \`decompressed\` is true when this tool gunzipped them (\`filename\` then strips \`.gz\`; \`stored_filename\` keeps the on-chain name). The contract's author signature presence is reported but NOT cryptographically verified.`,

  dero_durl_to_scid: `Composite: resolve a TELA dURL (e.g. "vault.tela") to its on-chain SCID(s) by discovering TELA apps directly from chain — no external Gnomon indexer required. TELA apps advertise a human-readable dURL; this finds the contract(s) that claim it.

When to call: when a user asks "what's the SCID for <something>.tela", "find the TELA app called X", or gives a dURL and wants the contract. IMPORTANT routing: for a registered DERO NAME like "quickbrownfox" (no dot, not a dURL), use dero_name_to_address instead — that is a name to address lookup, not a TELA app. This tool is only for TELA dURLs (they contain a dot / .tela / a dero:// prefix).

Input Requirements:
- \`durl\` is REQUIRED. A TELA dURL such as "vault.tela", "feed.tela", or "dero://cipherchess.tela". Case- and prefix-insensitive.

Output: \`{ query, normalized, found, match_count, scid, primary, collision, other_candidates[], narrative, related_docs }\` on a hit; \`{ query, normalized, found:false, match_count:0, hint }\` on a miss. dURLs are NOT unique — when multiple contracts claim one, the NEWEST is returned as \`scid\`/\`primary\` and the rest are disclosed in \`other_candidates\` with \`collision:true\`. The first call triggers a ~10s one-time discovery scan of the newest chain contracts (cached afterward). Feed the returned scid to tela_inspect to view the app.`,

  dero_tela_list_apps: `Composite: list/browse the TELA apps discovered on-chain (each with its dURL, name, SCID, and doc count) — answers "what TELA apps exist?" without any external indexer. Powered by an in-process scan of the newest chain contracts.

When to call: when a user wants to explore or search the TELA ecosystem ("what TELA apps are there", "show me TELA games", "is there a TELA app about X"), or to find a SCID when they do not know the exact dURL. For an exact dURL use dero_durl_to_scid; to inspect a specific SCID use tela_inspect.

Input Requirements:
- \`query\` is OPTIONAL. Case-insensitive filter matched against dURL and name (e.g. "chess", "vault").
- \`limit\` is OPTIONAL (default 50, max 200).

Output: \`{ query, total_matched, returned, truncated, apps:[{ scid, durl, name, install_height, doc_count }], index_meta, narrative, related_docs }\`. The first call triggers a ~10s one-time discovery scan (cached afterward). \`index_meta\` discloses how much of the chain was scanned so the answer's coverage is transparent.`,

  diagnose_chain_health: `Composite: run a four-step chain (DERO.Ping → DERO.GetInfo → DERO.GetHeight → DERO.GetTxPool) and return a single narrative health report with chain metadata, mempool snapshot, machine-readable signals, and curated docs citations.

When to call: as the first step in any chain-state investigation when the user asks "is the node healthy", "is it synced", or "what is the current state of the chain". PREFER this over chaining the four primitives yourself — the composite handles partial-failure modes and lag-depth classification consistently, and the response already cites the right docs page.

Input Requirements:
- \`include_tx_pool\` is OPTIONAL (default true). Set false to skip the mempool snapshot when you only need chain-tip status.

Output: \`{ status, narrative, signals[], chain, mempool, related_docs, _diagnostics }\`. \`status\` is one of \`healthy | lagging | partial | unreachable\`. \`chain\` is null when DERO.GetInfo was unreachable; \`mempool\` is null when skipped or the call failed. On total daemon unreachability the tool returns a structured \`_meta.error\` with code \`RPC_UNREACHABLE\`.`,

  audit_chain_artifact_claim: `Composite: audit a chain artifact (block topoheight, block hash, TX hash, and/or proof string) end-to-end. Returns a verdict (\`cited_in_false_claim\` | \`clean\`), the actual on-chain facts (block reward, TX acceptance status), an optional proof-string decode, a relayable narrative, and curated rebuttal docs citations.

When to call: when the user asks "what's going on with DERO block X?" / "is this transaction the inflation-claim TX?" / "does this proof string come from a known false claim?" PREFER this over chaining \`dero_get_block_header_by_topo_height\` + \`dero_get_transaction\` + \`dero_decode_proof_string\` yourself: the composite already runs them in parallel, joins them against the flagged false-claim registry, and emits a single \`verdict\` field plus a narrative so the agent does not need to compose the rebuttal arc from scratch each time.

Input Requirements (CRITICAL):
- At least ONE of \`topoheight\`, \`block_hash\`, \`tx_hash\`, or \`proof_string\` MUST be provided. The composite throws \`INVALID_INPUT\` otherwise.
- \`topoheight\` is OPTIONAL. Non-negative integer.
- \`block_hash\` is OPTIONAL. 64 hex characters.
- \`tx_hash\` is OPTIONAL. 64 hex characters.
- \`proof_string\` is OPTIONAL. Full \`deroproof…\` / DERO bech32 string with HRP.
- \`include_forge_demo\` is OPTIONAL (default false). When true AND \`tx_hash\` is provided, also forges a fresh demo proof for the same TX (via \`dero_forge_demo_proof\`) and embeds it under \`forge_demo\`. The demo amount auto-selects: a flagged artifact's pinned amount (e.g. -2.2M for the 2022 claim) > the cited \`proof_string\` V > -1 DERO. PREFER setting this true when the agent is fielding a "Verified ✓ means the chain minted coins, right?" question — the embedded forge IS the refutation.

Output: \`{ verdict, inputs, matched_artifacts[], context_note, chain_facts, proof_decode, forge_demo, narrative, related_docs, _diagnostics }\`. \`verdict\` is \`cited_in_false_claim\` when any input matches the flagged-artifact registry, else \`clean\`. \`chain_facts\` is null when no chain-querying input was provided or all daemon calls failed; \`proof_decode\` is null when no \`proof_string\` was provided. \`forge_demo\` is null unless \`include_forge_demo: true\` was passed; on success it carries \`{ skipped: false, forged_proof_string, target_amount, ring_slot, ring_size, ring_receiver_address, math, self_check, explorer_display_amount, demo_amount_source }\` (the slim form — full citations stay at the top level).

PREFER citing the returned \`related_docs\` verbatim in the agent response — they are the canonical rebuttal pages and have been validated against the bundled docs index by CI. Quote the \`context_note\` when verdict is \`cited_in_false_claim\` so the user understands why the artifact matters.`,

  dero_decode_proof_string: `Decode any DERO bech32 string (\`dero…\`, \`deto…\`, \`deroi…\`, \`detoi…\`, or \`deroproof…\`) into its constituent parts: HRP, network, compressed public key, and any embedded RPC arguments (CBOR-encoded). For \`deroproof…\` strings the "public key" is a derived blinder point used in the proof's commitment math, NOT a wallet pubkey — the tool surfaces \`is_proof: true\` so the agent does not mislabel it.

When to call: when the user pastes a \`deroproof…\` / integrated-address string and wants to know what value or fields it encodes. PREFER this over chaining bech32 decoders + CBOR libraries yourself: the tool implements the exact same wire format as DEROHE \`rpc.NewAddress\` and surfaces the \`RPC_VALUE_TRANSFER\` uint64 both as raw and as a signed/wraparound interpretation. The decoder is verified against the publicly-cited 2022 inflation-claim proof string (embedded uint64 = 18446743853709551435 = signed -2,200,000.00181 DERO).

Input Requirements (CRITICAL):
- \`proof_string\` is REQUIRED. The full bech32 string including HRP and separator (e.g. \`deroproof1qyy…\`). Whitespace is trimmed but the case must be consistent (all lower OR all upper per BIP-0173).

Output: \`{ decoded: { hrp, mainnet, is_proof, public_key_hex, arguments[] }, value_interpretation?: { uint64, signed_int64, is_negative_wraparound, signed_atoms, dero }, context_note?, related_docs? }\`. \`arguments\` is an array of \`{ name, type, type_label, semantic_name?, value }\`. \`value_interpretation\` is present only when an \`RPC_VALUE_TRANSFER\` (V) + \`uint64\` (U) argument is found. \`context_note\` + extra \`related_docs\` are silently attached when the input matches a flagged adversarially-cited artifact. Returns a structured \`_meta.error\` with code \`INVALID_BECH32\` on parse failure.

PREFER citing \`integrity/payload-vs-transaction-proofs\` and \`integrity/negative-transfer-protection\` in any agent response that frames a \`deroproof…\` decode result — readers should understand that "this string decodes to value V" is a display-layer fact, not a consensus statement.`,

  dero_forge_demo_proof: `Composite: build a fresh \`deroproof…\` display object for ANY chosen transaction, ring slot, and amount — including negative amounts that uint64-wrap into the trillions. The forged string is constructed locally from public chain data (no wallet, no keys, no broadcast). On an unpatched explorer it shows **Verified ✓** for the chosen amount; on the chain, nothing has changed.

When to call: when a user pastes a \`deroproof…\` string and asks "does Verified ✓ mean the chain minted these coins?" Forge an equivalent string for the same TX with a different amount and show the result side-by-side — that is the most direct refutation. Also useful for reproducing the \`docs/integrity/inflation-claim\` Part 3 demonstration on arbitrary inputs.

Math: \`blinder = C[ring_slot] − amount × G\`, then \`bech32("deroproof", version || blinder || CBOR({HH: zeros, VU: uint64}))\`. The tool runs the same equation \`proof.Prove()\` checks at \`proof/proof.go:88-95\` and self-verifies before returning a string. If the self-check fails, the tool throws rather than emit a string that would not verify.

Input Requirements (CRITICAL):
- Exactly ONE of \`tx_hash\` or \`tx_hex\` MUST be provided. \`tx_hash\` triggers a daemon fetch (and surfaces the receiver address); \`tx_hex\` skips the daemon and uses the raw bytes the caller already has.
- \`ring_slot\` is OPTIONAL (default 0). Must be in [0, ring_size).
- \`amount_dero\` is OPTIONAL (default "-1"). Signed decimal with up to 5 fractional digits, e.g. \`"-1"\`, \`"1000000"\`, \`"-2200000.00181"\`. Negative values produce uint64 wraparounds that unpatched explorers render as positive trillions.

Output: \`{ forged_proof_string, target_amount: { dero, atoms_signed, atoms_uint64 }, ring_slot, ring_size, ring_receiver_address, math: { C_slot_hex, amount_x_G_hex, blinder_hex }, self_check: { verified, method }, explorer_display_amount, context_note, related_docs, _diagnostics }\`. \`ring_receiver_address\` is null when \`tx_hex\` was passed (the hex carries publickey pointers, not addresses).

READ-ONLY: this tool never broadcasts, never touches a wallet, never mutates chain state. It computes a string from public inputs and returns it. Annotation \`readOnlyHint: true\` is preserved. PREFER citing the returned \`related_docs\` (the integrity rebuttal pages) in any agent response — readers should understand the forged string is a display-layer object, not a consensus event.`,
} as const

export type DeroToolName = keyof typeof TOOL_DESCRIPTIONS

export const DERO_TOOL_NAMES: readonly DeroToolName[] = Object.keys(
  TOOL_DESCRIPTIONS,
) as DeroToolName[]
