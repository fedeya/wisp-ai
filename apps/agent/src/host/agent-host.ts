// @effect-migrated
import { Predicate, Schema } from 'effect';

/**
 * Where agent code reaches the bridge. The bridge runs the agent in process and
 * registers its loopback endpoint here instead of exporting a token into the
 * environment its child programs inherit. Standalone scripts may still use the
 * `WOW_*` variables.
 *
 * Kept on `globalThis` because the bridge and a packaged engine copy can load
 * this file from two paths, which would otherwise be two module instances.
 */
export const AgentHost = Schema.Struct({
  origin: Schema.String,
  token: Schema.String,
  capabilitiesFile: Schema.optional(Schema.String),
});
export type AgentHost = typeof AgentHost.Type;

const key = Symbol.for('wisp.agent-host');
// The other module instance wrote the slot, so its value is checked, not trusted.
const isAgentHost = Schema.is(AgentHost);

export function setAgentHost(host: AgentHost | undefined) {
  Object.assign(globalThis, { [key]: host });
}

export function agentHost(): AgentHost | undefined {
  const global: object = globalThis;
  const host = Predicate.hasProperty(global, key) ? global[key] : undefined;
  return isAgentHost(host) ? host : undefined;
}
