import { type Context, Effect } from 'effect';
import type { ChildProcessSpawner } from 'effect/process';
import { processServices, runProcess } from '../process.ts';

export interface SecretVault {
  read(key: string): Promise<string>;
  write(key: string, value: string): Promise<void>;
}

const MESSAGES = {
  timeout: 'Native credential storage timed out',
  output: 'Secret is too large',
  exit: 'Native credential storage failed',
} as const;

/**
 * Secrets in the desktop helper's per-user encrypted storage: each call runs
 * `<desktop> --secret <read|write> <key>` with the value on stdin.
 */
export class NativeVault implements SecretVault {
  executable: string;
  private services: Context.Context<ChildProcessSpawner.ChildProcessSpawner>;
  constructor(
    executable: string,
    services: Context.Context<ChildProcessSpawner.ChildProcessSpawner> = processServices(),
  ) {
    this.executable = executable;
    this.services = services;
  }
  private run(operation: string, key: string, input = '') {
    return Effect.runPromiseWith(this.services)(
      runProcess(this.executable, ['--secret', operation, key], {
        input,
        timeout: '10 seconds',
        maxOutputBytes: 1024 * 1024,
      }).pipe(
        // A helper that could not start keeps Node's error; the others say what failed.
        Effect.mapError((error) =>
          error.reason === 'spawn' ? error.cause : Error(MESSAGES[error.reason]),
        ),
      ),
    );
  }
  read(key: string) {
    return this.run('read', key);
  }
  async write(key: string, value: string) {
    await this.run('write', key, value);
  }
}
