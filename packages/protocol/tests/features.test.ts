import { describe, expect, test } from 'vitest';
import { toolDescriptions, toolFeatures } from '../src/capabilities.ts';
import {
  channelDefault,
  featureChannel,
  featureChannels,
  featureFlags,
  featureName,
  featureOverrides,
  type FeatureRegistry,
} from '../src/features.ts';

describe('featureChannel', () => {
  test('debug and unpackaged builds are development, whatever their version', () => {
    expect(featureChannel('0.3.2', false)).toBe('development');
    expect(featureChannel('0.3.3-nightly.120.1', false)).toBe('development');
  });
  test('packaged builds take the channel from their version', () => {
    expect(featureChannel('0.3.3-nightly.120.1', true)).toBe('nightly');
    expect(featureChannel('0.4.0', true)).toBe('stable');
  });
  test('a packaged build with an unreadable version is treated as Stable', () => {
    expect(featureChannel('unknown', true)).toBe('stable');
    expect(featureChannel('0.4.0-nightly.x', true)).toBe('stable');
  });
});

test('a flag is on by default only in its channels', () => {
  const flag = {
    name: 'Try it',
    description: 'Try it',
    channels: ['development', 'nightly'],
  } as const;
  expect(channelDefault(flag, 'development')).toBe(true);
  expect(channelDefault(flag, 'nightly')).toBe(true);
  expect(channelDefault(flag, 'stable')).toBe(false);
});

test('overrides only accept registry-shaped names and booleans', () => {
  expect(featureOverrides.safeParse({ new_panel: true }).success).toBe(true);
  expect(featureOverrides.safeParse({ 'New Panel': true }).success).toBe(false);
  expect(featureOverrides.safeParse({ new_panel: 'yes' }).success).toBe(false);
});

test('every registered flag is named, described and not yet shipped', () => {
  const registry: FeatureRegistry = featureFlags;
  for (const [id, flag] of Object.entries(registry)) {
    expect(featureName.safeParse(id).success, id).toBe(true);
    expect(flag.name.trim(), id).not.toBe('');
    expect(flag.description.trim(), id).not.toBe('');
    expect(
      flag.channels.every((channel) => featureChannels.includes(channel)),
      id,
    ).toBe(true);
    // A flag that reaches Stable has shipped: delete it and its checks instead.
    expect(flag.channels, id).not.toContain('stable');
  }
});

test('every flagged tool is a registered tool behind a registered flag', () => {
  for (const [tool, flag] of Object.entries(toolFeatures)) {
    expect(Object.hasOwn(toolDescriptions, tool), tool).toBe(true);
    expect(Object.hasOwn(featureFlags, flag), tool).toBe(true);
  }
});
