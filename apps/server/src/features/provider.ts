// @effect-migrated
import {
  ErrorCode,
  OpenFeatureEventEmitter,
  ProviderEvents,
  StandardResolutionReasons,
} from '@openfeature/web-sdk';
import type {
  EvaluationContext,
  JsonValue,
  Provider,
  ResolutionDetails,
} from '@openfeature/web-sdk';
import { Schema } from 'effect';
import { channelDefault, featuresStateSchema } from '@wisp/protocol/features';
import type { FeatureOverrides, FeatureRegistry } from '@wisp/protocol/features';

/** Reason reported when the user's saved choice decided the value. */
export const OVERRIDE_REASON = 'OVERRIDE';

const isChannel = Schema.is(featuresStateSchema.fields.channel);

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
