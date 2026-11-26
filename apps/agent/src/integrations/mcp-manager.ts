import type { z } from 'zod';
import { Effect, Exit, Schema, Scope, Semaphore } from 'effect';
import { mcpName as name, mcpDefinition, mcpSetup } from '@wisp/protocol/mcp-setup';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { McpConnection, McpConnectionError } from './mcp-connection.ts';
import type { Connection } from './mcp-connection.ts';
export { mcpDefinition, mcpSetup };
export type MCPDefinition = z.infer<typeof mcpDefinition> & {
  tools?: { name: string; description?: string }[];
  hasToken?: boolean;
  envKeys?: string[];
};
type Setup = z.infer<typeof mcpSetup>;

export interface McpStorage {
  readConfig(): Promise<string | undefined>;
  writeConfig(servers: Record<string, MCPDefinition>): Promise<void>;
  readSecret(key: string): Promise<string>;
  writeSecret(key: string, value: string): Promise<void>;
}

export type EverlootLookup = (
  tool: 'item_categories' | 'entity_relations',
  args: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

const everloot: MCPDefinition = {
  name: 'everloot',
  description: 'Everloot',
  url: 'https://everloot.app/mcp/public',
  transport: 'http',
  enabled: true,
  args: [],
};
const isStructuredContent = Schema.is(Schema.Record(Schema.String, Schema.Unknown));

class McpConfigurationError extends Error {
  readonly _tag = 'McpConfigurationError';
}

class McpVaultError extends Error {
  readonly _tag = 'McpVaultError';
}

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const configurationError = (cause: unknown) => new McpConfigurationError(message(cause), { cause });
const vaultError = (cause: unknown) => new McpVaultError(message(cause), { cause });

function make(root = '.', storage?: McpStorage) {
  let servers: Record<string, MCPDefinition> = {};
  let closed = false;
  const connectionScope = Scope.makeUnsafe('parallel');
  const cacheUpdates = Semaphore.makeUnsafe(1);
  const updates = Semaphore.makeUnsafe(1);

  function exclusive<A, E>(effect: Effect.Effect<A, E>) {
    // A caller can cancel while waiting, but a started write must finish updating in-memory state.
    return updates.withPermit(Effect.uninterruptible(effect));
  }

  const load = Effect.fn('McpManager.load')(function* () {
    if (!storage) return;
    const text = yield* Effect.tryPromise({
      try: () => storage.readConfig(),
      catch: configurationError,
    });
    if (text === undefined) {
      return;
    }
    const loaded = yield* Effect.try({
      try: () => {
        const raw = JSON.parse(text) as { servers?: Record<string, Record<string, unknown>> };
        return Object.fromEntries(
          Object.entries(raw.servers || {}).map(([key, s]) => [
            key,
            {
              ...mcpDefinition.parse({ ...s, name: key }),
              tools: Array.isArray(s.tools) ? (s.tools as MCPDefinition['tools']) : [],
              hasToken: s.hasToken === true,
              envKeys: Array.isArray(s.envKeys) ? (s.envKeys as string[]) : [],
            },
          ]),
        );
      },
      catch: configurationError,
    });
    Object.assign(servers, loaded);
  }, exclusive);

  function list() {
    return Object.values(servers).map((s) => ({ ...s, args: [...s.args] }));
  }

  function readSecret(key: string) {
    return Effect.tryPromise({
      try: async () => (await storage?.readSecret(key)) ?? '',
      catch: vaultError,
    });
  }

  function writeSecret(key: string, value: string) {
    if (!storage) return Effect.fail(new McpVaultError('MCP credential storage is unavailable'));
    return Effect.tryPromise({ try: () => storage.writeSecret(key, value), catch: vaultError });
  }

  const transportFor = Effect.fn('McpManager.transportFor')(function* (
    server: MCPDefinition,
    token?: string,
    providedEnv?: Record<string, string>,
  ) {
    let secret = token;
    if (secret === undefined) {
      secret = server.hasToken
        ? yield* readSecret('mcp:' + server.name + ':token')
        : server.tokenEnv
          ? process.env[server.tokenEnv]
          : undefined;
    }
    let env = providedEnv;
    if (env === undefined && server.envKeys?.length) {
      const stored = yield* readSecret('mcp:' + server.name + ':env');
      env = yield* Effect.try({
        try: () => JSON.parse(stored || '{}') as Record<string, string>,
        catch: vaultError,
      });
    }
    return yield* McpConnection.makeTransport(root, server, secret, env ?? {});
  });

  const connections = new Map<string, Connection<Effect.Error<ReturnType<typeof transportFor>>>>();

  const probe = Effect.fn('McpManager.probe')(function* (input: Setup) {
    const tools = yield* McpConnection.probe(
      transportFor({ ...servers[input.server.name], ...input.server }, input.token, input.env),
    );
    return {
      tools: tools.map((t) => ({ name: t.name, description: t.description })),
      count: tools.length,
    };
  });

  const test = Effect.fn('McpManager.test')(function* (input: Setup) {
    const parsed = yield* Effect.try({
      try: () => mcpSetup.parse(input),
      catch: configurationError,
    });
    return yield* probe(parsed);
  });

  const save = Effect.fn('McpManager.save')(function* (input: Setup) {
    const parsed = yield* Effect.try({
      try: () => mcpSetup.parse(input),
      catch: configurationError,
    });
    const tested = yield* probe(parsed);
    yield* saveTestedSetup(parsed, tested.tools);
    return tested;
  });

  const saveTestedSetup = Effect.fn('McpManager.saveTestedSetup')(function* (
    setup: Setup,
    tools: MCPDefinition['tools'],
  ) {
    const key = setup.server.name;
    if (setup.token !== undefined) {
      yield* writeSecret('mcp:' + key + ':token', setup.token);
    }
    if (setup.env !== undefined) {
      yield* writeSecret('mcp:' + key + ':env', JSON.stringify(setup.env));
    }
    const old = servers[key];
    const definition = {
      ...setup.server,
      tools,
      hasToken: setup.token !== undefined ? !!setup.token : old?.hasToken,
      envKeys: setup.env !== undefined ? Object.keys(setup.env) : old?.envKeys,
    };
    yield* persist({ ...servers, [key]: definition });
    yield* disconnectConnection(key);
  }, exclusive);

  const persist = Effect.fn('McpManager.persist')(function* (next: Record<string, MCPDefinition>) {
    yield* Effect.tryPromise({
      try: () => {
        if (!storage) throw Error('MCP configuration storage is unavailable');
        return storage.writeConfig(next);
      },
      catch: configurationError,
    });
    servers = next;
  });

  const setEnabled = Effect.fn('McpManager.setEnabled')(function* (key: string, enabled: boolean) {
    yield* Effect.try({ try: () => name.parse(key), catch: configurationError });
    if (typeof enabled !== 'boolean') {
      return yield* Effect.fail(new McpConfigurationError('Invalid MCP switch'));
    }
    const server = servers[key];
    if (!server) {
      return yield* Effect.fail(new McpConfigurationError('Unknown MCP connection'));
    }
    if (server.enabled !== enabled) {
      yield* persist({ ...servers, [key]: { ...server, enabled } });
      if (!enabled) {
        yield* disconnectConnection(key);
      }
    }
  }, exclusive);

  const remove = Effect.fn('McpManager.remove')(function* (key: string) {
    yield* Effect.try({ try: () => name.parse(key), catch: configurationError });
    const next = { ...servers };
    delete next[key];
    yield* persist(next);
    yield* disconnectConnection(key);
    yield* writeSecret('mcp:' + key + ':token', '');
    yield* writeSecret('mcp:' + key + ':env', '');
  }, exclusive);

  const getConnection = Effect.fn('McpManager.getConnection')(
    function* (key: string) {
      const server = key === 'everloot' ? everloot : servers[key];
      if (closed || !server?.enabled) {
        return yield* Effect.fail(new McpConnectionError('MCP connection is unavailable'));
      }
      const existing = connections.get(key);
      if (existing) {
        return existing;
      }
      const connection = McpConnection.make({
        scope: connectionScope,
        transport: transportFor(server),
        refreshTools: key === 'everloot',
        onClosed: () => {
          if (connections.get(key) === connection) {
            connections.delete(key);
          }
        },
      });
      connections.set(key, connection);
      yield* connection.start;
      return connection;
    },
    (effect) => cacheUpdates.withPermit(Effect.uninterruptible(effect)),
  );

  function connect(key: string) {
    return getConnection(key).pipe(Effect.flatMap((connection) => connection.awaitReady));
  }

  const discover = Effect.fn('McpManager.discover')(function* (key: string) {
    const entry = yield* getConnection(key);
    const connected = yield* entry.awaitReady;
    return yield* connected.listTools.pipe(Effect.tapError(() => disconnectConnection(key, entry)));
  });

  const call = Effect.fn('McpManager.call')(function* (
    key: string,
    toolName: string,
    input: Record<string, unknown>,
    check: (tool: Tool) => void,
    timeout = 60_000,
  ) {
    const entry = yield* getConnection(key);
    const { client, listTools } = yield* entry.awaitReady;
    const tools = yield* listTools.pipe(Effect.tapError(() => disconnectConnection(key, entry)));
    yield* Effect.try({
      try: () => {
        if (connections.get(key) !== entry) throw Error('MCP connection is unavailable');
        const tool = tools.find((tool) => tool.name === toolName);
        if (!tool) throw Error('Unknown MCP tool');
        check(tool);
      },
      catch: configurationError,
    });
    return yield* Effect.tryPromise({
      try: (signal) =>
        client.callTool({ name: toolName, arguments: input }, undefined, { signal, timeout }),
      catch: (cause) => new McpConnectionError(message(cause), { cause }),
    }).pipe(Effect.tapError(() => disconnectConnection(key, entry)));
  });

  const readEverloot = Effect.fn('McpManager.readEverloot')(function* (
    tool: Parameters<EverlootLookup>[0],
    args: Record<string, unknown>,
    allowed: () => boolean,
  ) {
    if (!allowed()) return yield* Effect.fail(new McpConfigurationError('MCP tool disabled'));
    const result = yield* call(
      'everloot',
      tool,
      args,
      () => {
        if (!allowed()) throw Error('MCP tool disabled');
      },
      15_000,
    );
    if (result.isError || !isStructuredContent(result.structuredContent)) {
      return yield* Effect.fail(new McpConnectionError('Everloot could not answer ' + tool));
    }
    return result.structuredContent;
  });

  const disconnectConnection = Effect.fn('McpManager.disconnect')(function* (
    key: string,
    expected?: Connection<Effect.Error<ReturnType<typeof transportFor>>>,
  ) {
    const connection = yield* cacheUpdates.withPermit(
      Effect.sync(() => {
        const connection = connections.get(key);
        if (!connection || (expected && expected !== connection)) return;
        connections.delete(key);
        return connection;
      }),
    );
    if (connection) {
      yield* connection.close;
    }
  }, Effect.uninterruptible);

  function disconnect(key: string) {
    return exclusive(disconnectConnection(key));
  }

  const close = Effect.fn('McpManager.close')(function* () {
    yield* cacheUpdates.withPermit(
      Effect.sync(() => {
        closed = true;
        connections.clear();
      }),
    );
    yield* Scope.close(connectionScope, Exit.void);
  }, exclusive);

  return {
    get servers() {
      return servers;
    },
    list,
    load,
    test,
    save,
    setEnabled,
    remove,
    connect,
    discover,
    call,
    readEverloot,
    disconnect,
    close,
  };
}

export type McpManager = ReturnType<typeof make>;
export const McpManager = { make };
