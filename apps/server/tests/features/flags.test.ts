import { assert, describe, it } from '@effect/vitest';
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import { OpenFeature } from '@openfeature/web-sdk';
import { ConfigProvider, Context, Effect, Exit, Layer, Queue, Ref, Stream } from 'effect';
import * as PlatformError from 'effect/PlatformError';
import type { FeatureChannel, FeatureOverrides, FeatureRegistry } from '@wisp/protocol/features';
import * as AppConfig from '#/platform/config';
import { AppVersion } from '#/platform/app-version';
import { Settings } from '#/settings';
import type { SettingsValues } from '#/settings';
import { Features, make } from '../../src/features/flags.ts';
import type { FeatureValues } from '../../src/features/flags.ts';

const registry: FeatureRegistry = {
  new_panel: {
    name: 'New panel',
    description: 'A new panel.',
    channels: ['development', 'nightly'],
  },
  dev_only: { name: 'Dev only', description: 'Only while building it.', channels: ['development'] },
};

/** What the features saved through `Settings`, and a switch that fails the next save. */
class Saves extends Context.Service<
  Saves,
  {
    readonly overrides: Ref.Ref<readonly (FeatureOverrides | undefined)[]>;
    readonly failNext: Ref.Ref<boolean>;
  }
>()('@wisp/server/tests/features/Saves') {}

/** Settings in memory that start as `initial`; each save yields first, as a file write would. */
const settingsFrom = (initial: SettingsValues) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const current = yield* Ref.make(initial);
      const overrides = yield* Ref.make<readonly (FeatureOverrides | undefined)[]>([]);
      const failNext = yield* Ref.make(false);
      const settings = Settings.of({
        get: Ref.get(current),
        update: (patch) =>
          Effect.gen(function* () {
            yield* Effect.yieldNow;
            if (yield* Ref.getAndSet(failNext, false)) {
              return yield* PlatformError.systemError({
                _tag: 'Unknown',
                module: 'FileSystem',
                method: 'writeFile',
                pathOrDescriptor: 'config.local.json',
                cause: Error('disk full'),
              });
            }
            yield* Ref.update(overrides, (all) => [...all, patch.features]);
            return yield* Ref.updateAndGet(current, (saved) => ({ ...saved, ...patch }));
          }),
      });
      return Context.make(Settings, settings).pipe(Context.add(Saves, { overrides, failNext }));
    }),
  );

const builds: Record<FeatureChannel, { version: string; releaseBuild: boolean }> = {
  development: { version: '0.4.1', releaseBuild: false },
  nightly: { version: '0.4.1-nightly.120.1', releaseBuild: true },
  stable: { version: '0.4.0', releaseBuild: true },
};

/** `Features` of the registry above for a build of `channel`, on settings that start as `saved`. */
const environment = ({
  channel = 'nightly',
  saved = {},
}: { channel?: FeatureChannel; saved?: SettingsValues } = {}) => {
  const { version, releaseBuild } = builds[channel];
  const app = Layer.merge(
    Layer.succeed(AppVersion, AppVersion.of({ version })),
    AppConfig.layer.pipe(
      Layer.provide(
        Layer.succeed(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnv({ env: releaseBuild ? { WISP_RELEASE_BUILD: '1' } : {} }),
        ),
      ),
    ),
  );
  const settings = settingsFrom(saved);
  return Layer.mergeAll(
    settings,
    Layer.effect(Features, make(registry)).pipe(
      Layer.provide([app, settings, NodeCrypto.layerSecureRandom]),
    ),
  );
};

/** The values `changes` emits, from now on. */
const watchChanges = Effect.gen(function* () {
  const features = yield* Features;
  const emitted = yield* Queue.unbounded<FeatureValues>();
  yield* features.changes.pipe(
    Stream.runForEach((values) => Queue.offer(emitted, values)),
    Effect.forkScoped({ startImmediately: true }),
  );
  return emitted;
});

/** What a build of `channel` reads. */
const readFlags = (channel: FeatureChannel) =>
  Effect.flatMap(Features, (features) =>
    Effect.all({
      channel: Effect.succeed(features.channel),
      values: features.values,
      names: features.enabledNames,
      askWisp: features.enabled('ask_wisp_moments'),
    }),
  ).pipe(Effect.provide(environment({ channel })));

/** Features on settings that start as `saved`, open until the test ends. */
const openFeatures = (saved: SettingsValues) =>
  Effect.map(Layer.build(environment({ saved })), Context.get(Features));

const savedOverrides = Effect.flatMap(Saves, ({ overrides }) => Ref.get(overrides));

