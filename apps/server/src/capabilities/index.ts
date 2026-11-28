// @effect-migrated
import { Effect, Layer, Path } from 'effect';
import { defaultCapabilities, toolFeatures } from '@wisp/protocol/capabilities';
import { AppConfig } from '#/platform/config';
import { IntegrationState, make as makeIntegrationState } from './integrations.ts';
import { CapabilitySettings, make as makeSettings } from './settings.ts';
import type { CapabilitySettingsOptions } from './settings.ts';

export { IntegrationState } from './integrations.ts';
export type { IntegrationReport } from './integrations.ts';
export { CapabilityFileError, CapabilitySettings, UnknownCapability } from './settings.ts';
export type { Availability, CapabilitySettingsOptions } from './settings.ts';

/**
 * The player's capability switches in `capabilities.json` in the runtime
 * folder from `AppConfig`, published for the agent in
 * `agent-capabilities.json` next to it, over Wisp's catalog and tool flags.
 */
export const settingsLayer = Layer.effect(
  CapabilitySettings,
  Effect.gen(function* () {
    const { paths } = yield* AppConfig;
    const path = yield* Path.Path;
    return yield* makeSettings({
      file: path.join(paths.runtime, 'capabilities.json'),
      agentFile: path.join(paths.runtime, 'agent-capabilities.json'),
      catalog: defaultCapabilities(),
      toolFlags: toolFeatures,
    });
  }),
);

/** Capability settings kept where `options` says, over its catalog and tool flags. */
export const settingsLayerWith = (options: CapabilitySettingsOptions) =>
  Layer.effect(CapabilitySettings, makeSettings(options));

/** The game's integrations, recorded in the `CapabilitySettings` it is given. */
export const integrationsLayer = Layer.effect(IntegrationState, makeIntegrationState());
