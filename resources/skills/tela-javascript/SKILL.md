---
name: tela-javascript
description: JavaScript, CSS, UI patterns, XSWD wallet integration, and templates for TELA platform development
license: MIT
compatibility: opencode
keywords:
  - tela
  - javascript
  - css
  - xswd
  - wallet
  - ui
  - templates
---

# TELA JavaScript Development Guide

## Table of Contents

- [JavaScript Patterns](#javascript-patterns)
- [CSS Patterns](#css-patterns)
- [UI/UX Patterns](#uiux-patterns)
- [XSWD Integration](#xswd-integration)
- [XSWD Basic Core](#xswd-basic-core)
- [Design Reference](#design-reference)
- [Templates Overview](#templates-overview)
- [Error Troubleshooting](#error-troubleshooting)

---

## JavaScript Patterns

### Modern JavaScript (ES6+) Works Fine

```javascript
// ES6+ features work perfectly in TELA
let socket;
const applicationData = {
    "id": "71605a32e3b0c44298fc1c549afbf4c8496fb92427ae41e4649b934ca495991b",
    "name": "TELA Demo Application",
    "description": "Basic WS connection parts for TELA application",
    "url": "http://localhost:" + location.port
};

let typed = 0;
const typeSpeed = 50;
const jsonBody = document.getElementById("jsonDisplayBody");
```

### Arrow Functions Work in Context

```javascript
// Arrow functions work perfectly in HTML script tags
document.addEventListener("mousemove", (event) => {
    clearTimeout(mouseTimeout);
    svgCursor.style.opacity = 1;
    svgCursor.style.left = event.clientX - 12 + "px";
    svgCursor.style.top = event.clientY - 15 + "px";
    
    mouseTimeout = setTimeout(() => {
        svgCursor.style.opacity = 0;
    }, 200);
});
```

### Traditional Functions for Main Logic

```javascript
// Traditional function declarations for main app logic
function typeWriter(text) {
    const html = document.getElementById("typingLabel");
    if (typed === 0) {
        html.innerHTML = "";
        typeText = text;
    }
    // ... rest of implementation
}

function sendData(d) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        try {
            socket.send(JSON.stringify(d));
        } catch (error) {
            console.error("Failed to send data:", error);
        }
    }
}
```

---

## CSS Patterns

### Complex Animations Work Fine

```css
/* Complex keyframe animations work perfectly */
@keyframes spin {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
}

@keyframes half-spin {
    0% { transform: rotate(0deg); }
    40% { transform: rotate(180deg); }
    50% { transform: rotate(175deg); }
    60%, 65% { transform: rotate(190deg); }
    100% { transform: rotate(360deg); }
}

@keyframes pulseGreen {
    0% {
        transform: scale(0.95);
        box-shadow: 0 0 0 0 var(--green);
    }
    50% {
        transform: scale(1);
        box-shadow: 0 0 0 10px rgba(0, 128, 0, 0);
    }
    100% {
        transform: scale(0.95);
        box-shadow: 0 0 0 0 rgba(0, 128, 0, 0);
    }
}

/* CSS variables work perfectly */
:root {
    --green: #46b868;
    --yellow: #fffb00;
    --red: #ed2024;
}
```

### Advanced CSS Features

```css
/* Advanced CSS features work */
.ring-image {
    width: 120%;
    height: 120%;
    animation: spin 120s ease-in infinite;
}

.wave {
    background: var(--wave);
    border-radius: 1000% 1000% 0 0;
    position: fixed;
    width: 200%;
    height: 12em;
    animation: wave 10s -3s linear infinite;
    transform: translate3d(0, 0, 0);
    opacity: 0.7;
}

/* Media queries work */
@media screen and (max-width: 670px) {
    .typing-container {
        margin-top: -40px;
        max-height: 280px;
        max-width: 90%;
    }
}

@media (prefers-color-scheme: dark) {
    :root {
        --background: #0d1117;
    }
}
```

---

## UI/UX Patterns

### Professional Animations

```html
<!-- Sophisticated SVG animations work fine -->
<div class="svg-container">
    <svg class="ring-image" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1947.86 1950.9">
        <!-- Complex SVG paths work fine -->
    </svg>
</div>
```

### Interactive Effects

```javascript
// Custom cursor effects
const svgCursor = document.getElementById("svgCursor");

document.addEventListener("mousemove", (event) => {
    clearTimeout(mouseTimeout);
    svgCursor.style.opacity = 1;
    svgCursor.style.left = event.clientX - 12 + "px";
    svgCursor.style.top = event.clientY - 15 + "px";
    
    mouseTimeout = setTimeout(() => {
        svgCursor.style.opacity = 0;
    }, 200);
});
```

### Typing Animation System

```javascript
// Sophisticated typing effect
let typed = 0;
let typeText = "";
const typeSpeed = 50;

function typeWriter(text) {
    const html = document.getElementById("typingLabel");
    if (typed === 0) {
        html.innerHTML = "";
        typeText = text;
    }
    
    if (typed < typeText.length) {
        html.innerHTML += typeText.charAt(typed);
        typed++;
        setTimeout(typeWriter, typeSpeed);
    }
    
    if (typed === typeText.length) {
        setTimeout(() => {
            typed = 0;
        }, typeSpeed);
    }
}
```

---

## XSWD Integration

XSWD connection patterns, application data structures, and API integration:

### Connection Setup

```javascript
const applicationData = {
    "id": "your-unique-app-id",
    "name": "Your TELA Application",
    "description": "Description of your app",
    "url": "http://localhost:" + location.port
};

const socket = new WebSocket("ws://localhost:44326/xswd");

socket.addEventListener("open", function(event) {
    socket.send(JSON.stringify(applicationData));
});

socket.addEventListener("message", function(event) {
    const response = JSON.parse(event.data);
    // Handle responses
});
```

### API Calls

```javascript
// Get network info
const networkInfo = await xswd.call('DERO.GetInfo');
console.log('Current height:', networkInfo.height);

// Get wallet balance
const balance = await xswd.call('GetBalance');
console.log('Balance:', balance.unlocked_balance / 100000, 'DERO');

// Get wallet address
const address = await xswd.call('GetAddress');
console.log('Address:', address.address);
```

---

## XSWD Basic Core

A lightweight XSWD implementation under 18KB:

```javascript
const XSWDBasic = {
    socket: null,
    isConnected: false,
    connectionStatus: 'disconnected',
    currentEndpointIndex: 0,
    
    endpoints: [
        'ws://localhost:44326/xswd',
        'ws://localhost:10103/xswd',
        'ws://localhost:40403/xswd'
    ],
    
    async initialize(options = {}) {
        this.applicationData.id = this.getOrCreateAppId();
        
        const connected = await this.tryConnect();
        
        if (connected) {
            this.updateStatus('connected');
            return true;
        }
        
        if (options.allowDevelopmentMode) {
            this.developmentMode = true;
            this.isConnected = true;
            this.updateStatus('dev-mode');
            return true;
        }
        
        this.updateStatus('failed');
        return false;
    },
    
    async call(method, params = {}) {
        if (this.developmentMode) {
            return this.simulateCall(method, params);
        }
        
        return new Promise((resolve, reject) => {
            const id = (++this.requestId).toString();
            const request = {
                jsonrpc: '2.0',
                id: id,
                method: method
            };
            
            if (params && Object.keys(params).length > 0) {
                request.params = params;
            }
            
            this.pendingRequests.set(id, { resolve, reject });
            this.socket.send(JSON.stringify(request));
            
            setTimeout(() => {
                if (this.pendingRequests.has(id)) {
                    this.pendingRequests.delete(id);
                    reject(new Error(`Request timeout: ${method}`));
                }
            }, 30000);
        });
    },
    
    async getNetworkInfo() {
        const info = await this.call('DERO.GetInfo');
        return {
            height: info?.height || 0,
            difficulty: info?.difficulty || 0,
            peer_count: info?.peer_count || 0
        };
    },
    
    async getBalance() {
        return await this.call('GetBalance');
    },
    
    async getAddress() {
        return await this.call('GetAddress');
    }
};
```

---

## Design Reference

### Essential Color Palette

```css
/* Brand Colors */
--primary-purple: #b959b6;
--secondary-purple: #f88efb;
--accent-cyan: #52c8db;

/* Text */
--text-primary: #ffffff;
--text-secondary: #b3b3b3;
--text-muted: #666666;

/* Backgrounds */
--bg-dark: #0a0c0e;
--bg-card: rgba(36, 40, 45, 0.96);

/* Status */
--success: #4ade80;
--warning: #fbbf24;
--error: #ef4444;
```

### Enhanced Card Component

```css
.card {
    background: rgba(36, 40, 45, 0.96);
    border: 1px solid rgba(82, 200, 219, 0.3);
    border-radius: 12px;
    padding: 1.5rem;
    margin-bottom: 1.5rem;
    backdrop-filter: blur(10px);
    transition: all 0.3s ease;
}

.card:hover {
    border-color: rgba(82, 200, 219, 0.5);
    transform: translateY(-2px);
    box-shadow: 0 8px 25px rgba(0, 0, 0, 0.3);
}
```

### Statistics Grid

```css
.stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 1rem;
    margin: 1.5rem 0;
}

.stat-card {
    background: rgba(0, 0, 0, 0.2);
    border: 1px solid rgba(82, 200, 219, 0.3);
    border-radius: 8px;
    padding: 1.5rem;
    text-align: center;
}

.stat-value {
    font-size: 2rem;
    font-weight: 700;
    color: #52c8db;
}

.stat-label {
    color: #b3b3b3;
    font-size: 0.9rem;
    text-transform: uppercase;
}
```

### Buttons

```css
.btn-primary, .btn-secondary {
    padding: 0.75rem 1.5rem;
    border-radius: 8px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s ease;
    border: none;
    font-size: 1rem;
}

.btn-primary {
    background: linear-gradient(135deg, #52c8db 0%, #45a8b8 100%);
    color: #fff;
}

.btn-secondary {
    background: transparent;
    border: 2px solid #52c8db;
    color: #52c8db;
}
```

### Loading Spinner

```css
.spinner {
    width: 40px;
    height: 40px;
    border: 4px solid rgba(82, 200, 219, 0.2);
    border-top-color: #52c8db;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
}

@keyframes spin {
    to { transform: rotate(360deg); }
}
```

---

## Templates Overview

### Available Templates

| Template | Size | Best For |
|----------|------|----------|
| XSWD Advanced | 25KB (6.4KB compressed) | Production apps |
| XSWD Basic Core | 15KB | Simple apps |
| Basic TELA App | 24KB total | Getting started |
| TELA API Template | 17KB | Complete API access |

### Quick Start

```bash
# Using TELA-CLI
tela-cli endpoint simulator wallet ./your-wallet.db

# Deploy files
install-doc index.html
install-doc styles.css
install-doc app.js

# Create INDEX
install-index YourAppName

# Test deployed version
serve [your-new-scid]
```

---

## Error Troubleshooting

### Common Error Categories

1. **XSWD Connection Errors** - WebSocket connection failed
2. **Deployment Errors** - File too large, invalid SCID
3. **Runtime Errors** - Cannot read property of undefined
4. **Network Errors** - Block not found, node not synced

### XSWD Connection Issues

```javascript
// Test XSWD ports
function testXSWDPorts() {
    const ports = [44326, 10103, 40403];
    
    ports.forEach(port => {
        const ws = new WebSocket(`ws://localhost:${port}/xswd`);
        
        ws.onopen = () => {
            console.log(`Port ${port} is accessible`);
            ws.close();
        };
        
        ws.onerror = () => {
            console.error(`Port ${port} failed`);
        };
    });
}
```

### File Size Errors

```bash
# Check file size
ls -lh your-file.html

# Calculate minified size
cat your-file.html | tr -d ' \n\t' | wc -c
```

**Solutions:**
1. Minify code
2. Enable compression during install
3. Split into multiple DOCs
4. Remove unused code

### Robust Error Handling

```javascript
async function safeCall(method, params = {}, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            return await xswd.call(method, params);
        } catch (error) {
            console.warn(`Attempt ${i + 1} failed:`, error.message);
            
            if (i === retries - 1) {
                throw error;
            }
            
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
}
```

### Diagnostic Script

```javascript
async function runDiagnostics() {
    const results = {
        browser: {},
        xswd: {},
        blockchain: {}
    };
    
    results.browser.userAgent = navigator.userAgent;
    results.browser.webSocketSupport = typeof WebSocket !== 'undefined';
    
    try {
        const testSocket = new WebSocket('ws://localhost:44326/xswd');
        await new Promise((resolve, reject) => {
            testSocket.onopen = resolve;
            testSocket.onerror = reject;
            setTimeout(reject, 5000);
        });
        results.xswd.connected = true;
        testSocket.close();
    } catch (e) {
        results.xswd.connected = false;
    }
    
    if (results.xswd.connected) {
        try {
            const info = await xswd.call('DERO.GetInfo');
            results.blockchain.height = info.height;
        } catch (e) {
            results.blockchain.error = e.message;
        }
    }
    
    console.log('Diagnostics Results:', JSON.stringify(results, null, 2));
    return results;
}
```

---

## Summary: What Works in TELA

### Modern JavaScript Features

- ES6+ syntax (let, const, arrow functions, template literals)
- Modern DOM APIs
- Promises and async/await patterns
- Classes and modules (within constraints)
- Event handling with addEventListener
- WebSocket connections and messaging

### Advanced CSS Features

- Complex animations (@keyframes, transforms)
- CSS variables (custom properties)
- Media queries (responsive design)
- Advanced selectors
- 3D transforms and filters
- Backdrop filters and effects

### UI/UX Capabilities

- Professional animations and transitions
- Interactive effects (cursors, hover states)
- Typing animations and text effects
- SVG animations
- Complex layouts and positioning

## Related Resources

### TELA Documentation

- [TELA Overview](https://tela.derod.org/tela/overview) - Platform introduction
- [XSWD Protocol](https://tela.derod.org/xswd/overview) - Wallet integration guide
- [Best Practices](https://tela.derod.org/best-practices) - Production development guide
- [Design Reference](https://tela.derod.org/design-reference) - UI components and styling

### Templates & Examples

- [Basic TELA App](https://tela.derod.org/templates/basic-app) - Complete starter template
- [XSWD Advanced](https://tela.derod.org/templates/xswd-advanced) - Production-ready XSWD library
- [XSWD Basic](https://tela.derod.org/templates/xswd-basic) - Lightweight XSWD implementation
- [TELA Demo](https://tela.derod.org/demo) - Complete source code and patterns
- [First App Tutorial](https://tela.derod.org/tutorials/first-app) - Build your first TELA app

### API & Development

- [API Reference](https://tela.derod.org/api-reference/complete-api-guide) - Complete API documentation
- [JavaScript Guidelines](https://tela.derod.org/javascript-guidelines) - Code patterns and best practices
- [Error Troubleshooting](https://tela.derod.org/error-troubleshooting) - Common issues and solutions
- [TELA CLI Workflows](https://tela.derod.org/tela-cli/workflows) - Command-line tools guide
- [Size Optimization](https://tela.derod.org/best-practices#size-optimization-techniques) - File optimization

---

**License**: MIT  
**Last Updated**: January 2026
