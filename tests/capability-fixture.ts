import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { Context, Effect, FileSystem, Layer, Path } from 'effect';
import * as AgentCapabilities from '@wisp/agent/capabilities';
import { defaultCapabilities, toolFeatures } from '@wisp/protocol/capabilities';
import type { Capability } from '@wisp/protocol/capabilities';
import * as Capabilities from '@wisp/server/capability-settings';
import { Features } from '@wisp/server/features';

/** The file system the bridge and the agent share in these tests. */
export const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

/** The bridge's capability files for one test, in a folder removed when the test ends. */
export const capabilityFiles = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'wisp-capabilities-' });
  return {
    file: path.join(directory, 'capabilities.json'),
    agentFile: path.join(directory, 'agent-capabilities.json'),
  };
});

/**
 * The bridge's capability settings in `files`, read now, and the integration
 * state over them, with no feature flag on. They last for the test.
 */
export const capabilitiesIn = Effect.fn('capabilitiesIn')(function* (
  files: { readonly file: string; readonly agentFile: string },
  catalog: readonly Capability[] = defaultCapabilities(),
) {
  const context = yield* Layer.build(
    Capabilities.integrationsLayer.pipe(
      Layer.provideMerge(
        Capabilities.settingsLayerWith({ ...files, catalog, toolFlags: toolFeatures }),
      ),
      Layer.provide(Layer.mock(Features, { channel: 'development', values: Effect.succeed({}) })),
      Layer.provide([platform, NodeCrypto.layerSecureRandom]),
    ),
  );
  return {
    settings: Context.get(context, Capabilities.CapabilitySettings),
    integrations: Context.get(context, Capabilities.IntegrationState),
  };
});

/** The capabilities the agent reads from `file` now, as it reads them before a turn. */
export const agentReads = (file: string) =>
  Effect.flatMap(AgentCapabilities.Service, (capabilities) => capabilities.read).pipe(
    Effect.provide(AgentCapabilities.layerFromFile(() => file)),
    Effect.provide(NodeFileSystem.layer),
  );
