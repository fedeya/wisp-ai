import { readFile } from 'node:fs/promises';
import { MCPClient } from '@mastra/mcp';
import { everlootTools } from '@wisp/protocol/capabilities';
import { agentHost } from './agent-host.ts';
import { bridgeOrigin } from './agent-rpc.ts';
import { capabilityEnabled, connectionTools, readCapabilityFlags } from './capabilities.ts';

/** One MCP tool offered through `tool_search` and `tool_call`, named `<connection>__<tool>`. */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: unknown;
  call: (input: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
}

export interface McpConnection {
  url: string;
  description: string;
  headers?: Record<string, string>;
  allow?: string[];
  block?: string[];
  /** Arguments the application fixes; they are hidden from the model. */
  provided?: Record<string, unknown>;
}

const EVERLOOT_URL = 'https://everloot.app/mcp/public';
const CACHE_MS = 5 * 60_000;

async function everlootConnections(): Promise<Record<string, McpConnection>> {
  if (!(await capabilityEnabled('mcp:everloot'))) {
    return {};
  }
  const allowed = await connectionTools('everloot', everlootTools);
  const connections: Record<string, McpConnection> = {};
  const reference = allowed.filter(
    (name) => !['search_knowledge', 'recent_changes'].includes(name),
  );
  if (reference.length) {
    connections.everloot = {
      url: EVERLOOT_URL,
      description:
        'Complementary Forever-only observations and reference pages: drops, vendors, quest relations, world locations, talents, professions and realm scan history. Use TheWoWDB for the primary catalog. Missing coverage is unknown. Preserve build, date, source and licence; prices are scans, not live listings.',
      allow: reference,
    };
  }
  if (allowed.includes('search_knowledge')) {
    connections['everloot-search'] = {
      url: EVERLOOT_URL,
      description:
        'Complementary Everloot search with version fixed to Forever by the application. Cannot search Retail, Classic or archived wiki lore. Use TheWoWDB first for catalog facts.',
      allow: ['search_knowledge'],
      provided: { version: 'forever' },
    };
  }
  if (allowed.includes('recent_changes')) {
    connections['everloot-changes'] = {
      url: EVERLOOT_URL,
      description:
        'Official Forever changes only: blue posts, hotfixes and builds. The game filter is supplied by Wisp; Classic changes cannot be selected.',
      allow: ['recent_changes'],
      provided: { game: 'forever' },
    };
  }
  return connections;
}

