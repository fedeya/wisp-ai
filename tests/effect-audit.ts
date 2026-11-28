// Prints the Effect migration patterns and unchecked-type lint findings each
// given file still contains: `pnpm --filter @wisp/tests effect:audit <files...>`,
// with paths relative to the repository root.
import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { Console, Effect, FileSystem, Path, Runtime, Schema } from 'effect';
import { Argument, Command } from 'effect/cli';
import { countFile, lintFindings, presentPatterns, repositoryRoot } from './effect-migration.ts';

/** The audit has already printed why it failed, so only the exit code is left. */
class AuditFailed extends Schema.TaggedError<AuditFailed>()('AuditFailed', {}) {
  override readonly [Runtime.errorReported] = false;
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
    const relative = (file: string) =>
      path.relative(root, path.resolve(root, file)).split(path.sep).join('/');
    const existing: string[] = [];
    for (const file of files) {
      if (yield* fs.exists(path.resolve(root, file))) {
        existing.push(relative(file));
      }
    }
    const findings = yield* lintFindings(existing);
    let missing = false;
    for (const file of files) {
      const source = path.resolve(root, file);
      if (!(yield* fs.exists(source))) {
        yield* Console.log(`${file}: not found`);
        missing = true;
        continue;
      }
      const rules = new Map<string, number>();
      for (const finding of findings) {
        if (finding.file === relative(file)) {
          rules.set(finding.rule, (rules.get(finding.rule) ?? 0) + 1);
        }
      }
      const present = [
        ...presentPatterns(yield* countFile(source)).map(
          ({ pattern, count }) => `${pattern} ${count}`,
        ),
        ...Array.from(rules, ([rule, count]) => `${rule} ${count}`),
      ];
      yield* Console.log(`${file}: ${present.length === 0 ? 'clean' : present.join(', ')}`);
    }
    if (missing) {
      return yield* new AuditFailed();
    }
  }),
).pipe(
  Command.withDescription(
    'Print the Effect migration patterns and lint findings each file still contains',
  ),
);

audit.pipe(
  Command.run({ version: '1.0.0' }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
