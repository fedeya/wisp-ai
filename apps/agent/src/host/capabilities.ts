import type { FeatureFlag } from '@wisp/protocol/features';
import { Context, Effect, FileSystem, Layer, Schema } from 'effect';
import { HostError } from '../execution/engine-errors.ts';
import { agentHost } from './agent-host.ts';
import { readSettings } from './read-settings.ts';

export type CapabilityFlags = Readonly<Record<string, boolean>>;

const hasCapabilityFlags = Schema.is(
  Schema.Struct({ enabled: Schema.Record(Schema.String, Schema.Boolean) }),
);
const hasFeatureFlags = Schema.is(
  Schema.Struct({ features: Schema.Record(Schema.String, Schema.Unknown) }),
);

/** The settings published by the bridge. Reads see updates without restarting the agent. */
export class AgentCapabilities extends Context.Service<
  AgentCapabilities,
  {
    readonly read: Effect.Effect<CapabilityFlags, HostError>;
    readonly featureEnabled: (flag: FeatureFlag) => Effect.Effect<boolean, HostError>;
  }
>()('@wisp/agent/AgentCapabilities') {}

export function layerFromFile(
  file = () => agentHost()?.capabilitiesFile ?? process.env.WOW_CAPABILITIES_FILE,
) {
  return Layer.effect(
    AgentCapabilities,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const document = readSettings(fs, file);

      const read = Effect.gen(function* () {
        const data = yield* document;
        if (data === undefined) return {};
        if (!hasCapabilityFlags(data)) {
          return yield* new HostError({
            cause: new Error('Invalid capability settings; the file was preserved'),
          });
        }
        return data.enabled;
      });

      return AgentCapabilities.of({
        read,
        featureEnabled: (flag) =>
          Effect.map(document, (data) => hasFeatureFlags(data) && data.features[flag] === true),
      });
    }),
  );
}
