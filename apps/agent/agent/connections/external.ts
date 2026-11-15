import { readFile } from 'node:fs/promises';
import { defineDynamic } from 'eve';
import { defineMcpClientConnection } from 'eve/connections';
import { capabilityEnabled, readCapabilityFlags } from '@wisp/agent/capabilities';
import { bridgeOrigin } from '@wisp/agent/agent-rpc';
export default defineDynamic(async () => {
  const file = process.env.WOW_MCP_CONFIG;
  if (!file) {
    return null;
  }
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  const config = JSON.parse(raw) as {
    servers?: Record<
      string,
      { enabled?: boolean; url: string; description: string; tokenEnv?: string }
    >;
  };
  const connections: Record<string, ReturnType<typeof defineMcpClientConnection>> = {};
  for (const [name, server] of Object.entries(config.servers || {})) {
    if (!(await capabilityEnabled('mcp:' + name, server.enabled !== false))) {
      continue;
    }
    if (!/^[a-z][a-z0-9_]*$/.test(name)) {
      throw new Error('MCP names must be lowercase identifiers');
    }
    const token = process.env.WOW_BRIDGE_TOKEN;
    const flags = await readCapabilityFlags(process.env.WOW_CAPABILITIES_FILE);
    const prefix = 'mcp_tool:' + name + ':';
    const blocked = Object.keys(flags)
      .filter((key) => key.startsWith(prefix) && flags[key] === false)
      .map((key) => key.slice(prefix.length));
    connections[name.replace(/_/g, '-')] = defineMcpClientConnection({
      url: bridgeOrigin() + '/mcp/' + name,
      description: server.description || name,
      tools: { block: blocked },
      ...(token ? { headers: { authorization: 'Bearer ' + token } } : {}),
    });
  }
  return Object.keys(connections).length ? connections : null;
});
