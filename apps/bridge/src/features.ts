import { randomUUID } from 'node:crypto';
import {
  ErrorCode,
  OpenFeature,
  OpenFeatureEventEmitter,
  ProviderEvents,
  StandardResolutionReasons,
  type Client,
  type EvaluationContext,
  type JsonValue,
  type Provider,
  type ResolutionDetails,
} from '@openfeature/web-sdk';
import {
  channelDefault,
  featureChannels,
  featureFlags,
  type FeatureChannel,
  type FeatureFlag,
  type FeatureOverrides,
  type FeatureRegistry,
  type FeaturesState,
} from '@wisp/protocol/features';

/** Reason reported when the user's saved choice decided the value. */
export const OVERRIDE_REASON = 'OVERRIDE';

function isChannel(value: unknown): value is FeatureChannel {
  return featureChannels.includes(value as FeatureChannel);
}

/**
 * Resolves Wisp's flags from the registry: the user's override wins, otherwise
 * the `channel` in the evaluation context decides. Only boolean flags exist.
 */
export class ChannelFeatureProvider implements Provider {
  readonly metadata = { name: 'wisp-channel' } as const;
  readonly runsOn = 'client' as const;
  readonly events = new OpenFeatureEventEmitter();
  private registry: FeatureRegistry;
  private overrides: FeatureOverrides;
  constructor(registry: FeatureRegistry, overrides: FeatureOverrides) {
    this.registry = registry;
    this.overrides = overrides;
  }
  setOverrides(overrides: FeatureOverrides) {
    const changed = Object.keys(this.registry).filter((id) => this.overrides[id] !== overrides[id]);
    this.overrides = overrides;
    if (changed.length) {
      this.events.emit(ProviderEvents.ConfigurationChanged, { flagsChanged: changed });
    }
  }
  resolveBooleanEvaluation(
    flagKey: string,
    defaultValue: boolean,
    context: EvaluationContext,
  ): ResolutionDetails<boolean> {
    const definition = Object.hasOwn(this.registry, flagKey) ? this.registry[flagKey] : undefined;
    if (!definition) {
      return {
        value: defaultValue,
        reason: StandardResolutionReasons.ERROR,
        errorCode: ErrorCode.FLAG_NOT_FOUND,
        errorMessage: `Unknown feature flag: ${flagKey}`,
      };
    }
    if (Object.hasOwn(this.overrides, flagKey)) {
      const value = this.overrides[flagKey];
      return { value, variant: value ? 'on' : 'off', reason: OVERRIDE_REASON };
    }
    if (!isChannel(context.channel)) {
      return {
        value: defaultValue,
        reason: StandardResolutionReasons.ERROR,
        errorCode: ErrorCode.INVALID_CONTEXT,
        errorMessage: 'The evaluation context has no release channel.',
      };
    }
    const value = channelDefault(definition, context.channel);
    return {
      value,
      variant: value ? 'on' : 'off',
      reason: StandardResolutionReasons.TARGETING_MATCH,
    };
  }
  resolveStringEvaluation(flagKey: string, defaultValue: string) {
    return this.typeMismatch(flagKey, defaultValue);
  }
  resolveNumberEvaluation(flagKey: string, defaultValue: number) {
    return this.typeMismatch(flagKey, defaultValue);
  }
  resolveObjectEvaluation<T extends JsonValue>(flagKey: string, defaultValue: T) {
    return this.typeMismatch(flagKey, defaultValue);
  }
  private typeMismatch<T>(flagKey: string, defaultValue: T): ResolutionDetails<T> {
    return {
      value: defaultValue,
      reason: StandardResolutionReasons.ERROR,
      errorCode: ErrorCode.TYPE_MISMATCH,
      errorMessage: `Feature flag ${flagKey} is a boolean.`,
    };
  }
}

export interface FeatureOptions {
  channel: FeatureChannel;
  overrides: FeatureOverrides;
  /** Persists the overrides; the change applies only after it resolves. */
  saveOverrides: (overrides: FeatureOverrides) => Promise<void>;
  /** Called after any flag's value may have changed. */
  onChange?: () => void;
  registry?: FeatureRegistry;
}

/**
 * The bridge's view of the feature flags, evaluated through OpenFeature. Each
 * instance binds its own provider domain, so bridges started in one process
 * (tests) do not share overrides.
 */
export class Features {
  readonly channel: FeatureChannel;
  private readonly registry: FeatureRegistry;
  private readonly provider: ChannelFeatureProvider;
  private readonly client: Client;
  private readonly domain = 'wisp-bridge-' + randomUUID();
  private readonly saveOverrides: FeatureOptions['saveOverrides'];
  private overrides: FeatureOverrides;
  private writes: Promise<unknown> = Promise.resolve();
  private constructor(options: FeatureOptions) {
    this.channel = options.channel;
    this.registry = options.registry ?? featureFlags;
    this.overrides = this.known(options.overrides);
    this.saveOverrides = options.saveOverrides;
    this.provider = new ChannelFeatureProvider(this.registry, this.overrides);
    this.client = OpenFeature.getClient(this.domain);
    const { onChange } = options;
    if (onChange) {
      this.client.addHandler(ProviderEvents.ConfigurationChanged, () => onChange());
    }
  }
  static async start(options: FeatureOptions): Promise<Features> {
    const features = new Features(options);
    await OpenFeature.setProviderAndWait(features.domain, features.provider, {
      channel: features.channel,
    });
    return features;
  }
  /** Whether a registered flag is on. Typed to the registry so removed flags fail to compile. */
  enabled(id: FeatureFlag): boolean {
    return this.client.getBooleanValue(id, false);
  }
  /** Resolved value of every registered flag. */
  values(): Record<string, boolean> {
    return Object.fromEntries(
      Object.keys(this.registry).map((id) => [id, this.client.getBooleanValue(id, false)]),
    );
  }
  /** Names of the flags that are on, sorted. */
  enabledNames(): string[] {
    return Object.entries(this.values())
      .filter(([, value]) => value)
      .map(([id]) => id)
      .sort();
  }
  state(): FeaturesState {
    return {
      channel: this.channel,
      flags: Object.entries(this.registry).map(([id, definition]) => {
        const override = Object.hasOwn(this.overrides, id) ? this.overrides[id] : null;
        return {
          id,
          name: definition.name,
          description: definition.description,
          enabled: this.client.getBooleanValue(id, false),
          channelDefault: channelDefault(definition, this.channel),
          override,
        };
      }),
    };
  }
  /** Save the user's choice for a flag; `null` returns it to the channel default. */
  set(id: string, enabled: boolean | null): Promise<void> {
    if (!Object.hasOwn(this.registry, id)) {
      return Promise.reject(Error('Unknown feature flag.'));
    }
    const write = this.writes
      .catch(() => {})
      .then(async () => {
        const { [id]: _previous, ...rest } = this.overrides;
        const next = this.known(enabled === null ? rest : { ...rest, [id]: enabled });
        await this.saveOverrides(next);
        this.overrides = next;
        this.provider.setOverrides(next);
      });
    this.writes = write;
    return write;
  }
  /** Drop overrides of flags that no longer exist, so they don't come back on re-add. */
  private known(overrides: FeatureOverrides): FeatureOverrides {
    return Object.fromEntries(
      Object.entries(overrides).filter(([id]) => Object.hasOwn(this.registry, id)),
    );
  }
}
