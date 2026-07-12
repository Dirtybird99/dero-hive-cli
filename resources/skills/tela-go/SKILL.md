---
name: tela-go
description: Go package API reference and examples for TELA platform development
license: MIT
compatibility: opencode
keywords:
  - tela
  - go
  - golang
  - api
  - package
  - examples
---

# TELA Go Package API Reference

## Table of Contents

- [Installation](#installation)
- [Content Serving](#content-serving)
- [Smart Contract Operations](#smart-contract-operations)
- [Data Types](#data-types)
- [File Operations](#file-operations)
- [Rating System](#rating-system)
- [TELA Links](#tela-links)
- [MODs System](#mods-system)
- [Utilities](#utilities)
- [Constants](#constants)
- [Examples](#examples)
- [Error Handling](#error-handling)

---

## Installation

```bash
# Install the package
go get github.com/civilware/tela

# Import in your code
import "github.com/civilware/tela"
```

---

## Content Serving

### ServeTELA

Clones and serves a TELA-INDEX-1 smart contract locally:

```go
func ServeTELA(scid, endpoint string) (link string, err error)

// Example:
link, err := tela.ServeTELA("your-scid-here", "127.0.0.1:10102")
// Returns: http://localhost:8082/index.html
```

### ServeAtCommit

Serves a specific version by commit (TXID):

```go
func ServeAtCommit(scid, txid, endpoint string) (link string, err error)
```

### Clone

Downloads TELA content locally without serving:

```go
func Clone(scid, endpoint string) (err error)
```

### Server Management

```go
GetServerInfo() []ServerInfo           // List all running servers
HasServer(name string) bool            // Check if server exists
ShutdownTELA()                         // Stop all servers
ShutdownServer(name string)            // Stop specific server
SetPortStart(port int) error           // Set starting port (1200-65515)
PortStart() int                        // Get current port start
SetMaxServers(i int)                   // Set max concurrent servers
MaxServers() int                       // Get max servers limit
AllowUpdates(b bool)                   // Enable/disable updated content
UpdatesAllowed() bool                  // Check if updates allowed
GetPath() string                       // Get storage path
GetClonePath() string                  // Get clone storage path
SetShardPath(path string) error        // Set custom storage path
```

---

## Smart Contract Operations

### Installer

Installs TELA smart contracts (INDEX-1 or DOC-1):

```go
func Installer(wallet *walletapi.Wallet_Disk, ringsize uint64, params interface{}) (txid string, err error)
```

**Example - Installing a DOC:**

```go
doc := &tela.DOC{
    DocType: tela.DOC_HTML,
    Code:    "<html><body><h1>Hello TELA!</h1></body></html>",
    DURL:    "hello.tela",
    Headers: tela.Headers{
        NameHdr:  "index.html",
        DescrHdr: "A simple hello world page",
    },
}

txid, err := tela.Installer(wallet, 2, doc)
```

**Example - Installing an INDEX:**

```go
index := &tela.INDEX{
    DURL: "myapp.tela",
    DOCs: []string{"doc1-scid", "doc2-scid"},
    Mods: "vsoo,txdwd",
    Headers: tela.Headers{
        NameHdr:  "My TELA App",
        DescrHdr: "A TELA Application",
    },
}

txid, err := tela.Installer(wallet, 2, index)
```

### Updater

Updates an existing TELA-INDEX-1 smart contract (owner only):

```go
func Updater(wallet *walletapi.Wallet_Disk, params interface{}) (txid string, err error)
```

### Contract Information

```go
func GetDOCInfo(scid, endpoint string) (doc DOC, err error)
func GetINDEXInfo(scid, endpoint string) (index INDEX, err error)
```

**Example:**

```go
// Get DOC information
doc, err := tela.GetDOCInfo("doc-scid", "127.0.0.1:10102")
content, _ := doc.ExtractDocCode()
fmt.Printf("File: %s\nContent: %s\n", doc.Headers.NameHdr, content)

// Get INDEX information
index, err := tela.GetINDEXInfo("index-scid", "127.0.0.1:10102")
fmt.Printf("App: %s\nDOCs: %v\nMODs: %s\n", index.Headers.NameHdr, index.DOCs, index.Mods)
```

### Variable Storage

```go
func SetVar(wallet *walletapi.Wallet_Disk, scid, key, value string) (txid string, err error)
func DeleteVar(wallet *walletapi.Wallet_Disk, scid, key string) (txid string, err error)
func KeyExists(scid, key, endpoint string) (variable string, exists bool, err error)
func KeyPrefixExists(scid, prefix, endpoint string) (key, variable string, exists bool, err error)
```

### Transaction Utilities

```go
func NewInstallArgs(params interface{}) (args rpc.Arguments, err error)
func NewUpdateArgs(params interface{}) (args rpc.Arguments, err error)
func Transfer(wallet *walletapi.Wallet_Disk, ringsize uint64, transfers []rpc.Transfer, args rpc.Arguments) (txid string, err error)
func GetGasEstimate(wallet *walletapi.Wallet_Disk, ringsize uint64, transfers []rpc.Transfer, args rpc.Arguments) (gasFees uint64, err error)
```

---

## Data Types

### DOC

Represents a TELA-DOC-1 smart contract (individual file/component):

```go
type DOC struct {
    DocType     string       // Language identifier (e.g., "TELA-HTML-1")
    Code        string       // Smart contract code
    SubDir      string       // Subdirectory path
    SCID        string       // Smart Contract ID (set after deployment)
    Author      string       // Author address (set after deployment)
    DURL        string       // TELA decentralized URL
    Compression string       // Compression format (e.g., ".gz")
    SCVersion   *Version     // Smart contract version
    Signature                // Embedded signature
    Headers                  // Embedded headers
}

// Methods
func (d *DOC) ExtractDocCode() (docCode string, err error)
func (d *DOC) ExtractAsSVG() (svgCode string, err error)
func (d *DOC) ExtractMetaTags() (metaTags []MetaTag, err error)
```

### INDEX

Represents a TELA-INDEX-1 smart contract (application manifest):

```go
type INDEX struct {
    SCID      string               // Smart Contract ID
    Author    string               // Author address
    DURL      string               // TELA decentralized URL
    Mods      string               // TELA-MOD tags (comma-separated)
    DOCs      []string             // SCIDs of embedded DOC contracts
    SCVersion *Version             // Smart contract version
    SC        dvm.SmartContract    // DVM contract (not serialized)
    Headers                        // Embedded headers
}
```

### Headers

Standard metadata headers:

```go
type Headers struct {
    NameHdr  string // Display name
    DescrHdr string // Description text
    IconHdr  string // Icon URL or SCID
}
```

### Version

Semantic versioning:

```go
type Version struct {
    Major int
    Minor int
    Patch int
}

func (v Version) String() string
func (v *Version) LessThan(ov Version) bool
func (v *Version) Equal(ov Version) bool
```

### ServerInfo

Information about running servers:

```go
type ServerInfo struct {
    Name       string // Server display name
    Address    string // Server address (e.g., ":8082")
    SCID       string // Smart Contract ID being served
    Entrypoint string // Entry file (e.g., "index.html")
}
```

### Rating Types

```go
type Rating struct {
    Address string // Rater's DERO address
    Rating  uint64 // Rating value (0-99)
    Height  uint64 // Block height when rated
}

type Rating_Result struct {
    Ratings  []Rating // Individual ratings
    Likes    uint64   // Total likes count
    Dislikes uint64   // Total dislikes count
    Average  float64  // Average category (0-10)
}

func (res *Rating_Result) ParseAverage() (category string)
```

---

## File Operations

### Compression

```go
func Compress(data []byte, compression string) (result string, err error)
func Decompress(data []byte, compression string) (result []byte, err error)
func IsCompressedExt(ext string) bool
func TrimCompressedExt(fileName string) string
```

**Example:**

```go
htmlContent := `<!DOCTYPE html><html>...</html>`
compressed, err := tela.Compress([]byte(htmlContent), ".gz")
```

### File Sharding

For files exceeding ~18KB limit:

```go
func CreateShardFiles(filePath, compression string, content []byte) (err error)
func ConstructFromShards(docShards [][]byte, recreate, basePath, compression string) (err error)
func GetTotalShards(data []byte) (totalShards int, fileSize int64)
```

**Size Limits:**

- DOC code content: ~18KB maximum
- INDEX contracts: ~11.64KB maximum
- Shard size: 17,500 bytes each

### Parsing

```go
func ParseDocType(fileName string) (language string)
func GetCodeSizeInKB(code string) float64
func IsAcceptedLanguage(language string) bool
func ParseINDEXForDOCs(code string) (scids []string, err error)
func ParseHeaders(code string, headerType interface{}) (formatted string, err error)
func ValidateImageURL(imageURL, endpoint string) (svgCode string, err error)
func ParseSignature(input []byte) (address, c, s string, err error)
```

---

## Rating System

### Rating Operations

```go
func Rate(wallet *walletapi.Wallet_Disk, scid string, rating uint64) (txid string, err error)
func NewRateArgs(scid string, rating uint64) (args rpc.Arguments, err error)
func GetRating(scid, endpoint string, height uint64) (ratings Rating_Result, err error)
```

**Example:**

```go
// Rate content as "Good, Works well" (77)
txid, err := tela.Rate(wallet, "content-scid", 77)

// Get ratings
ratings, err := tela.GetRating("content-scid", "127.0.0.1:10102", 0)
fmt.Printf("Likes: %d, Dislikes: %d, Average: %.1f\n",
    ratings.Likes, ratings.Dislikes, ratings.Average)
```

### Rating Analysis

```go
// Get category and detail from rating
category, detail, _ := tela.Ratings.Parse(77)

// Get formatted string
ratingStr, _ := tela.Ratings.ParseString(77)

// Get category only
category := tela.Ratings.Category(7)
```

**Rating Scale:**

| Value | Category |
|-------|----------|
| 0 | Do not use |
| 1-2 | Broken/Major issues |
| 3-4 | Minor issues |
| 5-6 | Average |
| 7-8 | Good/Very good |
| 9 | Exceptional |

---

## TELA Links

### Link Parsing

```go
func ParseTELALink(telaLink string) (target string, args []string, err error)
func OpenTELALink(telaLink, endpoint string) (link string, err error)
```

**Example:**

```go
link := "tela://open/scid-here/docs/api.html"
target, args, _ := tela.ParseTELALink(link)
// target: "tela"
// args: ["open", "scid-here", "docs", "api.html"]
```

### Link Formats

```
tela://open/<scid>                    # Open application
tela://open/<scid>/path/to/file       # Deep link to content
tela://content/<scid>/<doc-number>    # Direct DOC link
tela://lib/<scid>                     # Library content
tela://bootstrap/<scid>               # Bootstrap collections
```

---

## MODs System

TELA-MOD-1 modules extend INDEX contracts:

```go
// Get all available MODs
allMods := tela.Mods.GetAllMods()

// Get specific MOD
mod := tela.Mods.GetMod("vsoo")

// Validate MOD combination
tags, err := tela.Mods.TagsAreValid("vsoo,txdwd")
```

### Available MODs

**Variable Store (vs):**

- `vsoo` - Owner Only
- `vsooim` - Owner Only Immutable
- `vspubsu` - Public Single Use
- `vspubow` - Public Overwrite
- `vspubim` - Public Immutable

**Transfer (tx):**

- `txdwa` - Deposit/Withdraw Assets
- `txdwd` - Deposit/Withdraw DERO
- `txto` - Transfer Ownership

**Example:**

```go
index := &tela.INDEX{
    DURL: "enhanced-app.tela",
    Mods: "vsoo,txdwd",
    DOCs: []string{"doc1-scid", "doc2-scid"},
}

txid, err := tela.Installer(wallet, 2, index)
```

---

## Utilities

### Version Management

```go
func ParseVersion(versionStr string) (version *Version, err error)
func GetVersion() (version Version)
func GetContractVersions(isDOC bool) (versions []Version)
func GetLatestContractVersion(isDOC bool) (version Version)
```

### Smart Contract Utilities

```go
func GetSmartContractFuncNames(code string) (names []string)
func EqualSmartContracts(c, v string) (contract dvm.SmartContract, err error)
func FormatSmartContract(sc dvm.SmartContract, code string) (formatted string, err error)
```

---

## Constants

### Document Types

```go
const (
    DOC_HTML      = "TELA-HTML-1"
    DOC_CSS       = "TELA-CSS-1"
    DOC_JS        = "TELA-JS-1"
    DOC_JSON      = "TELA-JSON-1"
    DOC_MD        = "TELA-MD-1"
    DOC_GO        = "TELA-GO-1"
    DOC_STATIC    = "TELA-STATIC-1"
)
```

### Headers

```go
const (
    HEADER_NAME         Header = "nameHdr"
    HEADER_DESCRIPTION  Header = "descrHdr"
    HEADER_ICON_URL     Header = "iconURLHdr"
    HEADER_MODS         Header = "mods"
    HEADER_DURL         Header = "durl"
    HEADER_DOCUMENT     Header = "DOC"
)
```

---

## Examples

### Complete Application Deployment

```go
package main

import (
    "fmt"
    "log"
    "github.com/civilware/tela"
    "github.com/deroproject/derohe/walletapi"
)

func main() {
    wallet, err := walletapi.Create_Encrypted_Wallet_From_Recovery_Words(
        "./wallet.db", "password123", "your recovery words here",
    )
    if err != nil {
        log.Fatal("Failed to load wallet:", err)
    }
    
    indexSCID, err := deployTELAApp(wallet)
    if err != nil {
        log.Fatal("Deployment failed:", err)
    }
    
    fmt.Printf("TELA app deployed: %s\n", indexSCID)
    
    link, err := tela.ServeTELA(indexSCID, "127.0.0.1:10102")
    if err != nil {
        log.Fatal("Failed to serve app:", err)
    }
    
    fmt.Printf("App running at: %s\n", link)
    select {}
}

func deployTELAApp(wallet *walletapi.Wallet_Disk) (string, error) {
    htmlDOC := &tela.DOC{
        DocType: tela.DOC_HTML,
        Code:    "<html><body><h1>Hello TELA!</h1></body></html>",
        DURL:    "myapp.tela",
        Headers: tela.Headers{NameHdr: "index.html"},
    }
    
    txid, err := tela.Installer(wallet, 2, htmlDOC)
    if err != nil {
        return "", err
    }
    
    index := &tela.INDEX{
        DURL: "myapp.tela",
        DOCs: []string{txid},
        Headers: tela.Headers{NameHdr: "My App"},
    }
    
    return tela.Installer(wallet, 2, index)
}
```

### Content Management

```go
type ContentManager struct {
    wallet   *walletapi.Wallet_Disk
    endpoint string
}

func (cm *ContentManager) GetContentInfo(scid string) error {
    index, err := tela.GetINDEXInfo(scid, cm.endpoint)
    if err == nil {
        fmt.Printf("App: %s\n", index.Headers.NameHdr)
        fmt.Printf("DOCs: %d\n", len(index.DOCs))
        return nil
    }
    
    doc, err := tela.GetDOCInfo(scid, cm.endpoint)
    if err == nil {
        fmt.Printf("Document: %s\n", doc.Headers.NameHdr)
        fmt.Printf("Type: %s\n", doc.DocType)
    }
    
    return nil
}

func (cm *ContentManager) SetMetadata(scid, key, value string) error {
    txid, err := tela.SetVar(cm.wallet, scid, key, value)
    if err != nil {
        return err
    }
    fmt.Printf("Metadata set: %s\n", txid)
    return nil
}
```

### Rate Content

```go
func RateContent(wallet *walletapi.Wallet_Disk, scid string, quality, functionality int) error {
    rating := uint64(quality*10 + functionality)
    txid, err := tela.Rate(wallet, scid, rating)
    if err != nil {
        return err
    }
    fmt.Printf("Rated: %s\n", txid)
    return nil
}
```

---

## Error Handling

All functions follow Go's standard error handling pattern. Common errors:

- **Invalid SCID** - Must be 64-character hex string
- **Network errors** - Daemon endpoint unreachable
- **Content not found** - SCID doesn't exist or isn't valid TELA contract
- **Port unavailable** - No free ports in configured range
- **Permission errors** - Attempting to update contracts you don't own
- **Size limits** - Contract too large for deployment

**Best Practices:**

- Always check error return values
- Estimate gas fees before deploying
- Handle network timeouts
- Validate inputs before operations

---

## Additional Resources

### TELA Documentation

- [TELA Overview](https://tela.derod.org/tela/overview) - Platform introduction
- [Go Package Reference](https://tela.derod.org/go-package-reference/api-reference) - API documentation
- [Go Examples](https://tela.derod.org/go-package-reference/examples) - Real-world examples
- [Advanced Features](https://tela.derod.org/advanced-features/tela-mods) - MODs system details
- [Best Practices](https://tela.derod.org/best-practices) - Development guidelines

### Go & DERO Resources

- [GitHub Repository](https://github.com/civilware/tela)
- [pkg.go.dev](https://pkg.go.dev/github.com/civilware/tela)
- [DERO Documentation](https://docs.dero.io/)
- [DERO Homepage](https://dero.io/)
- [DERO Docs](https://derod.org/)
- [DERO GitHub](https://github.com/deroproject/derohe)

---

**License**: MIT  
**Last Updated**: January 2026
