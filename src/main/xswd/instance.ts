import type { XswdManager } from './manager';

let instance: XswdManager | null = null;

export function setXswdManager(m: XswdManager | null): void {
  instance = m;
}

export function getXswdManager(): XswdManager | null {
  return instance;
}
