import type { Message } from '../../../src/shared/types.js';

export interface QueueItem {
  prompt: string;
  content?: Message['content'];
  systemAddon?: string;
  loopId?: string;
}

/** Keep recurring work bounded while a slow turn is still running. */
export function enqueueLoopTick(queue: QueueItem[], item: QueueItem & { loopId: string }): boolean {
  if (queue.some((queued) => queued.loopId === item.loopId)) return false;
  queue.push(item);
  return true;
}
