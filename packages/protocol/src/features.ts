import { z } from 'zod';

/**
 * Where a build runs. `development` is any unpackaged or debug build; packaged
 * builds take their channel from the version (`X.Y.Z-nightly.R.A` or `X.Y.Z`).
 */
export const featureChannels = ['development', 'nightly', 'stable'] as const;
export type FeatureChannel = (typeof featureChannels)[number];

export interface FeatureDefinition {
  /** Short name shown under Settings → Experimental. */
  name: string;
  /** What turning the flag on changes, shown under Settings → Experimental. */
  description: string;
  /** Channels where the flag is on unless the user overrides it. */
  channels: readonly FeatureChannel[];
}
export type FeatureRegistry = Readonly<Record<string, FeatureDefinition>>;

/**
 * Unfinished features that can merge to `main` without reaching Stable.
 *
 * Add one as `my_feature: { name: 'My feature', description: '…', channels: ['development', 'nightly'] }`,
 * then check it with `features.enabled('my_feature')` in the bridge,
 * `useFeature('my_feature')` in the desktop, `featureEnabled('my_feature')` in
 * the agent or `ns.Core.FeatureEnabled("my_feature")` in the addon. A tool that
 * belongs to the feature goes in `toolFeatures` (`@wisp/protocol/capabilities`).
 *
 * A flag is temporary: when its feature ships to everyone, delete the entry and
 * its checks instead of adding `stable` to `channels`.
 */
export const featureFlags = {
  ask_wisp_moments: {
    name: 'Ask Wisp moments',
    description:
      'Offer a one-click question when you die, wipe, level up, loot gear, enter a dungeon or open the auction house, a vendor or a trainer.',
    channels: ['development', 'nightly'],
  },
} as const satisfies FeatureRegistry;
export type FeatureFlag = keyof typeof featureFlags;

export const featureName = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,62}$/, 'Use lower_snake_case feature names.');
/** Saved user choices; a missing entry follows the channel default. */
export const featureOverrides = z.record(featureName, z.boolean());
export type FeatureOverrides = z.infer<typeof featureOverrides>;

export const featureViewSchema = z.object({
  id: featureName,
  name: z.string(),
  description: z.string(),
  /** The value every surface uses. */
  enabled: z.boolean(),
  /** The value without an override, from the channel. */
  channelDefault: z.boolean(),
  /** The user's choice, or null when the flag follows its channel. */
  override: z.boolean().nullable(),
});
export type FeatureView = z.infer<typeof featureViewSchema>;
export const featuresStateSchema = z.object({
  channel: z.enum(featureChannels),
  flags: z.array(featureViewSchema),
});
export type FeaturesState = z.infer<typeof featuresStateSchema>;

export function channelDefault(definition: FeatureDefinition, channel: FeatureChannel): boolean {
  return definition.channels.includes(channel);
}

/** The packaged channel of a version, or `development` for unpackaged and debug builds. */
export function featureChannel(version: string, releaseBuild: boolean): FeatureChannel {
  if (!releaseBuild) {
    return 'development';
  }
  return /^\d+\.\d+\.\d+-nightly\.\d+\.\d+$/.test(version) ? 'nightly' : 'stable';
}
