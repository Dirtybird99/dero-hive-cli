# DERO Hive CLI

DERO Hive CLI is a beta terminal-native AI coding workspace with multiple model providers, approval controls, project-aware tools, DERO development skills, and Model Context Protocol (MCP) support.

## System requirements

- Windows 10+, macOS 13+, or a current Linux distribution
- Node.js 22 or later
- npm 10 or later
- Git for repository and worktree features
- An internet connection for remote AI providers and initial installation

## Install

Install directly from GitHub:

```bash
npm install -g https://github.com/Dirtybird99/dero-hive-cli/releases/latest/download/dero-hive-cli.tgz --allow-remote=all --allow-scripts=better-sqlite3
```

`--allow-remote=all` permits this command to fetch the specified GitHub release artifact. The narrow `--allow-scripts` list permits only SQLite's native binding build. Hive and its DERO MCP server ship as prebuilt JavaScript bundles and run no install scripts. Do not use `sudo npm install -g`. If npm reports a permissions error, configure a user-owned global npm directory instead.

To pin this release, replace the URL with:

```text
https://github.com/Dirtybird99/dero-hive-cli/releases/download/v0.2.0/dero-hive-cli.tgz
```

The release also publishes `SHA256SUMS` for manual artifact verification.

### Verify the installation

```bash
hive --version
hive status
hive doctor
```

If `hive` is not found, restart the terminal and confirm npm's global binary directory is on `PATH`:

```bash
npm prefix -g
```

## First run

Open a terminal in the project you want Hive to work on, then launch it:

```bash
cd path/to/project
hive
```

The launch directory becomes the tool workspace. Use `hive -C path/to/project` to select another directory.

After the interface opens, press **F2** and select **Providers** to add a model provider. The headless CLI offers the same setup:

```bash
hive provider add
```

Choose Codex to use its ChatGPT browser sign-in, or choose an API provider and enter its key at the prompt. Refresh a provider's model list from Settings or the CLI when needed:

```bash
hive provider list
hive provider refresh PROVIDER_ID
```

Run `hive --help` for non-interactive commands. Inside the full-screen interface, type `/` for commands, `?` for help, or `/shortcuts` for keyboard controls.

## Providers

Press **F2** to open **Settings**, then select **Providers** to add a provider. API-backed providers fetch their model list after being saved.

| Provider | Authentication | Notes |
|---|---|---|
| Codex (ChatGPT) | ChatGPT browser sign-in | Saving starts model discovery automatically. Codex credentials are managed by Codex, not stored by DERO Hive. |
| OpenAI | API key | Uses the OpenAI-compatible chat endpoint. |
| Anthropic | API key | Uses the native Messages API. |
| OpenRouter | API key | Routes to supported upstream models. |
| Groq, OpenCode, MiniMax, Kimi, Moonshot | API key or subscription key | Use their documented OpenAI-compatible endpoints. |
| Ollama | None by default | Uses locally installed models. |
| Custom | Provider-defined | Uses a provider-defined OpenAI-compatible endpoint. |

### Codex (ChatGPT) setup

1. Press **F2**, select **Providers**, add **Codex (ChatGPT)**, and save it.
2. Complete the browser sign-in if Codex has no reusable local login session.
3. DERO Hive automatically imports the available Codex models and their reported thinking levels.

The Codex adapter stays alive for the terminal session. Normal messages reuse the existing ACP process and do not intentionally start another browser login. On Windows, the bundled Codex app-server is launched hidden to avoid console-window flashes.

Codex normally stores reusable credentials in the operating-system credential store or `~/.codex/auth.json`. Treat `auth.json` as a password and never commit or share it.

## DERO MCP server

Hive includes [DHEBP's DERO MCP server](https://github.com/DHEBP/dero-mcp-server) as an opt-in integration. It exposes 32 read-only tools, 4 resources, and 5 prompts.

1. Start `hive`.
2. Run `/mcp`.
3. Select **DERO MCP server** and press Enter.

The server checks `127.0.0.1:10102` first. If no local DERO daemon is available, it uses the upstream public fallback. Run your own daemon when query privacy matters. The MCP server does not require a wallet seed or private key.

## Update

Reinstall from the GitHub repository to get the current version:

```bash
npm install -g https://github.com/Dirtybird99/dero-hive-cli/releases/latest/download/dero-hive-cli.tgz --allow-remote=all --allow-scripts=better-sqlite3
```

DERO Hive CLI does not update itself in the background.

## Uninstall

Remove the global command:

```bash
npm uninstall -g dero-hive-cli
```

Configuration, provider credentials, conversations, and cached data remain under `~/.hive`. Delete that directory only if you also want to remove all local Hive data.

macOS, Linux, or WSL:

```bash
rm -rf ~/.hive
```

Windows PowerShell:

```powershell
Remove-Item -Path "$HOME\.hive" -Recurse -Force
```

## Troubleshooting

### Wrong Node.js version

```bash
node --version
```

Install Node.js 22 or later, then reinstall DERO Hive CLI.

### Native module error

`better-sqlite3` normally installs a prebuilt binary. If it does not load, reinstall with the approved scripts and a supported Node.js release:

```bash
npm install -g https://github.com/Dirtybird99/dero-hive-cli/releases/latest/download/dero-hive-cli.tgz --allow-remote=all --allow-scripts=better-sqlite3
```

### DERO MCP server unavailable

Reinstall the package to restore its bundled server. To inspect configured servers afterward:

```bash
hive mcp list
```

### Use a separate data directory

```bash
hive --data-dir path/to/data
```

You can also set `HIVE_DATA_DIR`. Do not run two Hive processes against the same database.

## Optional DERO simulator

The simulator build requires Git, Go, and platform archive tools. From a source checkout:

```bash
npm run setup:simulator
hive simulator status
```

The simulator is optional and is not downloaded during normal installation.

## Development

```bash
git clone https://github.com/Dirtybird99/dero-hive-cli.git
cd dero-hive-cli
npm ci
npm run dev
```

Checks:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

See [TESTING.md](TESTING.md) for the current coverage ledger and release acceptance boundaries.

## Data and security

- Hive stores its local database, settings, logs, and secrets under `~/.hive` unless overridden.
- Headless secret storage is machine-derived obfuscation, not an operating-system keychain. Protect the data directory accordingly.
- Provider keys may be supplied without persistence through `HIVE_PROVIDER_<ID>_API_KEY`, using an uppercase provider id with non-alphanumeric characters replaced by underscores.
- Do not place API keys, wallet seeds, private keys, or personal configuration in a project repository.
- Tool and MCP actions remain subject to Hive's approval controls.

Report vulnerabilities through the repository's private vulnerability-reporting form described in [SECURITY.md](SECURITY.md).

## License and credits

DERO Hive CLI is available under the [MIT License](LICENSE).

The bundled DERO MCP server retains its [DHEBP MIT license](resources/mcp/dero-mcp-server/LICENSE). Bundled DERO skills preserve their source attribution in [resources/skills/CREDITS.md](resources/skills/CREDITS.md).
