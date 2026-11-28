// @effect-migrated
import { Context, Effect, Layer, Option, Ref, Schema, SchemaGetter, Semaphore } from 'effect';
import type { FileSystem, Path } from 'effect';
import type { PlatformError } from 'effect/PlatformError';
import type { SecureRandom } from 'effect/crypto';
import { featureOverrides } from '@wisp/protocol/features';
import * as JsonFile from '#/platform/json-file';
import { AppConfig } from '../app-config.ts';

const Filled = Schema.String.check(Schema.isMinLength(1));

/** `config.local.json`: the choices the bridge keeps between runs. */
export const SettingsFile = Schema.Struct({
  /** The WoW folder the addon transport uses. */
  wow: Schema.optional(Filled),
  /** The default model. Earlier installers saved an empty string before one was chosen. */
  model: Schema.optional(Schema.String).pipe(
    Schema.decodeTo(Schema.optional(Filled), {
      decode: SchemaGetter.transformOptional(Option.filter((model) => model !== '')),
      encode: SchemaGetter.passthrough(),
    }),
  ),
  /** The MCP configuration file, relative to the data folder. */
  mcpConfig: Schema.optional(Filled),
  /** The player's feature flag choices. A bad entry drops them instead of the whole file. */
  features: Schema.optional(featureOverrides).pipe(Schema.catchDecoding(() => Effect.succeedNone)),
});
export type SettingsValues = typeof SettingsFile.Type;

/**
 * How the file is written: the saved object as it is, so its keys keep the
 * order they were first saved in. Encoding with `SettingsFile`, which changes
 * no value, would put them in its field order instead.
 */
const SavedObject = Schema.Record(Schema.String, Schema.Unknown);

export class Settings extends Context.Service<
  Settings,
  {
    /** The settings as last saved. */
    readonly get: Effect.Effect<SettingsValues>;
    /**
     * Merges `patch` into the saved settings and returns them. Writes run one
     * at a time in call order, and `get` reflects a patch once its write has
     * succeeded; a failed write leaves the settings as they were.
     */
    readonly update: (
      patch: Partial<SettingsValues>,
    ) => Effect.Effect<SettingsValues, PlatformError | Schema.SchemaError>;
  }
>()('@wisp/server/settings/Settings') {}

const make = Effect.fn('Settings.make')(function* (file: string) {
  const services = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | SecureRandom.SecureRandom
  >();
  const saved = yield* Ref.make(yield* JsonFile.read(file, SettingsFile, () => ({})));
  const writes = yield* Semaphore.make(1);

  const update = Effect.fn('Settings.update')(
    function* (patch: Partial<SettingsValues>) {
      const next = { ...(yield* Ref.get(saved)), ...patch };
      yield* JsonFile.write(file, SavedObject, next);
      yield* Ref.set(saved, next);
      return next;
    },
    // Once a write starts, the file and `get` change together.
    Effect.uninterruptible,
    (effect) => writes.withPermit(effect),
    Effect.provideContext(services),
  );

  return Settings.of({ get: Ref.get(saved), update });
});

/**
 * Settings kept in `file`, read when the layer is built. A missing file reads
 * as no settings; one that does not decode fails with a `JsonFileError`.
 */
export const layerAt = (file: string) => Layer.effect(Settings, make(file));

/** Settings kept in `config.local.json` in the data folder from `AppConfig`. */
export const layer = Layer.effect(
  Settings,
  Effect.gen(function* () {
    const { paths } = yield* AppConfig;
    return yield* make(paths.config);
  }),
);
