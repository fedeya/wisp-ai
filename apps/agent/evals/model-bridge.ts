import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

// Starts the bridge's eval model server (apps/bridge/src/evals/eval-bridge.ts),
// which uses a separate ChatGPT sign-in, and points the agent at it.
const script = fileURLToPath(new URL('../../bridge/src/evals/eval-bridge.ts', import.meta.url));

export async function startModelBridge() {
  const child: ChildProcess = spawn(process.execPath, [script, 'serve'], {
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