describe('Features', () => {
  it.effect('values follow the channel', () =>
    Effect.gen(function* () {
      const nightly = yield* readFlags('nightly');
      assert.strictEqual(nightly.channel, 'nightly');
      assert.deepStrictEqual(nightly.values, { new_panel: true, dev_only: false });
      assert.deepStrictEqual(nightly.names, ['new_panel']);
      // A flag outside this registry reads as off.
      assert.isFalse(nightly.askWisp);
      assert.deepStrictEqual((yield* readFlags('stable')).values, {
        new_panel: false,
        dev_only: false,
      });
      assert.deepStrictEqual((yield* readFlags('development')).names, ['dev_only', 'new_panel']);
    }),
  );

  it.effect('state reports each flag with its channel default and override', () =>
    Effect.gen(function* () {
      const features = yield* Features;
      assert.deepStrictEqual(yield* features.state, {
        channel: 'nightly',
        flags: [
          {
            id: 'new_panel',
            name: 'New panel',
            description: 'A new panel.',
            enabled: false,
            channelDefault: true,
            override: false,
          },
          {
            id: 'dev_only',
            name: 'Dev only',
            description: 'Only while building it.',
            enabled: false,
            channelDefault: false,
            override: null,
          },
        ],
      });
    }).pipe(Effect.provide(environment({ saved: { features: { new_panel: false } } }))),
  );

  it.effect('a saved override applies after it is written and is published', () =>
    Effect.gen(function* () {
      const features = yield* Features;
      const changes = yield* watchChanges;
      yield* features.set('new_panel', true);
      assert.deepStrictEqual(yield* savedOverrides, [{ new_panel: true }]);
      assert.isTrue((yield* features.values)['new_panel']);
      assert.deepStrictEqual(yield* Queue.take(changes), { new_panel: true, dev_only: false });
      yield* features.set('new_panel', null);
      assert.deepStrictEqual((yield* savedOverrides).at(-1), {});
      assert.isFalse((yield* features.values)['new_panel']);
      assert.deepStrictEqual(yield* Queue.take(changes), { new_panel: false, dev_only: false });
    }).pipe(Effect.provide(environment({ channel: 'stable' }))),
  );

  it.effect('saving the same choice again publishes nothing', () =>
    Effect.gen(function* () {
      const features = yield* Features;
      const changes = yield* watchChanges;
      yield* features.set('new_panel', true);
      yield* features.set('new_panel', true);
      yield* features.set('dev_only', true);
      assert.strictEqual((yield* savedOverrides).length, 3);
      assert.deepStrictEqual(yield* Queue.take(changes), { new_panel: true, dev_only: false });
      assert.deepStrictEqual(yield* Queue.take(changes), { new_panel: true, dev_only: true });
    }).pipe(Effect.provide(environment({ channel: 'stable' }))),
  );

  it.effect('a failed write keeps the previous value', () =>
    Effect.gen(function* () {
      const features = yield* Features;
      const changes = yield* watchChanges;
      yield* Effect.flatMap(Saves, ({ failNext }) => Ref.set(failNext, true));
      const failed = yield* features.set('new_panel', false).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(failed));
      assert.isTrue((yield* features.values)['new_panel']);
      assert.deepStrictEqual((yield* features.state).flags[0]?.override, null);
      yield* features.set('dev_only', true);
      // The failed write published nothing: the next change is the one that saved.
      assert.deepStrictEqual(yield* Queue.take(changes), { new_panel: true, dev_only: true });
    }).pipe(Effect.provide(environment())),
  );

  it.effect('unknown flags are refused and removed flags drop out of saved overrides', () =>
    Effect.gen(function* () {
      const features = yield* Features;
      const refused = yield* features.set('removed_flag', true).pipe(Effect.flip);
      assert.strictEqual(refused._tag, 'UnknownFeatureFlag');
      assert.strictEqual(refused.message, 'Unknown feature flag.');
      yield* features.set('dev_only', true);
      assert.deepStrictEqual(yield* savedOverrides, [{ dev_only: true }]);
    }).pipe(Effect.provide(environment({ saved: { features: { removed_flag: true } } }))),
  );

  it.effect('saves run one at a time, so concurrent choices all stay', () =>
    Effect.gen(function* () {
      const features = yield* Features;
      yield* Effect.all([features.set('new_panel', false), features.set('dev_only', true)], {
        concurrency: 'unbounded',
      });
      assert.deepStrictEqual(yield* savedOverrides, [
        { new_panel: false },
        { new_panel: false, dev_only: true },
      ]);
      assert.deepStrictEqual(yield* features.values, { new_panel: false, dev_only: true });
    }).pipe(Effect.provide(environment())),
  );

  it.effect('bridges in one process keep their own overrides', () =>
    Effect.gen(function* () {
      const first = yield* openFeatures({});
      const second = yield* openFeatures({ features: { new_panel: false } });
      yield* first.set('dev_only', true);
      assert.deepStrictEqual(yield* first.values, { new_panel: true, dev_only: true });
      assert.deepStrictEqual(yield* second.values, { new_panel: false, dev_only: false });
      assert.isFalse(OpenFeature.getClient().getBooleanValue('new_panel', false));
    }),
  );
});
