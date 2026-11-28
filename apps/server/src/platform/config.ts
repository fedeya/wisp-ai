// @effect-migrated
import * as NodePath from '@effect/platform-node/NodePath';
import { Config, Context, Effect, FileSystem, Layer, Option, Path, Schedule } from 'effect';
import type { PlatformError } from 'effect/PlatformError';

export interface AppPaths {
  /** Application resources: the repository in source runs, the payload when installed. */
  readonly root: string;
  /** User data: `WISP_DATA_DIR` when set, otherwise the resource root. */
  readonly dataRoot: string;
  readonly runtime: string;
  readonly config: string;
  /**
   * Where earlier versions kept the Eve engine: a copy of the agent and its
   * session store. Only a separate data folder ever held one.
   */
  readonly legacyEngine: string | undefined;
  readonly simulatorExecutable: string;
  readonly desktopExecutable: string;
}

/** The server's configuration, read once from the `WISP_*` variables the native host sets. */
export class AppConfig extends Context.Service<
  AppConfig,
  {
    readonly paths: AppPaths;
    /** A release build of the native host; selects the feature channel. */
    readonly releaseBuild: boolean;
    /** Usage telemetry reports to the release project. */
    readonly telemetryRelease: boolean;
    /** Desktop connects the WoW transport itself once its window is ready. */
    readonly deferWowTransport: boolean;
  }
>()('@wisp/server/AppConfig') {}

/** A flag the native host turns on with `1`; any other value or none is off. */
const flag = (name: string) =>
  Config.String(name).pipe(
    Config.map((value) => value === '1'),
    Config.withDefault(false),
  );

/** Reads the configuration from the current `ConfigProvider` (the environment by default). */
export const layer = Layer.effect(
  AppConfig,
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const root = yield* Config.String('WISP_RESOURCE_ROOT').pipe(
      Config.option,
      Effect.flatMap(
        Option.match({
          onSome: Effect.succeed,
          onNone: () =>
            path.fromFileUrl(new URL('../../../../', import.meta.url)).pipe(Effect.orDie),
        }),
      ),
    );
    const data = yield* Config.option(Config.String('WISP_DATA_DIR'));
    const desktopExecutable = yield* Config.option(Config.String('WISP_DESKTOP_EXE'));
    const dataRoot = Option.match(data, { onNone: () => root, onSome: (d) => path.resolve(d) });
    return AppConfig.of({
      paths: {
        root,
        dataRoot,
        runtime: path.join(dataRoot, 'runtime'),
        config: path.join(dataRoot, 'config.local.json'),
        legacyEngine: Option.isSome(data) ? path.join(dataRoot, 'engine') : undefined,
        simulatorExecutable: path.join(root, 'simulator', 'wowsimcli.exe'),
        desktopExecutable: Option.getOrElse(desktopExecutable, () =>
          path.join(
            root,
            'apps',
            'desktop',
            'src-tauri',
            'target',
            'release',
            process.platform === 'win32' ? 'wisp.exe' : 'wisp',
          ),
        ),
      },
      releaseBuild: yield* flag('WISP_RELEASE_BUILD'),
      telemetryRelease: yield* flag('WISP_TELEMETRY_RELEASE'),
      deferWowTransport: yield* flag('WISP_DEFER_WOW_TRANSPORT'),
    });
  }),
).pipe(Layer.provide(NodePath.layer));

/** Failures Node's `rm` retried before: a file held open (Windows) or a folder still emptying. */
const transientFailures = new Set(['Busy', 'PermissionDenied', 'Unknown']);
const isTransient = (error: PlatformError) => transientFailures.has(error.reason._tag);

/**
 * Removes the Eve engine folder left by earlier versions. The agent now runs in
 * the bridge and keeps its history next to the conversations, so the old
 * sessions there can no longer be resumed.
 */
export const retireLegacyEngine = Effect.fn('AppConfig.retireLegacyEngine')(function* (
  directory: string | undefined,
) {
  const path = yield* Path.Path;
  if (!directory || path.basename(directory) !== 'engine') return;
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(directory, { recursive: true, force: true }).pipe(
    Effect.retry({
      times: 3,
      schedule: Schedule.spaced('100 millis'),
      while: isTransient,
    }),
  );
});
