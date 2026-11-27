// Prints the Effect migration patterns each given file still contains:
// `pnpm --filter @wisp/tests effect:audit <files...>`, with paths relative to
// the repository root.
import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { Console, Effect, FileSystem, Path, Runtime, Schema } from 'effect';
import { Argument, Command } from 'effect/cli';
import { countFile, presentPatterns, repositoryRoot } from './effect-migration.ts';

/** The audit has already printed why it failed, so only the exit code is left. */
class AuditFailed extends Schema.TaggedError<AuditFailed>()('AuditFailed', {}) {
  readonly [Runtime.errorReported] = false;
}

const audit = Command.make(
  'effect:audit',
  {
    files: Argument.String('files').pipe(
      Argument.withDescription('Files to audit, relative to the repository root'),
      Argument.variadic(),
    ),
  },
  Effect.fn(function* ({ files }) {
    if (files.length === 0) {
      yield* Console.error('Usage: pnpm --filter @wisp/tests effect:audit <files...>');
      return yield* new AuditFailed();
    }
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* repositoryRoot;
    let missing = false;
    for (const file of files) {
      const source = path.resolve(root, file);
      if (!(yield* fs.exists(source))) {
        yield* Console.log(`${file}: not found`);
        missing = true;
        continue;
      }
      const present = presentPatterns(yield* countFile(source));
      const summary =
        present.length === 0
          ? 'clean'
          : present.map(({ pattern, count }) => `${pattern} ${count}`).join(', ');
      yield* Console.log(`${file}: ${summary}`);
    }
    if (missing) {
      return yield* new AuditFailed();
    }
  }),
).pipe(Command.withDescription('Print the Effect migration patterns each file still contains'));

audit.pipe(
  Command.run({ version: '1.0.0' }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
