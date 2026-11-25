import * as NodeChildProcessSpawner from '@effect/platform-node/NodeChildProcessSpawner';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { type Context, type Duration, Effect, Layer, Schema, Scope, Stream } from 'effect';
import { ChildProcess, type ChildProcessSpawner } from 'effect/process';

/** Spawns helper processes with Node's child_process. */
export const ProcessLayer = NodeChildProcessSpawner.layer.pipe(
  Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
);

let localServices: Context.Context<ChildProcessSpawner.ChildProcessSpawner> | undefined;
/** ProcessLayer built once, for code that runs outside the bridge program (tests, tools). */
export function processServices() {
  return (localServices ??= Effect.runSync(Layer.buildWithScope(ProcessLayer, Scope.makeUnsafe())));
}

/** A helper process that could not start, failed, timed out or wrote too much. */
export class ProcessFailed extends Schema.TaggedError<ProcessFailed>()('ProcessFailed', {
  reason: Schema.Literals(['spawn', 'exit', 'timeout', 'output']),
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface ProcessOptions {
  /** Written to stdin, which is then closed. */
  input?: string;
  timeout: Duration.Input;
  maxOutputBytes: number;
}

/**
 * Runs `command` with `args` until it exits and returns its stdout as UTF-8.
 * It fails unless the process exits 0 within `timeout` and writes at most
 * `maxOutputBytes`; the process is killed when it fails or is interrupted.
 * The child inherits this process's environment and gets no console window.
 */
export const runProcess = Effect.fn('runProcess')(
  function* (command: string, args: ReadonlyArray<string>, options: ProcessOptions) {
    const handle = yield* ChildProcess.make(command, args, {
      extendEnv: true,
      windowsHide: true,
      stdin: Stream.make(new TextEncoder().encode(options.input ?? '')),
      stderr: 'ignore',
    }).pipe(Effect.mapError((cause) => new ProcessFailed({ reason: 'spawn', cause })));
    const chunks: Uint8Array[] = [];
    let size = 0;
    const [, exitCode] = yield* Effect.all(
      [
        Stream.runForEach(handle.stdout, (chunk) => {
          size += chunk.length;
          if (size > options.maxOutputBytes) {
            return Effect.fail(new ProcessFailed({ reason: 'output' }));
          }
          chunks.push(chunk);
          return Effect.void;
        }),
        handle.exitCode,
      ],
      { concurrency: 'unbounded' },
    ).pipe(
      Effect.mapError((cause) =>
        cause instanceof ProcessFailed ? cause : new ProcessFailed({ reason: 'exit', cause }),
      ),
    );
    if (exitCode !== 0) {
      return yield* new ProcessFailed({ reason: 'exit' });
    }
    return Buffer.concat(chunks).toString('utf8');
  },
  Effect.scoped,
  (effect, _command, _args, options) =>
    effect.pipe(
      Effect.timeoutOrElse({
        duration: options.timeout,
        orElse: () => Effect.fail(new ProcessFailed({ reason: 'timeout' })),
      }),
    ),
);
