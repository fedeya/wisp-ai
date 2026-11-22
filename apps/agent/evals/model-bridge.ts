import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import path from 'node:path';

// Starts the bridge's eval model server (apps/bridge/src/evals/eval-bridge.ts),
// which uses a separate ChatGPT sign-in, and points the agent at it.
// Eve bundles eval config, so find the repository from the working directory.
function bridgeScript() {
  for (let dir = process.cwd(); ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
      return path.join(dir, 'apps', 'bridge', 'src', 'evals', 'eval-bridge.ts');
    }
    if (path.dirname(dir) === dir) {
      throw new Error('Run evals from inside the Wisp repository.');
    }
  }
}

export async function startModelBridge() {
  const child: ChildProcess = spawn(process.execPath, [bridgeScript(), 'serve'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let errors = '';
  child.stderr!.setEncoding('utf8').on('data', (data: string) => (errors += data));
  const first = await new Promise<string>((resolve, reject) => {
    const lines = createInterface({ input: child.stdout! });
    lines.once('line', resolve);
    child.once('exit', (code) =>
      reject(new Error((errors.trim() || 'Eval bridge exited') + ' (code ' + code + ')')),
    );
  });
  const { url, token, model } = JSON.parse(first) as { url: string; token: string; model: string };
  process.env.WOW_BRIDGE_URL = url;
  process.env.WOW_BRIDGE_TOKEN = token;
  return {
    model,
    close: async () => {
      if (child.exitCode === null) {
        child.kill();
      }
    },
  };
}
