import type { SimulatorManager } from './manager';

let instance: SimulatorManager | null = null;

export function setSimulatorManager(m: SimulatorManager | null): void {
  instance = m;
}

export function getSimulatorManager(): SimulatorManager | null {
  return instance;
}
