import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import { Context, Effect, FileSystem, Layer, Path } from 'effect';
import { defaultCapabilities, toolFeatures } from '@wisp/protocol/capabilities';
import type { Capability } from '@wisp/protocol/capabilities';
import * as Capabilities from '#/capabilities';
import { Features } from '#/features';
import type { FeatureValues } from '#/features';

/** `Features` whose flags read as `values`; nothing else of it is used. */
export const featuresAt = (values: Effect.Effect<FeatureValues>) =>
  Layer.mock(Features, { channel: 'development', values });

/**
 * Capability settings and the integration state over them, with nothing
 * saved, on a file system without files: reads work and writes fail. They
 * build synchronously, for the tests of unmigrated consumers.
 */
export function unsavedCapabilities(catalog: readonly Capability[] = defaultCapabilities()) {
  const context = Effect.runSync(
    Effect.scoped(
      Layer.build(
        Capabilities.integrationsLayer.pipe(
          Layer.provideMerge(
            Capabilities.settingsLayerWith({
              file: 'capabilities.json',
              agentFile: 'agent-capabilities.json',
              catalog,
              toolFlags: toolFeatures,
            }),
          ),
          Layer.provide(featuresAt(Effect.succeed({}))),
          Layer.provide([FileSystem.layerNoop({}), Path.layer, NodeCrypto.layerSecureRandom]),
        ),
      ),
    ),
  );
  const settings = Context.get(context, Capabilities.CapabilitySettings);
  return {
    settings,
    integrations: Context.get(context, Capabilities.IntegrationState),
  };
}
