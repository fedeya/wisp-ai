// @effect-migrated
import { Context, Effect, Layer, Path, Schema } from 'effect';
import { AppConfig } from '#/platform/config';
import * as JsonFile from '#/platform/json-file';

const PackageMetadata = Schema.Struct({ version: Schema.String.check(Schema.isMinLength(1)) });

/** The version of the running Wisp, read once when the layer is built. */
export class AppVersion extends Context.Service<
  AppVersion,
  {
    /** `version` from `package.json` at the resource root, or `unknown` when it cannot be read. */
    readonly version: string;
  }
>()('@wisp/server/AppVersion') {}

/** Reads `package.json` at the resource root from `AppConfig`. */
export const layer = Layer.effect(
  AppVersion,
  Effect.gen(function* () {
    const { paths } = yield* AppConfig;
    const path = yield* Path.Path;
    const version = yield* JsonFile.read(
      path.join(paths.root, 'package.json'),
      PackageMetadata,
      () => ({ version: 'unknown' }),
    ).pipe(
      Effect.map((metadata) => metadata.version),
      Effect.orElseSucceed(() => 'unknown'),
    );
    return AppVersion.of({ version });
  }),
);
