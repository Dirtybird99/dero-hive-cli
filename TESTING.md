# Testing

This ledger separates checks that run today from deeper certification work. **Current** means the repository has an automated check in `npm test`, `npm run test:coverage`, `npm run test:mcp-conformance`, `npm run test:package`, or CI. **Planned** is not evidence of current coverage.

## Feature ledger

| Feature | Inventory | Current automated evidence | Planned deterministic certification |
|---|---:|---|---|
| Slash commands | 70 commands, plus aliases | Command metadata, parsing, aliases, filtering, and suggestions are checked for every registered command. | Exercise each command's dispatch, happy path, invalid input, cancellation, and destructive confirmation where applicable. |
| Terminal TUI | Full-screen keyboard and mouse UI | Render tests cover startup, F2 Settings, provider list/picker/form/management states, masked key input, overlays, command entry, reduced motion, mouse parsing, session restore, and selected conversation flows. | Add event-driven coverage for provider validation, cancellation, refresh, and destructive confirmation. |
| Model providers | 12 presets | Loopback tests cover shared save/refresh/enable/remove behavior, encrypted key preservation and clearing, environment-key precedence, HTTP metadata, fallback models, stale refresh, OpenAI-compatible and Anthropic discovery, and fake-Codex thinking levels/process reuse. | Extend streaming text/reasoning/tools/usage, attachments, malformed responses, retries, cancellation, Windows hidden launch, and disposal. No paid endpoint is called. |
| Built-in tools | 21 tools | Every registered executor runs with disposable files, local network stubs, and fake simulator/media managers; path-boundary rejection and permission precedence are also checked. | Extend invalid-input and cancellation branches for long-running external processes. |
| Media providers | 9 presets | Local HTTP fakes cover successful connection and generation paths for all nine presets across image, audio, and video without paid calls. | Extend polling, cancellation, artifact persistence, provider error handling, and manager cleanup. |
| DERO MCP and simulator | 32 tools, 4 resources, 5 prompts | The packaged stdio test checks advertised counts and a loopback daemon ping; official HTTP conformance scenarios cover initialize, ping, and tool/resource/prompt listing. Simulator tests cover detached start/status/stop plus PID-identity refusal, and release acceptance exercises the real upstream binary's health and chain-info RPC. | Exercise every primitive, offline documentation tool, and composite with method-aware fixtures. |
| Conversations and approvals | Persistence, search, compaction, rewind, deletion, scoped rules | Disposable-database tests cover conversation persistence/search/compaction/deletion and approval-rule precedence. | Extend coverage to projects, worktrees, settings, memory, attachments, export/share, Git diff, simulator lifecycle, and principal failure paths. |
| Package and CI | Windows, macOS, Linux; npm 10 and 12 | CI runs typecheck, lint, tests, builds, committed-bundle checks, packed installation, Gitleaks, scoped 80/70/80 coverage thresholds, and MCP conformance. | Add simulator and public-release-artifact acceptance gates. |
| Privacy and secrets | Provider keys, Codex credentials, local data | Tests assert encrypted/no-database key storage, preserve/clear semantics, environment precedence, masked TUI rendering, Codex credential non-storage, temporary data directories, packed-artifact inspection, and repository secret scanning. | Extend redaction checks across provider errors and diagnostic output. Tests must never read, copy, migrate, display, or delete Codex credential-store entries or `~/.codex/auth.json`. |

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
npm run build
npm run test:package
```
