import { access } from 'node:fs/promises';
import path from 'node:path';

export async function findNpmDirectory() {
  for (const relative of [
    'npm',
    'node_modules/npm',
    '../node_modules/npm',
    '../lib/node_modules/npm',
  ]) {
    const candidate = path.resolve(path.dirname(process.execPath), relative);
    try {
      await access(path.join(candidate, 'bin/npx-cli.js'));
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
  throw Error('Cannot locate npm in the build Node distribution.');
}
