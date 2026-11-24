import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
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

/**
 * MCP clients shared across turns. A connection's tool list is cached for a
 * few minutes; a failed call drops the client so the next turn reconnects.
 */
export class McpTools {
  private clients = new Map<string, { client: Client; tools: Tool[]; at: number }>();
  private configFile: () => string | undefined;
  constructor(configFile: () => string | undefined) {
    this.configFile = configFile;
  }

  private async client(key: string, connection: McpConnection) {
    const cached = this.clients.get(key);
    if (cached && Date.now() - cached.at < CACHE_MS) {
      return cached;
    }
    await cached?.client.close().catch(() => {});
    const client = new Client({ name: 'wisp', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(connection.url), {
        requestInit: { headers: connection.headers },
      }),
    );
    const entry = { client, tools: (await client.listTools()).tools, at: Date.now() };
    this.clients.set(key, entry);
    return entry;
  }

  /** The enabled MCP tools; an unreachable connection is skipped and logged by the caller. */
  async tools(onError: (connection: string, error: unknown) => void): Promise<McpTool[]> {
    const connections = await mcpConnections(this.configFile());
    const lists = await Promise.all(
      Object.entries(connections).map(async ([name, connection]) => {
        const key = name + ' ' + connection.url;
        try {
          const { client, tools } = await this.client(key, connection);
          return tools
            .filter(
              (tool) =>
                (!connection.allow || connection.allow.includes(tool.name)) &&
                !connection.block?.includes(tool.name),
            )
            .map((tool): McpTool => ({
              name: name + '__' + tool.name,
              description: [connection.description, tool.description].filter(Boolean).join('\n'),
              inputSchema: withoutProvided(tool.inputSchema, connection.provided),
              call: async (input, signal) => {
                try {
                  return await client.callTool(
                    { name: tool.name, arguments: { ...input, ...connection.provided } },
                    undefined,
                    { signal },
                  );
                } catch (error) {
                  this.clients.delete(key);
                  throw error;
                }
              },
            }));
        } catch (error) {
          this.clients.delete(key);
          onError(name, error);
          return [];
        }
      }),
    );
    return lists.flat();
  }

  async close() {
    await Promise.all(
      [...this.clients.values()].map(({ client }) => client.close().catch(() => {})),
    );
    this.clients.clear();
  }
}
