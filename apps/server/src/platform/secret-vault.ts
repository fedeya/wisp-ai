import { Context, Effect, Layer, Redacted, Schema, Stream } from 'effect';
import type { Duration } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { AppConfig } from '../app-config.ts';

/** The most output a helper may print before the call fails, in decoded characters. */
const MAX_OUTPUT = 1024 * 1024;

export class SecretVaultError extends Schema.TaggedError<SecretVaultError>()('SecretVaultError', {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/**
 * Secrets kept in the operating system's credential storage. The desktop
 * executable runs as the helper: `<exe> --secret read|write <key>`, with the
 * value on stdin for a write and on stdout for a read.
 */
export class SecretVault extends Context.Service<
  SecretVault,
  {
    /** The stored value, or an empty one when the key has none. */
    read(key: string): Effect.Effect<Redacted.Redacted<string>, SecretVaultError>;
    /** Stores the value; an empty value removes the key. */
    write(key: string, value: Redacted.Redacted<string>): Effect.Effect<void, SecretVaultError>;
  }
>()('@wisp/server/SecretVault') {}

/**
 * The Promise interface the consumers that are not migrated yet take.
 * `runtime.ts` adapts `SecretVault` to it; remove it when they migrate.
 */
export interface PromiseSecretVault {
  read(key: string): Promise<string>;
  write(key: string, value: string): Promise<void>;
}

export interface HelperOptions {
  /** The helper's executable followed by any arguments that come before `--secret`. */
  readonly command: readonly [executable: string, ...args: string[]];
  /** How long one call may run before the helper is stopped. */
  readonly timeout?: Duration.Input;
}

const make = Effect.fnUntraced(function* ({ command, timeout = '10 seconds' }: HelperOptions) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const [executable, ...prefix] = command;

  const run = (operation: 'read' | 'write', key: string, input: string) =>
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(executable, [...prefix, '--secret', operation, key], {
          detached: false,
          stderr: 'ignore',
        }),
      );
      // A helper can exit without reading its input, which fails this write
      // with a closed pipe. Its exit code already decides the call.
      yield* Stream.make(new TextEncoder().encode(input)).pipe(
        Stream.run(handle.stdin),
        Effect.ignore,
        Effect.forkScoped,
      );
      const [output, exitCode] = yield* Effect.all(
        [
          handle.stdout.pipe(
            Stream.decodeText(),
            Stream.runFoldEffect(
              () => '',
              (collected, chunk) => {
                const next = collected + chunk;
                return next.length > MAX_OUTPUT
                  ? Effect.fail(new SecretVaultError({ message: 'Secret is too large' }))
                  : Effect.succeed(next);
              },
            ),
          ),
          handle.exitCode,
        ],
        { concurrency: 'unbounded' },
      );
      if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
        return yield* new SecretVaultError({ message: 'Native credential storage failed' });
      }
      return output;
    }).pipe(
      // Closing the scope stops a helper that is still running.
      Effect.scoped,
      Effect.catchTag('PlatformError', (cause) =>
        Effect.fail(new SecretVaultError({ message: 'Native credential storage failed', cause })),
      ),
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () =>
          Effect.fail(new SecretVaultError({ message: 'Native credential storage timed out' })),
      }),
    );

  const read = Effect.fn('SecretVault.read')(function* (key: string) {
    return Redacted.make(yield* run('read', key, ''));
  });

  const write = Effect.fn('SecretVault.write')(function* (
    key: string,
    value: Redacted.Redacted<string>,
  ) {
    yield* run('write', key, Redacted.value(value));
  });

  return SecretVault.of({ read, write });
});

/** A vault that runs the given helper; needs a `ChildProcessSpawner`. */
export const layerHelper = (options: HelperOptions) => Layer.effect(SecretVault, make(options));

/** A vault that runs the desktop executable from `AppConfig` as its helper. */
export const layer = Layer.effect(
  SecretVault,
  Effect.gen(function* () {
    const { paths } = yield* AppConfig;
    return yield* make({ command: [paths.desktopExecutable] });
  }),
);
