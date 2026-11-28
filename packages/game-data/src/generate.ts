// @effect-migrated
// Regenerates Wisp's game data files from Forever's game tables.
//   pnpm data:generate [--refresh] [dataset ...]
// --refresh downloads the tables again instead of using the cache.
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { Console, Effect, FileSystem, Layer, Path } from 'effect';
import { Argument, Command, Flag } from 'effect/cli';
import * as AtlasLoot from './atlasloot.ts';
import * as HttpClient from './http-client.ts';
import { DatasetError, datasets, readPinned, render } from './index.ts';
import * as Wago from './wago.ts';

const generate = Command.make(
  'data:generate',
  {
    refresh: Flag.Boolean('refresh').pipe(
      Flag.withDescription('Download the tables again instead of using the cache'),
      Flag.withDefault(false),
    ),
    names: Argument.String('dataset').pipe(
      Argument.withDescription('Datasets to generate; all when none is given'),
      Argument.variadic(),
    ),
  },
  Effect.fn(function* ({ refresh, names }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* path.fromFileUrl(new URL('../../..', import.meta.url));
    const cacheDir = yield* path.fromFileUrl(new URL('../.cache', import.meta.url));
    const pinned = yield* readPinned;
    const selected = datasets.filter((dataset) => !names.length || names.includes(dataset.name));
    if (names.length && selected.length !== names.length) {
      return yield* new DatasetError({
        message: `Unknown dataset; known: ${datasets.map((dataset) => dataset.name).join(', ')}`,
      });
    }
    const sources = Layer.mergeAll(
      Wago.layer({ build: pinned.build, cacheDir, refresh }),
      AtlasLoot.layer({ pin: pinned.atlasloot, cacheDir, refresh }),
    ).pipe(Layer.provide([HttpClient.layer, NodeCrypto.layerDigest]));
    const write = Effect.fnUntraced(function* (dataset: (typeof selected)[number]) {
      const file = path.join(root, dataset.output.path);
      yield* fs.makeDirectory(path.dirname(file), { recursive: true });
      yield* fs.writeFileString(file, render(dataset, yield* dataset.build, pinned.build));
      yield* Console.log(`${dataset.name}: wrote ${dataset.output.path} for build ${pinned.build}`);
    });
    yield* Effect.forEach(selected, write, { discard: true }).pipe(Effect.provide(sources));
  }),
).pipe(Command.withDescription("Regenerate Wisp's game data files from Forever's game tables"));

generate.pipe(
  Command.run({ version: '1.0.0' }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
