import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export function prepareNpmGlobalPrefix(prefix, targetPlatform = process.platform) {
  return mkdir(targetPlatform === 'win32' ? prefix : join(prefix, 'lib'), { recursive: true });
}
