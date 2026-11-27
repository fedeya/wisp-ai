import type { FeatureFlag } from '@wisp/protocol/features';
import { Context, Effect, FileSystem, Layer, Schema } from 'effect';
import { HostError } from '../execution/engine-errors.ts';
import { agentHost } from './agent-host.ts';
import { readSettings } from './read-settings.ts';

/** Pure queries over the capability switches from one read. */
export interface CapabilitySnapshot {
  readonly enabled: (id: string, defaultEnabled?: boolean) => boolean;
  readonly disabledMcpTools: (connection: string) => string[];
}

function snapshot(flags: Readonly<Partial<Record<string, boolean>>>): CapabilitySnapshot {
  return {
    enabled(id, defaultEnabled = true) {
      const value = flags[id];
      return typeof value === 'boolean' ? value : defaultEnabled;
    },
    disabledMcpTools(connection) {
      const prefix = 'mcp_tool:' + connection + ':';
      return Object.entries(flags)
        .filter(([id, enabled]) => enabled === false && id.startsWith(prefix))
        .map(([id]) => id.slice(prefix.length));
    },
  };
}

const hasCapabilityFlags = Schema.is(
  Schema.Struct({ enabled: Schema.Record(Schema.String, Schema.Boolean) }),
);
const hasFeatureFlags = Schema.is(
  Schema.Struct({ features: Schema.Record(Schema.String, Schema.Unknown) }),
);

/** The settings published by the bridge. Reads see updates without restarting the agent. */
export class Service extends Context.Service<
  Service,
  {
    readonly read: Effect.Effect<CapabilitySnapshot, HostError>;
    readonly featureEnabled: (flag: FeatureFlag) => Effect.Effect<boolean, HostError>;
  }
>()('@wisp/agent/AgentCapabilities') {}

export function layerFromFile(
  file = () => agentHost()?.capabilitiesFile ?? process.env.WOW_CAPABILITIES_FILE,
) {
  return Layer.effect(
    Service,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const document = readSettings(fs, file);

      const read = Effect.gen(function* () {
        const data = yield* document;
        if (data === undefined) return snapshot({});
        if (!hasCapabilityFlags(data)) {
          return yield* new HostError({
            cause: new Error('Invalid capability settings; the file was preserved'),
          });
        }
        return snapshot(data.enabled);
      });

      return Service.of({
        read,
        featureEnabled: (flag) =>
          Effect.map(document, (data) => hasFeatureFlags(data) && data.features[flag] === true),
      });
    }),
  );
}
