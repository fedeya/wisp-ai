/**
 * Where agent code reaches the bridge. The bridge runs the agent in process and
 * registers its loopback endpoint here instead of exporting a token into the
 * environment its child programs inherit. Standalone scripts may still use the
 * `WOW_*` variables.
 *
 * Kept on `globalThis` because the bridge and a packaged engine copy can load
 * this file from two paths, which would otherwise be two module instances.
 */
export interface AgentHost {
  origin: string;
  token: string;
  capabilitiesFile?: string;
}
const key = Symbol.for('wisp.agent-host');

export function setAgentHost(host: AgentHost | undefined) {
  (globalThis as Record<symbol, unknown>)[key] = host;
}

export function agentHost(): AgentHost | undefined {
  return (globalThis as Record<symbol, unknown>)[key] as AgentHost | undefined;
}
