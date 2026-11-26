import { describe, expect, test, vi } from 'vitest';
import { OpenFeature } from '@openfeature/web-sdk';
import type { FeatureOverrides, FeatureRegistry } from '@wisp/protocol/features';
import { ChannelFeatureProvider, Features, OVERRIDE_REASON } from '../src/features.ts';

const registry: FeatureRegistry = {
  new_panel: {
    name: 'New panel',
    description: 'A new panel.',
    channels: ['development', 'nightly'],
  },
  dev_only: { name: 'Dev only', description: 'Only while building it.', channels: ['development'] },
};

async function start(
  options: Partial<Parameters<typeof Features.start>[0]> & {
    saved?: FeatureOverrides[];
  } = {},
) {
  const saved = options.saved ?? [];
  const onChange = vi.fn();
  const features = await Features.start({
    channel: 'nightly',
    overrides: {},
    saveOverrides: async (overrides) => {
      saved.push(overrides);
    },
    onChange,
    registry,
    ...options,
  });
  return { features, saved, onChange };
}

describe('ChannelFeatureProvider', () => {
  const provider = new ChannelFeatureProvider(registry, { dev_only: true });
  test('the evaluation context channel decides a flag without an override', () => {
    expect(provider.resolveBooleanEvaluation('new_panel', false, { channel: 'nightly' })).toEqual({
      value: true,
      variant: 'on',
      reason: 'TARGETING_MATCH',
    });
    expect(provider.resolveBooleanEvaluation('new_panel', true, { channel: 'stable' }).value).toBe(
      false,
    );
  });
  test('an override wins over the channel', () => {
    expect(provider.resolveBooleanEvaluation('dev_only', false, { channel: 'stable' })).toEqual({
      value: true,
      variant: 'on',
      reason: OVERRIDE_REASON,
    });
  });
  test('unknown flags, missing channels and other types fall back to the default', () => {
    expect(
      provider.resolveBooleanEvaluation('removed', true, { channel: 'nightly' }),
    ).toMatchObject({ value: true, errorCode: 'FLAG_NOT_FOUND' });
    expect(provider.resolveBooleanEvaluation('new_panel', false, {})).toMatchObject({
      value: false,
      errorCode: 'INVALID_CONTEXT',
    });
    expect(provider.resolveStringEvaluation('new_panel', 'x')).toMatchObject({
      value: 'x',
      errorCode: 'TYPE_MISMATCH',
    });
  });
});

describe('Features', () => {
  test('values follow the channel', async () => {
    const nightly = (await start()).features;
    expect(nightly.values()).toEqual({ new_panel: true, dev_only: false });
    expect(nightly.enabledNames()).toEqual(['new_panel']);
    const stable = (await start({ channel: 'stable' })).features;
    expect(stable.values()).toEqual({ new_panel: false, dev_only: false });
    const development = (await start({ channel: 'development' })).features;
    expect(development.enabledNames()).toEqual(['dev_only', 'new_panel']);
  });

  test('state reports each flag with its channel default and override', async () => {
    const { features } = await start({ overrides: { new_panel: false } });
    expect(features.state()).toEqual({
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
  });

  test('a saved override applies after it is written and notifies', async () => {
    const { features, saved, onChange } = await start({ channel: 'stable' });
    await features.set('new_panel', true);
    expect(saved).toEqual([{ new_panel: true }]);
    expect(features.values().new_panel).toBe(true);
    expect(onChange).toHaveBeenCalledOnce();
    await features.set('new_panel', null);
    expect(saved.at(-1)).toEqual({});
    expect(features.values().new_panel).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  test('a failed write keeps the previous value', async () => {
    const { features, onChange } = await start({
      saveOverrides: async () => {
        throw Error('disk full');
      },
    });
    await expect(features.set('new_panel', false)).rejects.toThrow('disk full');
    expect(features.values().new_panel).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });

  test('unknown flags are refused and removed flags drop out of saved overrides', async () => {
    const { features, saved } = await start({ overrides: { removed_flag: true } });
    await expect(features.set('removed_flag', true)).rejects.toThrow('Unknown feature flag.');
    await features.set('dev_only', true);
    expect(saved).toEqual([{ dev_only: true }]);
  });

  test('bridges in one process keep their own overrides', async () => {
    const first = (await start()).features;
    const second = (await start({ overrides: { new_panel: false } })).features;
    expect(first.values().new_panel).toBe(true);
    expect(second.values().new_panel).toBe(false);
    expect(OpenFeature.getClient().getBooleanValue('new_panel', false)).toBe(false);
  });
});
