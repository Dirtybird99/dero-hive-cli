#!/usr/bin/env node
// Mock XSWD wallet for local testing of DERO Hive's wallet integration.
// Speaks the server side of the XSWD protocol on ws://127.0.0.1:44326/xswd:
// handshake (ApplicationData -> accepted), JSON-RPC wallet methods, and
// periodic event notifications.
//
// Usage:
//   node scripts/mock-xswd-wallet.mjs           accept connections after 1s
//   node scripts/mock-xswd-wallet.mjs --deny    reject every handshake
//   node scripts/mock-xswd-wallet.mjs --slow    wait 70s before accepting (timeout drill)
import { WebSocketServer } from 'ws';
import { randomBytes } from 'node:crypto';

const deny = process.argv.includes('--deny');
const slow = process.argv.includes('--slow');
const PORT = 44326;

const MOCK_ADDRESS = 'deto1qy0ehnqjpr0wxqnknkc66x2m287h7lyt799sgdmock';
const HANDSHAKE_DELAY_MS = slow ? 70_000 : 1_000;
const WALLET_DIALOG_MS = 2_000; // simulated native confirmation dialog for writes

const server = new WebSocketServer({ port: PORT, path: '/xswd' });
console.log(`[mock-xswd] listening on ws://127.0.0.1:${PORT}/xswd (${deny ? 'DENY mode' : slow ? 'SLOW mode' : 'accept after 1s'})`);

server.on('connection', (socket) => {
  let accepted = false;
  console.log('[mock-xswd] connection opened');

  const topoTimer = setInterval(() => {
    if (!accepted) return;
    socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'new_topoheight', params: { value: 424242 + Math.floor(Date.now() / 10_000) } }));
  }, 10_000);

  socket.on('close', () => {
    clearInterval(topoTimer);
    console.log('[mock-xswd] connection closed');
  });

  socket.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (!accepted && typeof msg.id === 'string' && msg.name) {
      console.log(`[mock-xswd] handshake from "${msg.name}" (${msg.id.slice(0, 12)}…): ${msg.description}`);
      setTimeout(() => {
        if (deny) {
          socket.send(JSON.stringify({ accepted: false, message: 'user denied the connection request' }));
          socket.close();
        } else {
          accepted = true;
          socket.send(JSON.stringify({ accepted: true, message: 'Connection established' }));
          console.log('[mock-xswd] handshake accepted');
        }
      }, HANDSHAKE_DELAY_MS);
      return;
    }

    if (typeof msg.id !== 'number') return;
    const reply = (payload) => socket.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...payload }));
    console.log(`[mock-xswd] rpc #${msg.id} ${msg.method}`, msg.params ?? '');

    switch (msg.method) {
      case 'GetAddress':
        reply({ result: { address: MOCK_ADDRESS } });
        break;
      case 'GetBalance':
        reply({ result: { balance: 12345678, unlocked_balance: 12345678 } });
        break;
      case 'GetHeight':
        reply({ result: { height: 424242 } });
        break;
      case 'GetTransfers':
        reply({
          result: {
            entries: [
              { txid: 'aa'.repeat(32), amount: 100000, height: 424001, incoming: true },
              { txid: 'bb'.repeat(32), amount: 250000, height: 424100, incoming: false }
            ]
          }
        });
        break;
      case 'Subscribe':
      case 'Unsubscribe':
        reply({ result: true });
        break;
      case 'transfer':
      case 'scinvoke': {
        const destination = msg.params?.transfers?.[0]?.destination;
        setTimeout(() => {
          if (destination === 'deny') {
            reply({ error: { code: -32043, message: 'user denied the request' } });
          } else {
            reply({ result: { txid: randomBytes(32).toString('hex') } });
          }
        }, WALLET_DIALOG_MS);
        break;
      }
      default:
        reply({ error: { code: -32601, message: `unknown method ${msg.method}` } });
    }
  });
});
