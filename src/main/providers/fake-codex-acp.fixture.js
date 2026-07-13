import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';

let connection;
let sessionNumber = 0;
let promptNumber = 0;
const pending = new Map();

const agent = {
  initialize() {
    return { protocolVersion: 1, agentCapabilities: { loadSession: false }, authMethods: [] };
  },
  newSession() {
    return { sessionId: `fake-session-${++sessionNumber}` };
  },
  loadSession() { return {}; },
  authenticate() {},
  setSessionConfigOption() {
    return { configOptions: [], currentValues: {} };
  },
  async prompt(params) {
    const number = ++promptNumber;
    await connection.sessionUpdate({
      sessionId: params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: number === 1 ? 'first-start' : 'second-only' } }
    });
    if (number === 1) await new Promise((resolve) => pending.set(params.sessionId, resolve));
    return { stopReason: 'end_turn' };
  },
  cancel(params) {
    const resolve = pending.get(params.sessionId);
    setTimeout(async () => {
      await connection.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'late-first' } }
      }).catch(() => {});
      resolve?.();
      pending.delete(params.sessionId);
    }, 20);
  },
  closeSession(params) {
    pending.get(params.sessionId)?.();
    pending.delete(params.sessionId);
  }
};

connection = new AgentSideConnection(
  () => agent,
  ndJsonStream(
    Writable.toWeb(process.stdout),
    Readable.toWeb(process.stdin)
  )
);
process.stdin.resume();
