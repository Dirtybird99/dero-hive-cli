import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import type { XswdStatus } from '@shared/types';
import { normalizeXswdUrl, XswdManager } from './manager';

const TEST_WALLET_ADDRESS = 'dero1qy976ssakhfynpd4lnh39u7gw9spfzr9z55ckfd0yhrhsdr235glgqq28xlvm';

async function startServer(onSocket: (socket: ServerSocket) => void): Promise<{ server: WebSocketServer; url: string }> {
  const server = new WebSocketServer({ port: 0, path: '/xswd' });
  server.on('connection', onSocket);
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no server address');
  return { server, url: `ws://127.0.0.1:${address.port}/xswd` };
}

function waitForState(manager: XswdManager, wanted: XswdStatus['state']): Promise<void> {
  return new Promise((resolve) => {
    const listener = (status: XswdStatus) => {
      if (status.state !== wanted) return;
      manager.off('status', listener);
      resolve();
    };
    manager.on('status', listener);
  });
}

async function waitFor(predicate: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const timeout = setTimeout(() => {
  console.error('manager tests timed out');
  process.exit(1);
}, 30_000);

(async () => {
  // 1. Happy path: state transitions connecting -> awaiting-approval -> connected;
  //    per-surface identity is sent in the handshake.
  {
    const handshakes: Array<Record<string, unknown>> = [];
    const ctx = await startServer((socket) => {
      socket.once('message', (data) => {
        handshakes.push(JSON.parse(data.toString()) as Record<string, unknown>);
        socket.send(JSON.stringify({ accepted: true, message: 'Connection established' }));
      });
    });
    process.env.DERO_WALLET_URL = ctx.url;
    const manager = new XswdManager('cli');
    const states: string[] = [];
    manager.on('status', (status: XswdStatus) => states.push(status.state));
    const status = await manager.connect();
    assert.equal(status.state, 'connected');
    assert.deepEqual(states, ['connecting', 'awaiting-approval', 'connected']);
    assert.equal(handshakes[0].name, 'DERO Hive (CLI)');
    assert.match(String(handshakes[0].id), /^[0-9a-f]{64}$/);
    assert.equal(typeof status.connectedAt, 'number');
    // connect() is idempotent while connected
    const again = await manager.connect();
    assert.equal(again.state, 'connected');
    await manager.disconnect();
    assert.equal(manager.status().state, 'disconnected');
    assert.equal(manager.status().error, null);
    ctx.server.close();
  }

  // 2. ECONNREFUSED becomes a friendly error state (connect never throws).
  {
    process.env.DERO_WALLET_URL = 'ws://127.0.0.1:1/xswd';
    const manager = new XswdManager('cli');
    const status = await manager.connect();
    assert.equal(status.state, 'error');
    assert.match(String(status.error), /No XSWD wallet found/);
  }

  // 3. Handshake denial surfaces the wallet's message in the error state.
  {
    const ctx = await startServer((socket) => {
      socket.once('message', () => socket.send(JSON.stringify({ accepted: false, message: 'user denied' })));
    });
    process.env.DERO_WALLET_URL = ctx.url;
    const manager = new XswdManager('desktop');
    const status = await manager.connect();
    assert.equal(status.state, 'error');
    assert.match(String(status.error), /user denied/);
    ctx.server.close();
  }

  // 4. Server-side close while connected -> disconnected with explanatory error.
  {
    const sockets: ServerSocket[] = [];
    const ctx = await startServer((socket) => {
      sockets.push(socket);
      socket.once('message', () => socket.send(JSON.stringify({ accepted: true })));
    });
    process.env.DERO_WALLET_URL = ctx.url;
    const manager = new XswdManager('cli');
    await manager.connect();
    const dropped = new Promise<XswdStatus>((resolve) => {
      manager.on('status', (status: XswdStatus) => {
        if (status.state === 'disconnected') resolve(status);
      });
    });
    sockets[0].terminate();
    const status = await dropped;
    assert.match(String(status.error), /wallet closed the XSWD connection/);
  }

  // 5. Wallet ops throw while not connected.
  {
    process.env.DERO_WALLET_URL = 'ws://127.0.0.1:1/xswd';
    const manager = new XswdManager('cli');
    await assert.rejects(manager.getBalance(), /not connected/);
  }

  // 6. A superseded approval request cannot overwrite a newer connection.
  {
    const waiting = await startServer(() => { /* deliberately withhold approval */ });
    const approved = await startServer((socket) => {
      socket.once('message', () => socket.send(JSON.stringify({ accepted: true })));
    });
    process.env.DERO_WALLET_URL = waiting.url;
    const manager = new XswdManager('cli');
    const awaitingApproval = waitForState(manager, 'awaiting-approval');
    const staleConnect = manager.connect();
    await awaitingApproval;
    await manager.disconnect();
    assert.deepEqual(manager.status(), {
      state: 'disconnected', url: waiting.url, appName: 'DERO Hive (CLI)', connectedAt: null, error: null
    });

    process.env.DERO_WALLET_URL = approved.url;
    assert.equal((await manager.connect()).state, 'connected');
    await staleConnect;
    assert.equal(manager.status().state, 'connected');
    assert.equal(manager.status().url, approved.url);
    assert.equal(manager.status().error, null);
    await manager.disconnect();
    waiting.server.close();
    approved.server.close();
  }

  // 7. transfer/scinvoke param shaping and result normalization.
  {
    const requests: Array<Record<string, unknown>> = [];
    const ctx = await startServer((socket) => {
      socket.once('message', () => socket.send(JSON.stringify({ accepted: true })));
      socket.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (typeof msg.id !== 'number') return;
        requests.push(msg);
        const result =
          msg.method === 'GetAddress' ? { address: TEST_WALLET_ADDRESS }
            : msg.method === 'GetBalance' ? { balance: 100000, unlocked_balance: 90000 }
            : msg.method === 'GetHeight' ? { height: 42 }
              : msg.method === 'GetTransfers' ? { entries: null }
                : { txid: 'cc'.repeat(32) };
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      });
    });
    process.env.DERO_WALLET_URL = ctx.url;
    const manager = new XswdManager('cli');
    await manager.connect();
    assert.equal(await manager.getAddress(), TEST_WALLET_ADDRESS);
    assert.deepEqual(await manager.getBalance(), { balance: 100000, unlocked_balance: 90000 });
    assert.equal(await manager.getHeight(), 42);
    assert.deepEqual(await manager.getTransfers({ in: true }), { entries: [] });
    const transfer = await manager.transfer({ destination: TEST_WALLET_ADDRESS, amount: 100000 });
    assert.equal(transfer.txid, 'cc'.repeat(32));
    const invoke = await manager.scinvoke({
      scid: 'dd'.repeat(32),
      entrypoint: 'Vote',
      parameters: [{ name: 'choice', datatype: 'U', value: 1 }]
    });
    assert.equal(invoke.txid, 'cc'.repeat(32));

    const transferReq = requests.find((r) => r.method === 'transfer');
    assert.deepEqual(transferReq?.params, {
      transfers: [{ destination: TEST_WALLET_ADDRESS, amount: 100000 }],
      ringsize: 16
    });
    const invokeReq = requests.find((r) => r.method === 'scinvoke');
    assert.deepEqual(invokeReq?.params, {
      scid: 'dd'.repeat(32),
      ringsize: 2,
      sc_rpc: [
        { name: 'entrypoint', datatype: 'S', value: 'Vote' },
        { name: 'choice', datatype: 'U', value: 1 }
      ],
      sc_dero_deposit: 0,
      sc_token_deposit: 0
    });
    await manager.disconnect();
    ctx.server.close();
  }

  // 8. Wallet URL normalization permits local plaintext only and requires the XSWD path.
  {
    assert.equal(normalizeXswdUrl('192.168.2.251:44326/xswd'), 'ws://192.168.2.251:44326/xswd');
    assert.equal(normalizeXswdUrl('wallet.example.com/xswd'), 'wss://wallet.example.com/xswd');
    assert.equal(normalizeXswdUrl('wss://wallet.example.com/xswd/'), 'wss://wallet.example.com/xswd');
    assert.throws(() => normalizeXswdUrl('ws://wallet.example.com/xswd'), /must use wss/);
    assert.throws(() => normalizeXswdUrl('ws://user:pass@127.0.0.1:44326/xswd'), /credentials/);
    assert.throws(() => normalizeXswdUrl('ws://127.0.0.1:44326/xswd?token=x'), /query or fragment/);
    assert.throws(() => normalizeXswdUrl('ws://127.0.0.1:44326/'), /path must be \/xswd/);

    process.env.DERO_WALLET_URL = 'ws://wallet.example.com/xswd';
    const manager = new XswdManager('cli');
    const status = await manager.connect();
    assert.equal(status.state, 'error');
    assert.match(String(status.error), /must use wss/);
  }

  // 9. Every wallet result is validated before it reaches Hive.
  {
    const results: Record<string, unknown> = {
      GetAddress: { address: TEST_WALLET_ADDRESS },
      GetBalance: { balance: 1, unlocked_balance: 1 },
      GetHeight: { height: 1 },
      GetTransfers: { entries: [] },
      transfer: { txid: 'aa'.repeat(32) },
      scinvoke: { txid: 'bb'.repeat(32) }
    };
    const ctx = await startServer((socket) => {
      socket.once('message', () => socket.send(JSON.stringify({ accepted: true })));
      socket.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (typeof msg.id !== 'number') return;
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: results[String(msg.method)] }));
      });
    });
    process.env.DERO_WALLET_URL = ctx.url;
    const manager = new XswdManager('cli');
    await manager.connect();

    results.GetAddress = { address: 42 };
    await assert.rejects(manager.getAddress(), /malformed GetAddress/);
    results.GetAddress = { address: 'dero1invalid' };
    await assert.rejects(manager.getAddress(), /malformed GetAddress/);
    results.GetAddress = { address: TEST_WALLET_ADDRESS };
    results.GetBalance = { balance: '1', unlocked_balance: 1 };
    await assert.rejects(manager.getBalance(), /malformed GetBalance/);
    results.GetHeight = { height: -1 };
    await assert.rejects(manager.getHeight(), /malformed GetHeight/);
    results.GetTransfers = { entries: {} };
    await assert.rejects(manager.getTransfers(), /malformed GetTransfers/);
    results.transfer = { txid: 'not-a-txid' };
    await assert.rejects(
      manager.transfer({ destination: TEST_WALLET_ADDRESS, amount: 100000 }),
      /malformed transfer/
    );
    results.scinvoke = { txid: 'ff' };
    await assert.rejects(
      manager.scinvoke({ scid: 'dd'.repeat(32), entrypoint: 'Vote' }),
      /malformed scinvoke/
    );

    await manager.disconnect();
    ctx.server.close();
  }

  // 10. The connected wallet address is cached (for the write-approval review) and cleared on disconnect.
  {
    const ctx = await startServer((socket) => {
      socket.once('message', () => socket.send(JSON.stringify({ accepted: true })));
      socket.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (typeof msg.id !== 'number') return;
        if (msg.method === 'GetAddress') {
          socket.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { address: TEST_WALLET_ADDRESS } }));
        }
      });
    });
    process.env.DERO_WALLET_URL = ctx.url;
    const manager = new XswdManager('cli');
    assert.equal(manager.getConnectedAddress(), null, 'no cached address before connecting');
    await manager.connect();
    await waitFor(() => manager.getConnectedAddress() !== null);
    assert.equal(manager.getConnectedAddress(), TEST_WALLET_ADDRESS, 'the address is cached after connect');
    await manager.disconnect();
    assert.equal(manager.getConnectedAddress(), null, 'the cached address is cleared on disconnect');
    ctx.server.close();
  }

  delete process.env.DERO_WALLET_URL;
  clearTimeout(timeout);
  console.log('xswd manager tests passed');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
