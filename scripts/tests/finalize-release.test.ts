import { expect, it } from '@effect/vitest';
import { ConfigProvider, Effect, Layer, Sink, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { moveNightlyFeed } from '../finalize-release.ts';

interface Reply {
  readonly exitCode: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

/**
 * A spawner that answers every `gh` call with `reply(args)`; `calls` records
 * the arguments it was run with.
 */
function gh(reply: (args: readonly string[]) => Reply) {
  const calls: (readonly string[])[] = [];
  const encoder = new TextEncoder();
  const spawner = ChildProcessSpawner.make((command) => {
    const args = ChildProcess.isStandardCommand(command)
      ? command.args.filter((word) => typeof word === 'string')
      : [];
    calls.push(args);
    const { exitCode, stdout = '', stderr = '' } = reply(args);
    const out = Stream.make(encoder.encode(stdout));
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: out,
        stderr: Stream.make(encoder.encode(stderr)),
        all: out,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      }),
    );
  });
  const layer = Layer.mergeAll(
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    ConfigProvider.layer(ConfigProvider.fromUnknown({ GITHUB_SHA: 'abc123' })),
  );
  return { calls, layer };
}

const subcommands = (calls: readonly (readonly string[])[]) =>
  calls.map((args) => args.slice(0, 3).join(' '));

it.effect('a Nightly with no feed release creates it and uploads the manifest', () =>
  Effect.gen(function* () {
    const fake = gh((args) =>
      args[1] === 'view' ? { exitCode: 1, stderr: 'release not found\n' } : { exitCode: 0 },
    );
    yield* moveNightlyFeed('0.1.0-nightly.5.1').pipe(Effect.provide(fake.layer));
    expect(subcommands(fake.calls)).toEqual([
      'release view nightly',
      'release create nightly',
      'release upload nightly',
    ]);
  }),
);

it.effect('any other failure of gh release view fails without creating a release', () =>
  Effect.gen(function* () {
    const fake = gh(() => ({ exitCode: 1, stderr: 'HTTP 502: Bad Gateway\n' }));
    const error = yield* Effect.flip(
      moveNightlyFeed('0.1.0-nightly.5.1').pipe(Effect.provide(fake.layer)),
    );
    expect(error.message).toContain('HTTP 502: Bad Gateway');
    expect(subcommands(fake.calls)).toEqual(['release view nightly']);
  }),
);

it.effect('JSON that does not decode fails without creating a release', () =>
  Effect.gen(function* () {
    const fake = gh(() => ({ exitCode: 0, stdout: 'not json' }));
    const error = yield* Effect.flip(
      moveNightlyFeed('0.1.0-nightly.5.1').pipe(Effect.provide(fake.layer)),
    );
    expect(error._tag).toBe('SchemaError');
    expect(subcommands(fake.calls)).toEqual(['release view nightly']);
  }),
);

it.effect('an existing feed without a manifest is not recreated, only uploaded to', () =>
  Effect.gen(function* () {
    const fake = gh((args) =>
      args[1] === 'view' ? { exitCode: 0, stdout: '{"assets":[]}' } : { exitCode: 0 },
    );
    yield* moveNightlyFeed('0.1.0-nightly.5.1').pipe(Effect.provide(fake.layer));
    expect(subcommands(fake.calls)).toEqual(['release view nightly', 'release upload nightly']);
  }),
);
