import { spawn, execFile, type ChildProcess } from 'node:child_process';
import path from 'node:path';

interface EveProcessOptions {
  root: string;
  logFile: number;
  environment: NodeJS.ProcessEnv;
  onError: (error: Error) => void;
  onExit: (code: number | null) => void;
  port?: number;
}

export function startEveProcess(options: EveProcessOptions): ChildProcess {
  const child = spawn(
    options.environment.WISP_ENGINE_EXECUTABLE || process.execPath,
    options.environment.WISP_ENGINE_EXECUTABLE
      ? ['--eve', String(options.port ?? 43186)]
      : [
          path.join(options.root, 'node_modules', 'eve', 'bin', 'eve.js'),
          'dev',
          '--no-ui',
          '--no-default-extensions',
          '--resume',
          '--port',
          String(options.port ?? 43186),
        ],
    {
      cwd: options.root,
      windowsHide: true,
      stdio: ['ignore', options.logFile, options.logFile],
      env: options.environment,
    },
  );
  child.on('error', options.onError);
  child.on('exit', options.onExit);
  return child;
}

// Eve owns child processes too; terminate the whole tree on Windows.
export async function stopEveProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }
  if (process.platform !== 'win32' || !child.pid) {
    child.kill();
    return;
  }
  await new Promise<void>((resolve) => {
    execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {
      resolve();
    });
  });
}
