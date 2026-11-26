import { Context, Effect, Exit, FileSystem, Layer, Scope } from 'effect';
import { everlootTools } from '@wisp/protocol/capabilities';
import { agentHost } from '../host/agent-host.ts';
import { bridgeOrigin } from '../host/agent-rpc.ts';
import type { CapabilitySnapshot } from '../host/capabilities.ts';
import { EngineConfig } from '../host/engine-config.ts';
import { readSettings } from '../host/read-settings.ts';
import { HostError } from '../execution/engine-errors.ts';
import * as Connection from './mcp-connection.ts';
import type { McpConnection } from './mcp-connection.ts';

/** One MCP tool offered through `tool_search` and `tool_call`, named `<connection>__<tool>`. */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: unknown;
  call: (input: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
}

export type { McpConnection } from './mcp-connection.ts';

const EVERLOOT_URL = 'https://everloot.app/mcp/public';

function everlootConnections(capabilities: CapabilitySnapshot): Record<string, McpConnection> {
  if (!capabilities.enabled('mcp:everloot')) {
    return {};
  }
  const blocked = capabilities.disabledMcpTools('everloot');
  const allowed = everlootTools.filter((tool) => !blocked.includes(tool));
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
function externalConnections(
  data: unknown,
  capabilities: CapabilitySnapshot,
): Record<string, McpConnection> {
  if (data === undefined) {
    return {};
  }
  const config = data as {
    servers?: Record<string, { enabled?: boolean; description?: string }>;
  };
  const token = agentHost()?.token ?? process.env.WOW_BRIDGE_TOKEN;
  const connections: Record<string, McpConnection> = {};
  for (const [name, server] of Object.entries(config.servers || {})) {
    if (!/^[a-z][a-z0-9_]*$/.test(name)) {
      throw new Error('MCP names must be lowercase identifiers');
    }
    if (!capabilities.enabled('mcp:' + name, server.enabled !== false)) {
      continue;
    }
    connections[name.replace(/_/g, '-')] = {
      url: bridgeOrigin() + '/mcp/' + name,
      description: server.description || name,
      block: capabilities.disabledMcpTools(name),
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
export const mcpConnections = Effect.fnUntraced(function* (
  capabilities: CapabilitySnapshot,
  configFile?: () => string | undefined,
) {
  const fs = yield* FileSystem.FileSystem;
  const data = yield* readSettings(fs, configFile);
  return yield* Effect.try({
    try: () => ({
      ...everlootConnections(capabilities),
      ...externalConnections(data, capabilities),
    }),
    catch: (cause) => new HostError({ cause }),
  });
});

type ClientEntry = Effect.Success<ReturnType<typeof Connection.start>> & { retiring: boolean };
type Clients = Map<string, ClientEntry>;

/** Shares open clients across turns and retires them when the configuration changes. */
export const make = Effect.fnUntraced(function* () {
  const scope = Scope.makeUnsafe('parallel');
  let current: { key: string; clients: Clients } | undefined;
  let closed = false;

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      closed = true;
      current = undefined;
    }).pipe(Effect.andThen(Scope.close(scope, Exit.void))),
  );

  const clientsFor = Effect.fnUntraced(function* (key: string) {
    if (closed) return;
    if (current?.key === key) return current.clients;
    const retired = current;
    const clients: Clients = new Map();
    current = { key, clients };
    if (retired) {
      yield* Effect.forEach(retired.clients.values(), (entry) => entry.close, {
        discard: true,
        concurrency: 'unbounded',
      });
    }
    return clients;
  }, Effect.uninterruptible);

  const entryFor = Effect.fnUntraced(function* (
    clients: Clients,
    name: string,
    connection: McpConnection,
  ) {
    if (current?.clients !== clients) return;
    const existing = clients.get(name);
    if (existing) return existing;
    const lifecycle = yield* Connection.start(scope, connection, () => {
      if (clients.get(name) === entry) clients.delete(name);
    });
    const entry = { ...lifecycle, retiring: false };
    clients.set(name, entry);
    return entry;
  }, Effect.uninterruptible);

  const retire = Effect.fnUntraced(function* (clients: Clients, name: string, entry: ClientEntry) {
    if (clients.get(name) === entry) {
      entry.retiring = true;
      yield* entry.close;
    }
  }, Effect.uninterruptible);

  const tools = Effect.fn('Mcp.tools')(function* (connections: Record<string, McpConnection>) {
    const clients = yield* clientsFor(JSON.stringify(connections));
    if (!clients) return [];
    const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
    const tools: McpTool[] = [];
    for (const [name, connection] of Object.entries(connections)) {
      const entry = yield* entryFor(clients, name, connection);
      if (!entry) return [];
      const listed = yield* Effect.gen(function* () {
        const client = yield* entry.ready;
        if (!client || entry.retiring || current?.clients !== clients) return;
        const tools = yield* client.tools.pipe(Effect.tapError(() => retire(clients, name, entry)));
        return { client, tools };
      }).pipe(
        Effect.catch(({ cause }) =>
          current?.clients !== clients
            ? Effect.void
            : Effect.logWarning('MCP connection unavailable').pipe(
                Effect.annotateLogs({
                  event: 'agent.mcp_unavailable',
                  connection: name,
                  error: cause instanceof Error ? cause.message : String(cause),
                }),
              ),
        ),
      );
      if (current?.clients !== clients) return [];
      if (!listed || entry.retiring || clients.get(name) !== entry) continue;
      for (const tool of listed.tools) {
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
          call: (input, signal) =>
            runPromise(
              Effect.suspend(() =>
                current?.clients === clients && clients.get(name) === entry && !entry.retiring
                  ? listed.client.call(tool.name, { ...input, ...connection.provided })
                  : Effect.fail(
                      new HostError({ cause: new Error('MCP connection is unavailable') }),
                    ),
              ).pipe(
                Effect.tapError(() =>
                  signal.aborted ? Effect.void : retire(clients, name, entry),
                ),
                Effect.mapError((error) => error.cause),
              ),
              { signal },
            ),
        });
      }
    }
    return tools;
  });

  return { tools };
});

/** The MCP tools of the enabled connections, with clients kept across turns. */
export class Mcp extends Context.Service<
  Mcp,
  {
    readonly tools: (
      capabilities: CapabilitySnapshot,
    ) => Effect.Effect<readonly McpTool[], HostError>;
  }
>()('@wisp/agent/Mcp') {}

export const layer = Layer.effect(
  Mcp,
  Effect.gen(function* () {
    const { mcpConfigFile } = yield* EngineConfig;
    const fs = yield* FileSystem.FileSystem;
    const clients = yield* make();
    return Mcp.of({
      tools: (capabilities) =>
        mcpConnections(capabilities, mcpConfigFile).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.flatMap(clients.tools),
        ),
    });
  }),
);
