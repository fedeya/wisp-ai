import type { FeatureFlag } from '@wisp/protocol/features';
import { Context, Effect, Layer, Schema } from 'effect';
import { readFile } from 'node:fs/promises';
import { HostError, hostCall } from '../execution/engine-errors.ts';
import { agentHost } from './agent-host.ts';

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
>()('@wisp/agent/AgentCapabilities') {
  static layer(file = () => agentHost()?.capabilitiesFile ?? process.env.WOW_CAPABILITIES_FILE) {
    const document = hostCall(async (signal): Promise<unknown> => {
      const path = file();
      if (!path) return { enabled: {} };
      try {
        return JSON.parse(await readFile(path, { encoding: 'utf8', signal }));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { enabled: {} };
        throw error;
      }
    });

    const read = Effect.gen(function* () {
      const data = yield* document;
      if (!hasCapabilityFlags(data)) {
        return yield* new HostError({
          cause: new Error('Invalid capability settings; the file was preserved'),
        });
      }
      return data.enabled;
    });

    return Layer.succeed(AgentCapabilities, {
      read,
      featureEnabled: (flag) =>
        Effect.map(document, (data) => hasFeatureFlags(data) && data.features[flag] === true),
    });
  }
}
