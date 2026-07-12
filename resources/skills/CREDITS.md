# Bundled Skill Credits

DERO Hive ships with seven opencode-style skills pre-installed. Each skill is
licensed MIT and aggregates material from public DERO ecosystem sources. This
file preserves attribution and points users to the canonical sources for
up-to-date material — Hive bundles snapshots that may drift as upstream docs
evolve.

## Skills

| Skill | Slash command | Size | Primary sources |
|-------|---------------|------|-----------------|
| `dero-dapps-guide` | `/dero-dapps-guide` | 14 KB | derod.org, civilware/tela, tela.derod.org |
| `dvm-basic-programming` | `/dvm-basic-programming` | 6 KB | docs.dero.io, derod.org/dvm, deroproject/derohe |
| `smart-contract-examples` | `/smart-contract-examples` | 12 KB | deroproject/derohe hardcoded examples |
| `tela-go` | `/tela-go` | 16 KB | civilware/tela, tela.derod.org |
| `tela-javascript` | `/tela-javascript` | 16 KB | tela.derod.org |
| `wallet-rpc-api` | `/wallet-rpc-api` | 7 KB | deroproject/derohe (`rpc/wallet_rpc.go`), derod.org |
| `dero-native-dev` | `/dero-native-dev` | 145 KB (incl. references) | deroproject/derohe, civilware/Gnomon, civilware/tela, DHEBP, DEROFDN, derod.org |

## Source projects

| Project | URL | License | Used by |
|---------|-----|---------|---------|
| DERO Project (`deroproject/derohe`) | https://github.com/deroproject/derohe | MIT (per upstream) | All smart-contract and RPC skills |
| DERO Docs (`derod.org`) | https://derod.org | Docs CC-BY-SA equivalent | All skills |
| DERO Community Docs (`docs.dero.io`) | https://docs.dero.io | Docs CC-BY-SA equivalent | dvm-basic-programming |
| TELA (`civilware/tela`) | https://github.com/civilware/tela | MIT | tela-go, tela-javascript, dero-native-dev |
| Gnomon (`civilware/Gnomon`) | https://github.com/civilware/Gnomon | MIT | dero-native-dev (⚠ dormant since Nov 2023) |
| TELA Docs (`tela.derod.org`) | https://tela.derod.org | Docs CC-BY-SA equivalent | tela-go, tela-javascript |
| Hologram reference (`DHEBP/HOLOGRAM`) | https://github.com/DHEBP/HOLOGRAM | MIT | dero-native-dev |
| Engram reference (`DEROFDN/Engram`) | https://github.com/DEROFDN/Engram | MIT | dero-native-dev |
| Netrunner reference (`DEROFDN/netrunner`) | https://github.com/DEROFDN/netrunner | MIT | dero-native-dev |
| `dero-docs` source (`DHEBP/dero-docs`) | https://github.com/DHEBP/dero-docs | MIT | dero-native-dev |

## Network/testnet artifacts

`smart-contract-examples` references live testnet SCIDs (`30b84e9ab…`,
`aacaa7bb…`, `0000000000…0001`). These are owned by the DERO project and may
be re-keyed or deprecated at any time — re-verify against `getsc` before use.

## License

The bundled SKILL.md files, references, and this CREDITS.md are distributed
under the MIT license, matching the upstream DERO ecosystem convention. Hive
itself is MIT-licensed; see the project root `LICENSE` for full text.