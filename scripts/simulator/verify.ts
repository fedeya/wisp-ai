// @effect-migrated
// Checks the simulator binary against its pinned manifest, and its metadata
// against the class adapters, before it is cached or packaged.
//   node scripts/simulator/verify.ts   checks the checkout in the working directory
import { createHash } from 'node:crypto';
import { Effect, FileSystem, Path, Schema } from 'effect';
import { Command } from 'effect/cli';
import { adapters } from '../../apps/server/src/integrations/simulation/adapters/index.ts';
import { runScript } from '../run-script.ts';

export class SimulatorMismatch extends Schema.TaggedError<SimulatorMismatch>()(
  'SimulatorMismatch',
  { message: Schema.String },
) {}

const Manifest = Schema.fromJsonString(
  Schema.Struct({
    commit: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)),
    sha256: Schema.String,
    supportedClasses: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
);
const Items = Schema.fromJsonString(Schema.Array(Schema.Unknown));
const Classes = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const ClassMetadata = Schema.Struct({
  talents: Schema.Array(
    Schema.Array(Schema.Struct({ row: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) })),
  ).check(Schema.isBetweenLength(3, 3)),
  ranks: Schema.Record(Schema.String, Schema.Unknown),
});
const isClassMetadata = Schema.is(ClassMetadata);
const isRanked = Schema.is(Schema.NonEmptyArray(Schema.Unknown));

const mismatch = (message: string) => () => new SimulatorMismatch({ message });

/** Fails unless the simulator in `root`'s simulator folder matches its pinned manifest and the adapters. */
export const verifySimulator = Effect.fnUntraced(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(root, 'simulator');
  const pinned = mismatch('Simulator binary does not match its pinned manifest.');
  const manifestText = yield* fs.readFileString(path.join(directory, 'manifest.json'));
  const binary = yield* fs.readFile(path.join(directory, 'wowsimcli.exe'));
  const manifest = yield* Schema.decodeEffect(Manifest)(manifestText).pipe(Effect.mapError(pinned));
  if (!binary.length || createHash('sha256').update(binary).digest('hex') !== manifest.sha256) {
    return yield* pinned();
  }
  yield* Schema.decodeEffect(Items)(
    yield* fs.readFileString(path.join(directory, 'items.json')),
  ).pipe(Effect.mapError(mismatch('Invalid simulator metadata: items.json')));
  const classes = yield* Schema.decodeEffect(Classes)(
    yield* fs.readFileString(path.join(directory, 'classes.json')),
  ).pipe(Effect.mapError(mismatch('Invalid simulator metadata: classes.json')));
  for (const adapter of Object.values(adapters)) {
    const metadata = classes[adapter.token];
    if (
      !manifest.supportedClasses?.includes(adapter.token) ||
      !isClassMetadata(metadata) ||
      !adapter.families.every((family) => isRanked(metadata.ranks[family]))
    ) {
      return yield* new SimulatorMismatch({
        message: 'Invalid simulator class metadata: ' + adapter.token,
      });
    }
  }
});

if (import.meta.main) {
  Command.make(
    'verify',
    {},
    Effect.fn(function* () {
      const path = yield* Path.Path;
      yield* verifySimulator(path.resolve());
    }),
  ).pipe(
    Command.withDescription('Check the simulator binary and metadata in the working directory'),
    Command.run({ version: '1.0.0' }),
    runScript,
  );
}
