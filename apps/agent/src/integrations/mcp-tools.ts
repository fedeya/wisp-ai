import { readFile } from 'node:fs/promises';
import { Context, Effect, Layer } from 'effect';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { everlootTools } from '@wisp/protocol/capabilities';
import { agentHost } from '../host/agent-host.ts';
import { bridgeOrigin } from '../host/agent-rpc.ts';
import type { CapabilityFlags } from '../host/capabilities.ts';
import { EngineConfig } from '../host/engine-config.ts';
import { hostCall, type HostError } from '../execution/engine-errors.ts';

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

function everlootConnections(flags: CapabilityFlags): Record<string, McpConnection> {
  if (flags['mcp:everloot'] === false) {
    return {};
  }
  const allowed = everlootTools.filter((tool) => flags['mcp_tool:everloot:' + tool] !== false);
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
async function externalConnections(
  flags: CapabilityFlags,
  configFile: string | undefined,
  signal: AbortSignal,
): Promise<Record<string, McpConnection>> {
  if (!configFile) {
    return {};
  }
  let raw: string;
  try {
    raw = await readFile(configFile, { encoding: 'utf8', signal });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw error;
  }
  const config = JSON.parse(raw) as {
    servers?: Record<string, { enabled?: boolean; description?: string }>;
  };
  const token = agentHost()?.token ?? process.env.WOW_BRIDGE_TOKEN;
  const connections: Record<string, McpConnection> = {};
  for (const [name, server] of Object.entries(config.servers || {})) {
    if (!/^[a-z][a-z0-9_]*$/.test(name)) {
      throw new Error('MCP names must be lowercase identifiers');
    }
    const enabled = flags['mcp:' + name] ?? server.enabled !== false;
    if (!enabled) {
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
export function mcpConnections(flags: CapabilityFlags, configFile?: () => string | undefined) {
  return hostCall(async (signal) => ({
    ...everlootConnections(flags),
    ...(await externalConnections(flags, configFile?.(), signal)),
  }));
}

interface Connected {
  client: Client;
  tools?: Tool[];
  at: number;
}

// Discovery and calls each have a deadline, so a stalled server cannot hold a turn.
const LIST_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 120_000;

/** Connects to one server over Streamable HTTP. */
async function connect(connection: McpConnection): Promise<Connected> {
  const client = new Client({ name: 'wisp', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(connection.url), {
      requestInit: { headers: connection.headers },
    }),
    { timeout: LIST_TIMEOUT_MS },
  );
  return { client, at: 0 };
}

/**
 * MCP clients shared across turns, one per connection. Clients are kept while
 * the enabled connections stay the same, and their tool lists for a few
 * minutes; a failed listing or call drops that client so the next turn
 * reconnects.
 */
export class McpTools {
  private current?: { key: string; clients: Map<string, Connected> };
  private closed = false;

  private async disconnect(clients: Map<string, Connected>, name?: string) {
    const names = name ? [name] : [...clients.keys()];
    await Promise.all(
      names.map(async (entry) => {
        const connected = clients.get(entry);
        clients.delete(entry);
        await connected?.client.close().catch(() => {});
      }),
    );
  }

  private async drop() {
    const current = this.current;
    this.current = undefined;
    if (current) {
      await this.disconnect(current.clients);
    }
  }

  // The connection's tools, connecting and listing again when needed.
  private async listed(
    clients: Map<string, Connected>,
    name: string,
    connection: McpConnection,
  ): Promise<Connected | undefined> {
    if (this.current?.clients !== clients) return;
    let connected = clients.get(name);
    if (!connected) {
      connected = await connect(connection);
      // Shutdown or a configuration change can drop this cache while connecting.
      if (this.current?.clients !== clients) {
        await connected.client.close().catch(() => {});
        return;
      }
      clients.set(name, connected);
    }
    if (!connected.tools || Date.now() - connected.at > CACHE_MS) {
      try {
        const tools: Tool[] = [];
        let cursor: string | undefined;
        do {
          const page = await connected.client.listTools(cursor ? { cursor } : undefined, {
            timeout: LIST_TIMEOUT_MS,
          });
          tools.push(...page.tools);
          cursor = page.nextCursor;
        } while (cursor);
        connected.tools = tools;
        connected.at = Date.now();
      } catch (error) {
        await this.disconnect(clients, name);
        throw error;
      }
    }
    return connected;
  }

  /** The enabled MCP tools; an unreachable connection is skipped and reported to onError. */
  async tools(
    connections: Record<string, McpConnection>,
    onError: (connection: string, error: unknown) => void,
  ): Promise<McpTool[]> {
    if (this.closed) return [];
    if (!Object.keys(connections).length) {
      await this.drop();
      return [];
    }
    const key = JSON.stringify(connections);
    if (this.current?.key !== key) {
      await this.drop();
      if (this.closed) return [];
      this.current = { key, clients: new Map() };
    }
    const { clients } = this.current!;
    const tools: McpTool[] = [];
    for (const [name, connection] of Object.entries(connections)) {
      let connected: Connected | undefined;
      try {
        connected = await this.listed(clients, name, connection);
      } catch (error) {
        if (this.current?.clients !== clients) return [];
        // Retried on the next turn instead of caching its absence.
        onError(name, error);
        continue;
      }
      if (!connected || this.current?.clients !== clients) return [];
      for (const tool of connected.tools ?? []) {
        if (
          (connection.allow && !connection.allow.includes(tool.name)) ||
          connection.block?.includes(tool.name)
        ) {
          continue;
        }
        tools.push({
          name: name + '__' + tool.name,
          description: [connection.description, tool.description].filter(Boolean).join('\n'),
          inputSchema: withoutProvided(tool.inputSchema, connection.provided),
          call: async (input, signal) => {
            try {
              return await connected.client.callTool(
                { name: tool.name, arguments: { ...input, ...connection.provided } },
                undefined,
                { signal, timeout: CALL_TIMEOUT_MS },
              );
            } catch (error) {
              if (!signal.aborted && clients.get(name) === connected) {
                await this.disconnect(clients, name);
              }
              throw error;
            }
          },
        });
      }
    }
    return tools;
  }

  async close() {
    this.closed = true;
    await this.drop();
  }
}

/** The MCP tools of the enabled connections, with clients kept across turns. */
export class Mcp extends Context.Service<
  Mcp,
  { readonly tools: (flags: CapabilityFlags) => Effect.Effect<readonly McpTool[], HostError> }
>()('@wisp/agent/Mcp') {
  static readonly layer = Layer.effect(
    Mcp,
    Effect.gen(function* () {
      const { mcpConfigFile } = yield* EngineConfig;
      const clients = yield* Effect.acquireRelease(
        Effect.sync(() => new McpTools()),
        (tools) => Effect.promise(() => tools.close()),
      );
      const tools = Effect.fn('Mcp.tools')(function* (flags: CapabilityFlags) {
        const connections = yield* mcpConnections(flags, mcpConfigFile);
        const unavailable: { connection: string; error: unknown }[] = [];
        const listed = yield* hostCall(() =>
          clients.tools(connections, (connection, error) =>
            unavailable.push({ connection, error }),
          ),
        );
        // An unreachable connection is left out of this turn, not fatal to it.
        yield* Effect.forEach(
          unavailable,
          ({ connection, error }) =>
            Effect.logWarning('MCP connection unavailable').pipe(
              Effect.annotateLogs({
                event: 'agent.mcp_unavailable',
                connection,
                error: error instanceof Error ? error.message : String(error),
              }),
            ),
          { discard: true },
        );
        return listed;
      });
      return Mcp.of({ tools });
    }),
  );
}
