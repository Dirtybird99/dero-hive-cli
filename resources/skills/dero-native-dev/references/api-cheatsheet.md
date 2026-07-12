# API Cheatsheet

Condensed, curated function signatures for orientation. These were captured from a specific commit of each repo and **will drift** — before shipping anything non-trivial, check the current source:
- `github.com/deroproject/derohe` → `walletapi/`, `rpc/`, `config/config.go`
- `github.com/civilware/Gnomon` → `indexer/indexer.go`
- `github.com/civilware/tela` → `tela.go`, `mods.go`

## `walletapi` (package `github.com/deroproject/derohe/walletapi`)

Wallet creation / recovery:
```go
func Generate_Keys_From_Random() (user *Account, err error)
func Generate_Account_From_Recovery_Words(words string) (user *Account, err error)
func Create_Encrypted_Wallet_Random(filename, password string) (wd *Wallet_Disk, err error)
func Create_Encrypted_Wallet_From_Recovery_Words(filename, password, electrum_seed string) (wd *Wallet_Disk, err error)
func Open_Encrypted_Wallet(filename, password string) (wd *Wallet_Disk, err error)
func (w *Wallet_Disk) Save_Wallet() (err error)
func (w *Wallet_Disk) Close_Encrypted_Wallet()
func (w *Wallet_Disk) Check_Password(password string) bool
```

Connection / mode:
```go
func SetDaemonAddress(endpoint string) string           // package-level default
func (w *Wallet_Memory) SetDaemonAddress(endpoint string) string
func (w *Wallet_Memory) SetOnlineMode() bool
func (w *Wallet_Memory) SetOfflineMode() bool
func IsDaemonOnline() bool
func (w *Wallet_Memory) IsDaemonOnlineCached() bool
```

Balances / address / sync:
```go
func (w *Wallet_Memory) GetAddress() (addr rpc.Address)
func (w *Wallet_Memory) Get_Balance() (mature_balance uint64, locked_balance uint64)
func (w *Wallet_Memory) Get_Balance_scid(scid crypto.Hash) (mature, locked uint64)
func (w *Wallet_Memory) Sync_Wallet_Memory_With_Daemon() (err error)
func (w *Wallet_Memory) Show_Transfers(scid crypto.Hash, coinbase, in, out bool, min_height, max_height uint64, sender, receiver string, dstport, srcport uint64) []rpc.Entry
func (w *Wallet_Memory) NameToAddress(name string) (addr string, err error)
```

Sending transactions:
```go
func (w *Wallet_Memory) Transfer_Simplified(addr string, value uint64, data []byte, scdata rpc.Arguments) (tx *transaction.Transaction, err error)
func (w *Wallet_Memory) TransferPayload0(transfers []rpc.Transfer, ringsize uint64, transfer_all bool, scdata rpc.Arguments, gasstorage uint64, dry_run bool) (tx *transaction.Transaction, err error)
func (w *Wallet_Memory) SendTransaction(tx *transaction.Transaction) (err error)
```

Signing:
```go
func (w *Wallet_Memory) SignData(input []byte) []byte
func (w *Wallet_Memory) CheckSignature(input []byte) (signer *rpc.Address, message []byte, err error)
func (w *Wallet_Memory) SignFile(filename string) error
```

Money formatting: `walletapi.FormatMoney(amount uint64) string` (DERO uses 5 decimal places — use this rather than hand-rolled division).

## `rpc` (package `github.com/deroproject/derohe/rpc`)

Holds the wire types used everywhere: `rpc.Address`, `rpc.Transfer`, `rpc.Arguments`, `rpc.Entry`, plus daemon/wallet JSON-RPC request/response structs in `daemon_rpc.go` / `wallet_rpc.go` / `rpc_sc.go`. When calling a raw JSON-RPC daemon method by name (rather than through `walletapi`), match method name and param/result structs here exactly.

## `config` (package `github.com/deroproject/derohe/config`)

Holds `config.Mainnet` / `config.Testnet` structs with the canonical ports:
```go
GETWORK_Default_Port    // mainnet 10100, testnet 10100
RPC_Default_Port        // mainnet 10102, testnet 40402
Wallet_RPC_Default_Port // mainnet 10103, testnet 40403
```
Prefer reading these constants over hardcoding port numbers.

## Gnomon `indexer` (package `github.com/civilware/Gnomon/indexer`)

```go
func NewIndexer(
    Graviton_backend *storage.GravitonStore,
    Bbs_backend *storage.BboltStore,
    dbtype string,               // "gravdb" or "boltdb"
    search_filter []string,      // e.g. []string{"Function InitializePrivate"} to target specific SC signatures; empty = index everything
    last_indexedheight int64,
    endpoint string,             // daemon RPC address, e.g. "127.0.0.1:10102"
    runmode string,               // "daemon" or "wallet"
    mbllookup bool,
    closeondisconnect bool,
    fastsync bool,
    sfscidexclusion []string,
) *Indexer

func (indexer *Indexer) StartDaemonMode(blockParallelNum int)
func (indexer *Indexer) StartWalletMode(runType string)
func (indexer *Indexer) AddSCIDToIndex(scidstoadd map[string]*structures.FastSyncImport) (err error)
func (client *Client) GetSCVariables(scid string, topoheight int64, keysuint64 []uint64, keysstring []string, keysbytes [][]byte, codeonly bool) (variables []*structures.SCIDVariable, code string, balances map[string]uint64, err error)
func (ind *Indexer) Close()
```

Storage backends live in `github.com/civilware/Gnomon/storage` — `storage.NewGravDB(dbPath, backupPath string)` or a BoltDB equivalent, matching the `dbtype` string passed to `NewIndexer`.

## `tela` (package `github.com/civilware/tela`)

```go
func GetDefaultNetworkAddress() (network, destination string)
func Clone(scid, endpoint string) (err error)                       // pull a TELA-INDEX-1 app's files locally
func CloneAtCommit(scid, txid, endpoint string) (err error)         // pull a specific historical commit
func ServeTELA(scid, endpoint string) (link string, err error)      // clone + serve locally, returns local URL
func ServeAtCommit(scid, txid, endpoint string) (link string, err error)
func OpenTELALink(telaLink, endpoint string) (link string, err error)
func ShutdownTELA()
func ShutdownServer(name string)
func GetPath() string                                                // local clone/cache directory
func GetGasEstimate(wallet *walletapi.Wallet_Disk, ringsize uint64, transfers []rpc.Transfer, args rpc.Arguments) (gasFees uint64, err error)
func Transfer(wallet *walletapi.Wallet_Disk, ringsize uint64, transfers []rpc.Transfer, args rpc.Arguments) (txid string, err error)
```

`mods.go` exposes the TELA-MOD-1 system (reusable SC building blocks like variable-store get/set, DERO/asset deposit-withdraw, ownership transfer) via `MODs.GetMod`, `MODs.InjectMODs`, etc. — use these instead of writing DVM-BASIC variable-store boilerplate by hand.

See `references/tela-dapp-authoring.md` for the on-chain contract standards (TELA-INDEX-1 / TELA-DOC-1 / TELA-MOD-1) that this package parses and serves.
