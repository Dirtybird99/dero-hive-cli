import type { MediaManager } from './manager';

// Shared handle to the single MediaManager created at startup, so code outside
// the main entrypoint (e.g. builtin tools) can trigger generation.
let instance: MediaManager | null = null;

export function setMediaManager(m: MediaManager | null): void {
  instance = m;
}

export function getMediaManager(): MediaManager | null {
  return instance;
}
