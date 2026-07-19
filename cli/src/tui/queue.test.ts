import assert from 'node:assert/strict';
import { enqueueLoopTick, type QueueItem } from './queue.js';

const queue: QueueItem[] = [];
assert.equal(enqueueLoopTick(queue, { prompt: 'first', loopId: 'loop-a' }), true);
assert.equal(enqueueLoopTick(queue, { prompt: 'duplicate', loopId: 'loop-a' }), false);
assert.equal(enqueueLoopTick(queue, { prompt: 'other loop', loopId: 'loop-b' }), true);
assert.deepEqual(queue.map((item) => item.prompt), ['first', 'other loop']);

queue.shift();
assert.equal(enqueueLoopTick(queue, { prompt: 'next tick', loopId: 'loop-a' }), true);
assert.deepEqual(queue.map((item) => item.prompt), ['other loop', 'next tick']);

console.log('queue tests passed');
