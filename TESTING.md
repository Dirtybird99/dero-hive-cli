# Testing

This ledger separates checks that run today from deeper certification work. **Current** means the repository has an automated check in `npm test`, `npm run test:coverage`, `npm run test:mcp-conformance`, `npm run test:package`, `npm run test:e2e`, `npm run test:soak`, or CI. **Planned** is not evidence of current coverage.

## Feature ledger

| Feature | Inventory | Current automated evidence | Planned deterministic certification |
|---|---:|---|---|
| Slash commands | 71 commands, plus aliases | Command metadata, parsing, aliases, filtering, and suggestions are checked for every registered command; every usage line parses back to its own command, and tokenizer quote/escape/Windows-path edges, unknown-command fall-through, case folding, ranking tiers, suggestion-limit clamping, and skill-derived command normalization and builtin shadowing are covered. TUI tests dispatch a subset of commands end to end, including /delete's decline-then-confirm flow. | Exercise dispatch, happy path, invalid input, cancellation, and destructive confirmation for the remaining commands. |
| Terminal TUI | Full-screen keyboard and mouse UI | Render tests cover startup, F2 Settings, provider list/picker/form/management states, masked key input, overlays, command entry, reduced motion, mouse parsing, session restore, and selected conversation flows. Event-driven tests cover provider form validation banners, Esc cancellation with no partial save, connection tests, refresh success and failure with previous models kept, remove-provider confirmation decline and accept, composer editing with multiline submit keys, queued approval FIFO behavior, queue and loop caps, workspace-scoped session restoration, and SGR mouse edges (split chunks, modifier bits, pending-buffer cap). Untrusted terminal output is sanitized before rendering. | Drive a complete streamed chat turn through the full-screen renderer. |
| Model providers | 12 presets | Loopback tests cover shared save/refresh/enable/remove behavior, encrypted key preservation and clearing, environment-key precedence, HTTP metadata, fallback models, refresh de-duplication, removal mid-refresh, stale-refresh exclusions, corrupt-row recovery, adapter-cache eviction and shutdown, and fake-Codex thinking levels, process reuse, cancellation, session isolation, initialization timeout, unexpected exit, descendant cleanup, and disposal. Streaming tests cover text/reasoning/tool-call/usage events, malformed chunks, mid-stream errors, silent-stream guards, JSON fallback, attachment conversion with offline audio rejection, redacted non-2xx errors, abort without unhandled rejections, and service-level retry/fallback behavior for the OpenAI-compatible and Anthropic adapters. Provider response bodies, errors, and streaming events have bounded reads and deadlines. Model-metadata normalization and preset-catalog invariants are checked. | Exercise a live Codex browser-sign-in path under user supervision. No paid endpoint is called by deterministic tests. |
| Built-in tools | 21 tools | Every registered executor runs with disposable files, local network stubs, and fake simulator/media managers; invalid-input and RPC-failure branches, null-manager guards, canonical path-boundary rejection without symlink traversal, input/output size caps, guarded redirects, stalled bodies, and permission-rule precedence are checked. Shell cancellation, timeout, output caps, and descendant-process cleanup are covered. | Extend adversarial fixtures as new tools are added. |
| Media providers | 9 presets | Local HTTP fakes cover successful connection and generation paths for all nine presets across image, audio, and video without paid calls, plus polling to terminal statuses, provider error bodies at start and mid-poll, kind-aware artifact extensions (a video-extension bug fixed), and manager behavior: provider CRUD with secret preservation, job events, failure rows, the 50 MB cap, in-flight cancellation that late completion never overwrites (a bug fixed), project-scoped artifacts, deletion, and legacy path repair. | Exercise the hardcoded-long polling branches (MiniMax video's 5-second poll cadence and 8-minute deadline). |
| DERO MCP and simulator | 32 tools, 4 resources, 5 prompts | The packaged stdio test invokes every advertised tool against method-aware loopback daemon fixtures (dero_get_block and dero_get_block_count via their error paths), reads all four resources, renders all five prompts, and checks structured error codes, bounded hostile results, flagged-artifact integrity enrichment, stringkey truncation, an offline forge-proof round-trip, TELA inspect/doc-content/gzip/dURL discovery with a Gnomon registry scan and cache, and in-band protocol errors the server survives. Official HTTP conformance scenarios cover initialize, ping, and tool/resource/prompt listing. Simulator tests cover detached and attached lifecycles, idempotent start, restart, PID-identity refusal, corrupt/stale PID and lock recovery, spawn-failure cleanup, RPC refusal while down, binary-detection priority, pinned-source verification, pair rollback, and cross-process install serialization. | Add an opt-in gate that builds and exercises the pinned real upstream simulator binary; exercise production-scale TELA/Gnomon fixtures. |
| Conversations and approvals | Persistence, search, compaction, rewind, deletion, scoped rules | Disposable-database tests cover persistence, FTS search escaping and operators, compaction no-ops, summaries, and re-compaction, rewind edges, fork lineage, deletion with FTS purge, structured content/tool-call/usage round-trips, projects CRUD with corrupted-config recovery, settings and memory persistence, and approval-rule precedence. Attachment files dropped by delete, rewind, compaction, queue removal, or workspace transition are reclaimed without removing blobs still referenced by forks. Multiprocess tests exercise fresh initialization, WAL readers, concurrent message sequencing, and transactional rollback. Explicit project/conversation mismatches fail closed and implicit resume stays within the current workspace. | Extend coverage to worktrees, Git diff, and remaining principal failure paths. |
| Package and CI | Windows, macOS, Linux; Node.js 22 and 24; npm 12.0.1 | CI runs strict lifecycle-script installation, typecheck, lint, tests, builds, committed-bundle checks, isolated packed installation, Gitleaks, production dependency audit, scoped 80/70/80 coverage thresholds, and MCP conformance. A tag workflow repeats the cross-platform gates, packs one archive, installs and tests that exact archive, verifies its transfer checksum in a separately privileged job, attests it, and creates a non-replacing GitHub release. | Add post-publication installation and pinned simulator-artifact acceptance gates. |
| Privacy and secrets | Provider keys, Codex credentials, local data | Tests assert encrypted/no-database key storage, preserve/clear semantics, environment precedence, masked TUI rendering (typed keys never echo in the form or in save notices), Codex credential non-storage, temporary data directories, private POSIX modes for Hive-owned directories and sensitive files, packed-artifact inspection, and repository secret scanning. Package acceptance disables the OS keychain, clears inherited Hive and DERO environment values, uses an isolated data directory, and pins its daemon probe to loopback. Logger redaction is checked across keyword/separator/case variants, query strings, nested provider-error JSON and stack traces, Basic auth, prose and env-style secrets, and bare provider-key prefixes (four redaction gaps and a serialization crash fixed); streamed provider errors are redacted, simulator child processes do not inherit provider secrets, and direct CLI/TUI terminal sinks strip active control sequences. | Extend redaction checks as new diagnostic surfaces appear. Tests must never read, copy, migrate, display, or delete Codex credential-store entries or `~/.codex/auth.json`. |

## Live acceptance boundaries

- Deterministic protocol tests use local servers and a fake ACP process. They require no provider credentials and incur no usage charges.
- Codex receives one explicit, user-attended live acceptance before release: browser sign-in when required, model and thinking-level import, a streamed response, one approved read-only tool, cancellation, process reuse, and saved-conversation resume. This acceptance passed for v0.2.0 without reading or copying Codex credentials.
- Paid-provider live testing is out of scope. The deterministic suites certify Hive's request, response, streaming, and failure handling, not account entitlement, model quality, provider uptime, or third-party retention behavior.

## Run the current checks

```bash
npm run typecheck
npm run lint
npm test
npm run test:coverage
npm run test:mcp-conformance
npm audit --omit=dev --audit-level=high
npm run build
npm run test:package
```

To retain the exact archive exercised by package acceptance, pass an output path:

```bash
node scripts/package-acceptance.mjs artifacts/dero-hive-cli.tgz
```

Calibrate the installed-package E2E state machine against that exact archive before a long run:

```bash
npm run test:e2e -- --artifact artifacts/dero-hive-cli.tgz --duration 2m --evidence evidence/e2e-calibration
```

Then run the same probes for a genuine ten-hour wall-clock soak:

```bash
npm run test:soak -- --artifact artifacts/dero-hive-cli.tgz --duration 10h --evidence evidence/e2e-soak-10h
```

The harness installs the archive into an isolated Unicode/space-containing path, disables keychain access, strips inherited provider and DERO credentials, binds fake provider and DERO services to ephemeral loopback ports, and repeatedly checks JSON/classic chat, read-only tools, cancellation, restart persistence, cross-workspace rejection, terminal-control sanitization, SQLite integrity, resource trends, artifact immutability, secret-canary absence, and runtime cleanup. It records a canonical installed dependency graph and its SHA-256 beside the archive hash. A run passes only after the requested wall clock has elapsed with every required probe green and no leak flag.

The packed archive alone does not freeze registry-resolved transitive dependencies that are not bundled into it; the evidence graph records exactly what the isolated install exercised. MCP transports reject stdio frames and HTTP responses or SSE events over 4 MiB before JSON parsing, and result normalization further bounds what Hive copies into hooks, context, and the database. The operating system or fetch implementation necessarily materializes each incoming chunk before the transport limiter sees it, so one oversized chunk may exist transiently. Process-tree sampling is also observational: one-second Windows snapshots can miss a subsecond descendant, and a POSIX descendant that escapes the process group between samples can evade attribution. The harness records these limitations instead of presenting the soak as proof about unobserved processes.

## Tagged releases

Pushing an annotated `v<package-version>` tag whose commit is on `main` starts `.github/workflows/release.yml`. Unprivileged jobs run the cross-platform checks and create the archive. Only after those jobs pass does a separate job receive release and OIDC permissions, verify the transferred checksum, create build provenance, and publish the archive plus `SHA256SUMS`. The workflow refuses to replace an existing release. Repository-level immutable releases and tag protection are separate GitHub settings and should also be enabled.