// Player-configured servers run in the bridge, which relays them over loopback.
async function externalConnections(configFile?: string): Promise<Record<string, McpConnection>> {
  if (!configFile) {
    return {};
  }
  let raw: string;
  try {
    raw = await readFile(configFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw error;
  }
  const config = JSON.parse(raw) as {
    servers?: Record<string, { enabled?: boolean; description?: string }>;
  };
  const flags = await readCapabilityFlags(
    agentHost()?.capabilitiesFile ?? process.env.WOW_CAPABILITIES_FILE,
  );
  const token = agentHost()?.token ?? process.env.WOW_BRIDGE_TOKEN;
  const connections: Record<string, McpConnection> = {};
  for (const [name, server] of Object.entries(config.servers || {})) {
    if (!/^[a-z][a-z0-9_]*$/.test(name)) {
      throw new Error('MCP names must be lowercase identifiers');
    }
    if (!(await capabilityEnabled('mcp:' + name, server.enabled !== false))) {
      continue;
    }
    const prefix = 'mcp_tool:' + name + ':';
    connections[name.replace(/_/g, '-')] = {
      url: bridgeOrigin() + '/mcp/' + name,
      description: server.description || name,
      block: Object.keys(flags)
        .filter((key) => key.startsWith(prefix) && flags[key] === false)
        .map((key) => key.slice(prefix.length)),
      ...(token ? { headers: { authorization: 'Bearer ' + token } } : {}),
    };
  }
  return connections;
}

function withoutProvided(schema: unknown, provided?: Record<string, unknown>) {
  if (!provided || !schema || typeof schema !== 'object') {
    return schema;
  }
  const value = schema as { properties?: Record<string, unknown>; required?: string[] };
  return {
    ...value,
    properties: Object.fromEntries(
      Object.entries(value.properties || {}).filter(([key]) => !(key in provided)),
    ),
    required: (value.required || []).filter((key) => !(key in provided)),
  };
}

/** The enabled MCP connections: bundled Everloot ones and the player's relayed servers. */
export async function mcpConnections(configFile?: string): Promise<Record<string, McpConnection>> {
  return { ...(await everlootConnections()), ...(await externalConnections(configFile)) };
}

type McpToolset = Awaited<ReturnType<MCPClient['listToolsetsWithErrors']>>['toolsets'];
interface MastraMcpTool {
  description?: string;
  inputSchema?: {
    '~standard'?: { jsonSchema?: { input?: (options: { target: string }) => unknown } };
  };
  execute?: (
    input: Record<string, unknown>,
    context: { abortSignal: AbortSignal },
  ) => Promise<unknown>;
}

function jsonSchemaOf(tool: MastraMcpTool) {
  try {
    return tool.inputSchema?.['~standard']?.jsonSchema?.input?.({ target: 'draft-2020-12' }) ?? {};
  } catch {
    return {};
  }
}

/**
 * Mastra MCP clients shared across turns. A client is kept while the enabled
 * connections stay the same, and its tool lists for a few minutes; a failed
 * listing or call drops it so the next turn reconnects.
 */
export class McpTools {
  private current?: { key: string; client: MCPClient; toolsets?: McpToolset; at: number };
  private configFile: () => string | undefined;
  constructor(configFile: () => string | undefined) {
    this.configFile = configFile;
  }

  private async drop() {
    const current = this.current;
    this.current = undefined;
    await current?.client.disconnect().catch(() => {});
  }

  /** The enabled MCP tools; an unreachable connection is skipped and reported to onError. */
  async tools(onError: (connection: string, error: unknown) => void): Promise<McpTool[]> {
    const connections = await mcpConnections(this.configFile());
    if (!Object.keys(connections).length) {
      await this.drop();
      return [];
    }
    const key = JSON.stringify(connections);
    if (this.current?.key !== key) {
      await this.drop();
      this.current = {
        key,
        at: 0,
        client: new MCPClient({
          id: 'wisp-' + Date.now(),
          // The bridge disconnects on shutdown; Mastra must not end the process.
          registerProcessHooks: false,
          clientInfo: { name: 'wisp', version: '1.0.0' },
          servers: Object.fromEntries(
            Object.entries(connections).map(([name, connection]) => {
              const url = new URL(connection.url);
              return [
                name,
                {
                  url,
                  requestInit: { headers: connection.headers },
                  // Each connection may reach only its own host.
                  allowedHosts: [url.host],
                },
              ];
            }),
          ),
        }),
      };
    }
    const current = this.current!;
    if (!current.toolsets || Date.now() - current.at > CACHE_MS) {
      const listed = await current.client.listToolsetsWithErrors();
      for (const [name, error] of Object.entries(listed.errors)) {
        onError(name, error);
      }
      // Retry failed connections on the next turn instead of caching their absence.
      current.toolsets = listed.toolsets;
      current.at = Object.keys(listed.errors).length ? 0 : Date.now();
    }
    const tools: McpTool[] = [];
    for (const [name, connection] of Object.entries(connections)) {
      for (const [toolName, raw] of Object.entries(current.toolsets?.[name] ?? {})) {
        const tool = raw as MastraMcpTool;
        if (
          (connection.allow && !connection.allow.includes(toolName)) ||
          connection.block?.includes(toolName) ||
          !tool.execute
        ) {
          continue;
        }
        tools.push({
          name: name + '__' + toolName,
          description: [connection.description, tool.description].filter(Boolean).join('\n'),
          inputSchema: withoutProvided(jsonSchemaOf(tool), connection.provided),
          call: async (input, signal) => {
            try {
              return await tool.execute!(
                { ...input, ...connection.provided },
                { abortSignal: signal },
              );
            } catch (error) {
              current.at = 0;
              throw error;
            }
          },
        });
      }
    }
    return tools;
  }

  async close() {
    await this.drop();
  }
}
