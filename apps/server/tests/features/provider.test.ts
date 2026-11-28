import { assert, describe, it } from '@effect/vitest';
import type { FeatureRegistry } from '@wisp/protocol/features';
import { ChannelFeatureProvider, OVERRIDE_REASON } from '../../src/features/provider.ts';

const registry: FeatureRegistry = {
  new_panel: {
    name: 'New panel',
    description: 'A new panel.',
    channels: ['development', 'nightly'],
  },
  dev_only: { name: 'Dev only', description: 'Only while building it.', channels: ['development'] },
};

describe('ChannelFeatureProvider', () => {
  const provider = new ChannelFeatureProvider(registry, { dev_only: true });

  it('the evaluation context channel decides a flag without an override', () => {
    assert.deepStrictEqual(
      provider.resolveBooleanEvaluation('new_panel', false, { channel: 'nightly' }),
      { value: true, variant: 'on', reason: 'TARGETING_MATCH' },
    );
    assert.isFalse(
      provider.resolveBooleanEvaluation('new_panel', true, { channel: 'stable' }).value,
    );
  });

  it('an override wins over the channel', () => {
    assert.deepStrictEqual(
      provider.resolveBooleanEvaluation('dev_only', false, { channel: 'stable' }),
      { value: true, variant: 'on', reason: OVERRIDE_REASON },
    );
  });

  it('unknown flags, missing channels and other types fall back to the default', () => {
    const removed = provider.resolveBooleanEvaluation('removed', true, { channel: 'nightly' });
    assert.isTrue(removed.value);
    assert.strictEqual(removed.errorCode, 'FLAG_NOT_FOUND');
    const noChannel = provider.resolveBooleanEvaluation('new_panel', false, {});
    assert.isFalse(noChannel.value);
    assert.strictEqual(noChannel.errorCode, 'INVALID_CONTEXT');
    const text = provider.resolveStringEvaluation('new_panel', 'x');
    assert.strictEqual(text.value, 'x');
    assert.strictEqual(text.errorCode, 'TYPE_MISMATCH');
  });
});
