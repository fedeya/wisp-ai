import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import path from 'node:path';

// Starts the bridge's eval model server (apps/bridge/src/evals/eval-bridge.ts),
// which uses a separate ChatGPT sign-in, and points the agent at it.
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

export async function startModelBridge(fixtures: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [bridgeScript(), 'serve'], {
    env: { ...process.env, ...fixtures },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let errors = '';
  child.stderr.setEncoding('utf8').on('data', (data: string) => (errors += data));
  const closed = new Promise<void>((resolve) => {
    child.once('close', () => resolve());
  });
  const close = async () => {
    child.kill();
    await closed;
  };
  const lines = createInterface({ input: child.stdout });
  try {
    const first = await new Promise<string>((resolve, reject) => {
      lines.once('line', resolve);
      child.once('error', reject);
      child.once('close', (code) =>
        reject(new Error((errors.trim() || 'Eval bridge exited') + ' (code ' + code + ')')),
      );
    });
    const { url, token, model } = JSON.parse(first) as {
      url: string;
      token: string;
      model: string;
    };
    return { url, token, model, close };
  } catch (error) {
    await close();
    throw error;
  } finally {
    lines.close();
  }
}
