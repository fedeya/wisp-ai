// @effect-migrated
import { OpenFeature } from '@openfeature/web-sdk';
import { Context, Effect, Schema, Semaphore, Stream, SubscriptionRef } from 'effect';
import type { PlatformError } from 'effect/PlatformError';
import { SecureRandom } from 'effect/crypto';
import { channelDefault, featureChannel } from '@wisp/protocol/features';
import type {
  FeatureChannel,
  FeatureFlag,
  FeatureOverrides,
  FeatureRegistry,
  FeaturesState,
} from '@wisp/protocol/features';
import { AppConfig } from '#/platform/config';
import { AppVersion } from '#/platform/app-version';
import { Settings } from '#/settings';
import { ChannelFeatureProvider } from './provider.ts';

/** The resolved value of every registered flag, by id. */
export type FeatureValues = Readonly<Record<string, boolean>>;

/** The flag a player tried to change is not in the registry. */
export class UnknownFeatureFlag extends Schema.TaggedError<UnknownFeatureFlag>()(
  'UnknownFeatureFlag',
  { id: Schema.String, message: Schema.String },
) {}

/**
 * The bridge's feature flags: the channel of this build decides each one
 * unless the player saved an override for it.
 */
export class Features extends Context.Service<
  Features,
  {
    readonly channel: FeatureChannel;
    readonly values: Effect.Effect<FeatureValues>;
    /** Whether a registered flag is on. Typed to the registry so removed flags fail to compile. */
    readonly enabled: (id: FeatureFlag) => Effect.Effect<boolean>;
    /** Names of the flags that are on, sorted. */
    readonly enabledNames: Effect.Effect<readonly string[]>;
    /** Each flag with its channel default and the player's override, for the desktop. */
    readonly state: Effect.Effect<FeaturesState>;
    /** The values each time a saved override changes a flag, from when the stream starts. */
    readonly changes: Stream.Stream<FeatureValues>;
    /**
     * Saves the player's choice for a flag; `null` returns it to the channel
     * default. Saves run one at a time, and the flags change only once the
     * choice is saved.
     */
    readonly set: (
      id: string,
      enabled: boolean | null,
    ) => Effect.Effect<void, UnknownFeatureFlag | PlatformError | Schema.SchemaError>;
  }
>()('@wisp/server/features/Features') {}

interface Flags {
  /** The player's overrides of registered flags. */
  readonly overrides: FeatureOverrides;
  readonly values: FeatureValues;
}

/**
 * The flags of `registry`, evaluated through OpenFeature on a provider domain
 * of their own, so instances in one process (tests) keep their own overrides.
 * The overrides are read from `Settings` once and saved there.
 */
export const make = Effect.fn('Features.make')(function* (registry: FeatureRegistry) {
  const config = yield* AppConfig;
  const { version } = yield* AppVersion;
  const settings = yield* Settings;
  const random = yield* SecureRandom.SecureRandom;
  const channel = featureChannel(version, config.releaseBuild);
  const domain = 'wisp-bridge-' + (yield* random.uuidV4());
  // Drop overrides of flags that no longer exist, so they don't come back on re-add.
  const known = (overrides: FeatureOverrides): FeatureOverrides =>
    Object.fromEntries(Object.entries(overrides).filter(([id]) => Object.hasOwn(registry, id)));

  const saved = known((yield* settings.get).features ?? {});
  const provider = new ChannelFeatureProvider(registry, saved);
  // The provider has no initialization, so it is ready once it is set.
  const client = yield* Effect.sync(() => {
    OpenFeature.setProvider(domain, provider, { channel });
    return OpenFeature.getClient(domain);
  });
  const evaluate = (overrides: FeatureOverrides): Flags => ({
    overrides,
    values: Object.fromEntries(
      Object.keys(registry).map((id) => [id, client.getBooleanValue(id, false)]),
    ),
  });
  const flags = yield* SubscriptionRef.make(evaluate(saved));
  const writes = yield* Semaphore.make(1);

  const values = Effect.map(SubscriptionRef.get(flags), (current) => current.values);

  const enabled = Effect.fn('Features.enabled')(function* (id: FeatureFlag) {
    return (yield* values)[id] === true;
  });

  const enabledNames = Effect.map(values, (current) =>
    Object.entries(current)
      .filter(([, value]) => value)
      .map(([id]) => id)
      .sort(),
  );

  const state = Effect.map(
    SubscriptionRef.get(flags),
    ({ overrides, values: current }): FeaturesState => ({
      channel,
      flags: Object.entries(registry).map(([id, definition]) => ({
        id,
        name: definition.name,
        description: definition.description,
        enabled: current[id] === true,
        channelDefault: channelDefault(definition, channel),
        override: Object.hasOwn(overrides, id) ? (overrides[id] ?? null) : null,
      })),
    }),
  );

  const save = Effect.fnUntraced(function* (id: string, enabled: boolean | null) {
    const { overrides } = yield* SubscriptionRef.get(flags);
    const { [id]: _previous, ...rest } = overrides;
    const next = known(enabled === null ? rest : { ...rest, [id]: enabled });
    yield* settings.update({ features: next });
    yield* Effect.sync(() => provider.setOverrides(next));
    // Like the provider's configuration change event: only when an override changed.
    if (Object.keys(registry).some((flag) => overrides[flag] !== next[flag])) {
      yield* SubscriptionRef.set(flags, evaluate(next));
    }
  });

  const set = Effect.fn('Features.set')(function* (id: string, enabled: boolean | null) {
    if (!Object.hasOwn(registry, id)) {
      return yield* new UnknownFeatureFlag({ id, message: 'Unknown feature flag.' });
    }
    // Once a save starts, the file and the flags change together.
    yield* writes.withPermit(Effect.uninterruptible(save(id, enabled)));
  });

  return Features.of({
    channel,
    values,
    enabled,
    enabledNames,
    state,
    changes: SubscriptionRef.changes(flags).pipe(
      // The first element is the value when the stream starts.
      Stream.drop(1),
      Stream.map((current) => current.values),
    ),
    set,
  });
});
