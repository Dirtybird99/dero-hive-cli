# Security Policy

## Supported versions

Security fixes are provided for the latest published release only.

## Reporting a vulnerability

Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/Dirtybird99/dero-hive-cli/security/advisories/new). Do not open a public issue for an undisclosed vulnerability.

Include the affected version, reproduction steps, impact, and any suggested mitigation. Please allow time to investigate before publishing details.

## Local secret storage

Hive stores local state under `~/.hive` unless `HIVE_DATA_DIR` overrides it. Provider credentials in `secrets.json` are encrypted with a machine-derived key, which deters casual inspection but is not equivalent to an operating-system keychain. Protect the data directory and backups with appropriate filesystem permissions and never store wallet seeds or spend keys in Hive.

Prompts and tool context are sent to the configured model provider. MCP servers may contact their configured services; the bundled DERO MCP server can use a public daemon when no local daemon is available.
