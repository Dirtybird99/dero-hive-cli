import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { MAX_XSWD_SEND_QUEUE, XswdClient, XswdRpcError, xswdAppId, type XswdAppInfo } from './client';

const APP: XswdAppInfo = {
  id: xswdAppId('DERO Hive (CLI)'),
  name: 'DERO Hive (CLI)',
  description: 'DERO Hive AI development environment',
  url: 'http://localhost'
};

interface ServerContext {
  server: WebSocketServer;
  url: string;
}

async function startServer(onSocket: (socket: ServerSocket) => void): Promise<ServerContext> {
  const server = new WebSocketServer({ port: 0, path: '/xswd' });
  server.on('connection', onSocket);
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no server address');
  return { server, url: `ws://127.0.0.1:${address.port}/xswd` };
}

function acceptHandshake(socket: ServerSocket): void {
  socket.once('message', () => socket.send(JSON.stringify({ accepted: true, message: 'Connection established' })));
}

const timeout = setTimeout(() => {
  console.error('client tests timed out');
  process.exit(1);
}, 30_000);

(async () => {
  // 1. Handshake accept: valid ApplicationData first, awaiting-approval before resolution.
  {
    const frames: Array<Record<string, unknown>> = [];
    const ctx = await startServer((socket) => {
      socket.once('message', (data) => {
        frames.push(JSON.parse(data.toString()) as Record<string, unknown>);
        socket.send(JSON.stringify({ accepted: true, message: 'Connection established' }));
      });
    });
    const client = new XswdClient(ctx.url, APP);
    const order: string[] = [];
    client.on('awaiting-approval', () => order.push('awaiting-approval'));
    await client.connect().then(() => order.push('connected'));
    assert.deepEqual(order, ['awaiting-approval', 'connected']);
    assert.equal(frames.length, 1, 'server received a handshake frame');
    assert.match(String(frames[0].id), /^[0-9a-f]{64}$/);
    assert.equal(frames[0].name, 'DERO Hive (CLI)');
    assert.equal(client.open, true);
    client.close();
    ctx.server.close();
  }

  // 2. Handshake reject: connect() rejects with the wallet's message.
  {
    const ctx = await startServer((socket) => {
      socket.once('message', () => socket.send(JSON.stringify({ accepted: false, message: 'user denied' })));
    });
    const client = new XswdClient(ctx.url, APP);
    await assert.rejects(client.connect(), /user denied/);
    assert.equal(client.open, false);
    ctx.server.close();
  }

  // 3. Correlation: concurrent calls answered out of order resolve independently.
  {
    const ctx = await startServer((socket) => {
      acceptHandshake(socket);
      const held: Array<Record<string, unknown>> = [];
      socket.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (typeof msg.id !== 'number') return;
        held.push(msg);
        if (held.length === 2) {
          for (const req of held.reverse()) {
            const result = req.method === 'GetHeight' ? { height: 424242 } : { balance: 7, unlocked_balance: 7 };
            socket.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }));
          }
        }
      });
    });
    const client = new XswdClient(ctx.url, APP);
    await client.connect();
    const [height, balance] = await Promise.all([
      client.call('GetHeight'),
      client.call('GetBalance', {})
    ]);
    assert.deepEqual(height, { height: 424242 });
    assert.deepEqual(balance, { balance: 7, unlocked_balance: 7 });
    client.close();
    ctx.server.close();
  }

  // 4. Error mapping: -32043 becomes XswdRpcError with a friendly permission message.
  {
    const ctx = await startServer((socket) => {
      acceptHandshake(socket);
      socket.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (typeof msg.id !== 'number') return;
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32043, message: 'x' } }));
      });
    });
    const client = new XswdClient(ctx.url, APP);
    await client.connect();
    await assert.rejects(client.call('transfer', {}), (err: unknown) => {
      if (!(err instanceof XswdRpcError)) throw err;
      assert.equal(err.code, -32043);
      assert.match(err.message, /Permission denied/i);
      return true;
    });
    client.close();
    ctx.server.close();
  }

  // 5. Event dispatch: an id-less notification frame fires 'wallet-event'.
  {
    const ctx = await startServer((socket) => {
      acceptHandshake(socket);
      setTimeout(() => {
        socket.send('null');
        socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'new_balance', params: { value: 123 } }));
      }, 20);
    });
    const client = new XswdClient(ctx.url, APP);
    await client.connect();
    const [event] = (await once(client, 'wallet-event')) as [{ event: string; value: unknown }];
    assert.equal(event.event, 'new_balance');
    assert.equal(event.value, 123);
    client.close();
    ctx.server.close();
  }

  // 6. Close mid-flight: pending call rejects and 'closed' is emitted.
  {
    const ctx = await startServer((socket) => {
      acceptHandshake(socket);
      socket.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (typeof msg.id === 'number') socket.terminate();
      });
    });
    const client = new XswdClient(ctx.url, APP);
    await client.connect();
    const closed = once(client, 'closed');
    await assert.rejects(client.call('GetHeight'), /XSWD connection closed/);
    const [detail] = (await closed) as [{ wasConnected: boolean }];
    assert.equal(detail.wasConnected, true);
    assert.equal(client.open, false);
    ctx.server.close();
  }

  // 7. Throttle: rapid calls arrive at the server with >=100ms spacing.
  {
    const arrivals: number[] = [];
    const ctx = await startServer((socket) => {
      acceptHandshake(socket);
      socket.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (typeof msg.id !== 'number') return;
        arrivals.push(Date.now());
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { height: arrivals.length } }));
      });
    });
    const client = new XswdClient(ctx.url, APP);
    await client.connect();
    await Promise.all(Array.from({ length: 5 }, () => client.call('GetHeight')));
    assert.equal(arrivals.length, 5);
    for (let i = 1; i < arrivals.length; i++) {
      assert.ok(arrivals[i] - arrivals[i - 1] >= 100, `gap ${i} was ${arrivals[i] - arrivals[i - 1]}ms`);
    }
    client.close();
    ctx.server.close();
  }

  // 8. A wallet cannot push an unbounded WebSocket frame into Hive.
  {
    const ctx = await startServer((socket) => {
      acceptHandshake(socket);
      socket.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (typeof msg.id === 'number') {
          socket.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { data: 'x'.repeat(1024 * 1024) } }));
        }
      });
    });
    const client = new XswdClient(ctx.url, APP);
    await client.connect();
    await assert.rejects(client.call('GetHeight'), /XSWD connection closed/i);
    assert.equal(client.open, false);
    ctx.server.close();
  }

  // 9. A request that times out in the throttle queue is never sent later.
  {
    const methods: string[] = [];
    const ctx = await startServer((socket) => {
      acceptHandshake(socket);
      socket.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (typeof msg.id !== 'number') return;
        methods.push(String(msg.method));
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { height: 1 } }));
      });
    });
    const client = new XswdClient(ctx.url, APP);
    await client.connect();
    await client.call('GetHeight');
    await assert.rejects(client.call('ExpiredInQueue', undefined, 20), /timed out/);
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.deepEqual(methods, ['GetHeight']);
    client.close();
    ctx.server.close();
  }

  // 10. A stalled wallet cannot grow the outbound queue without bound.
  {
    const ctx = await startServer((socket) => acceptHandshake(socket));
    const client = new XswdClient(ctx.url, APP);
    await client.connect();
    const calls = Array.from({ length: MAX_XSWD_SEND_QUEUE }, () => client.call('GetHeight'));
    await assert.rejects(client.call('GetHeight'), /send queue is full/);
    client.close();
    await Promise.allSettled(calls);
    ctx.server.close();
  }

  clearTimeout(timeout);
  console.log('xswd client tests passed');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
