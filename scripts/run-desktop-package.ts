import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function desktopPackageTask(platform: NodeJS.Platform, requested?: string) {
  const host = platform === 'linux' ? 'linux' : platform === 'win32' ? 'windows' : '';
  const target = requested || host;
  if (target !== 'linux' && target !== 'windows') {
    throw Error('Desktop packaging supports Windows and Linux.');
  }
  if (target === 'linux' && platform !== 'linux') {
    throw Error('package:linux runs on Linux.');
  }
  if (target === 'windows' && platform !== 'win32') {
    throw Error('package:windows runs on Windows.');
  }
  return target === 'linux' ? 'package:linux' : 'package:windows';
}

const invoked =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invoked) {
  const task = desktopPackageTask(process.platform, process.argv[2]);
  const require = createRequire(import.meta.url);
  const turbo = path.join(path.dirname(require.resolve('turbo/package.json')), 'bin/turbo');
  const result = spawnSync(process.execPath, [turbo, 'run', task, '--filter=@wisp/desktop'], {
    stdio: 'inherit',
  });
  process.exit(result.status ?? 1);
}
