/**
 * The bridge's loopback endpoint for the MCP relay and its capability file.
 * The agent's own calls to the bridge go through `AgentHostCalls`; this only
 * covers what MCP clients and capability checks read. Standalone scripts may
 * still use the `WOW_*` variables.
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

/** The bridge's loopback origin, for the MCP relay. */
export function bridgeOrigin() {
  return new URL(agentHost()?.origin || process.env.WOW_BRIDGE_URL || 'http://127.0.0.1:43187')
    .origin;
}
