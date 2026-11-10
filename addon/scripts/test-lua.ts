import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

export function runLuaSpecs(paths: string[] = ['addon/tests']) {
  const lua = resolve(root, 'runtime/lua/bin', process.platform === 'win32' ? 'lua.exe' : 'lua');
  if (!existsSync(lua)) {
    throw new Error('Lua test runtime missing. Run: python scripts/setup-lua.py');
  }
  const result = spawnSync(
    lua,
    ['addon/tests/run.lua', '--verbose', '--output=plainTerminal', ...paths],
    {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stdout + result.stderr);
  }
  return result.stdout;
}

if (import.meta.main) {
  process.stdout.write(
    runLuaSpecs(process.argv.slice(2).length ? process.argv.slice(2) : undefined),
  );
}
