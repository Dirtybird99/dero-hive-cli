import React from 'react';
import { render } from 'ink';
import { initHive, shutdownHive } from '../utils/init.js';
import { App, type TuiLaunchOptions } from './App.js';

export async function startTui(options: TuiLaunchOptions = {}): Promise<void> {
  process.env.HIVE_TUI = '1';
  const alternateScreen = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (alternateScreen) process.stdout.write('\u001B[?1049h\u001B[2J\u001B[H');
  try {
    await initHive();
    const instance = render(<App options={options} />, {
      exitOnCtrlC: false,
      patchConsole: true
    });
    await instance.waitUntilExit();
  } finally {
    await shutdownHive();
    if (alternateScreen) process.stdout.write('\u001B[?1049l');
    delete process.env.HIVE_TUI;
  }
}
