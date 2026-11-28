import { Effect, Exit, Option, Redacted, Schema, Scope, Semaphore, type Duration } from 'effect';
import { mcpName as name, mcpDefinition, mcpSetup } from '@wisp/protocol/mcp-setup';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { Capability } from '@wisp/protocol/capabilities';
import { McpConnection, McpConnectionError } from './mcp-connection.ts';
import type { Connection } from './mcp-connection.ts';
import { AgentConfig } from '../host/agent-config.ts';
import * as Environment from '../host/environment.ts';
export { mcpDefinition, mcpSetup };
export type MCPDefinition = typeof mcpDefinition.Type & {
  tools?: { name: string; description?: string }[];
  hasToken?: boolean;
  envKeys?: string[];
};
type Setup = typeof mcpSetup.Type;
const decodeName = Schema.decodeUnknownSync(name);
const decodeSetup = Schema.decodeUnknownSync(mcpSetup);
const decodeDefinition = Schema.decodeUnknownSync(mcpDefinition);

export interface McpStorage {
  readConfig(): Promise<string | undefined>;
  writeConfig(servers: Record<string, MCPDefinition>): Promise<void>;
  readSecret(key: string): Promise<string>;
  writeSecret(key: string, value: string): Promise<void>;
}

export interface McpToolGroup {
  namespace: string;
  description: string;
  allow?: readonly string[];
  provided?: Record<string, unknown>;
}

export interface BundledMcp {
  definition: MCPDefinition;
  capabilities: readonly Capability[];
  redirect?: RequestRedirect;
  toolsTtl?: Duration.Input;
  callTimeoutMs?: number;
  /** Only the tools in the curated allowlists are trusted to be read-only. */
  trustedReadOnly?: boolean;
  toolGroups: readonly (McpToolGroup & { allow: readonly string[] })[];
}

class McpConfigurationError extends Error {
  readonly _tag = 'McpConfigurationError';
}

class McpVaultError extends Error {
  readonly _tag = 'McpVaultError';
}

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const configurationError = (cause: unknown) => new McpConfigurationError(message(cause), { cause });
const vaultError = (cause: unknown) => new McpVaultError(message(cause), { cause });

const make = Effect.fnUntraced(function* (
  root = '.',
  storage?: McpStorage,
  bundled: readonly BundledMcp[] = [],
) {
  const { packagedEngine } = yield* AgentConfig;
  const builtIns = new Map(bundled.map((profile) => [profile.definition.name, profile]));
  const reservedNames = new Set(
    bundled.flatMap(({ definition, toolGroups }) => [
      definition.name,
      ...toolGroups.map(({ namespace }) => namespace.replace(/-/g, '_')),
    ]),
  );
  function customName(key: string) {
    const parsed = decodeName(key);
    if (reservedNames.has(parsed)) throw Error('MCP name is reserved: ' + parsed);
    return parsed;
  }
  function parseSetup(input: Setup) {
    const setup = decodeSetup(input);
    customName(setup.server.name);
    return setup;
  }
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
              ...decodeDefinition({ ...s, name: customName(key) }),
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
    redirect?: RequestRedirect,
  ) {
    const secret =
      token !== undefined
        ? Redacted.make(token)
        : server.hasToken
          ? Redacted.make(yield* readSecret('mcp:' + server.name + ':token'))
          : server.tokenEnv
            ? Option.getOrUndefined(
                yield* Environment.secret(server.tokenEnv).pipe(Effect.mapError(vaultError)),
              )
            : undefined;
    let env = providedEnv;
    if (env === undefined && server.envKeys?.length) {
      const stored = yield* readSecret('mcp:' + server.name + ':env');
      env = yield* Effect.try({
        try: () => JSON.parse(stored || '{}') as Record<string, string>,
        catch: vaultError,
      });
    }
    return yield* McpConnection.makeTransport({
      root,
      server,
      secret,
      env: env ?? {},
      packagedEngine,
      redirect,
    });
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
      try: () => parseSetup(input),
      catch: configurationError,
    });
    return yield* probe(parsed);
  });

  const save = Effect.fn('McpManager.save')(function* (input: Setup) {
    const parsed = yield* Effect.try({
      try: () => parseSetup(input),
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
    yield* Effect.try({ try: () => customName(key), catch: configurationError });
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
    yield* Effect.try({ try: () => customName(key), catch: configurationError });
    const next = { ...servers };
    delete next[key];
    yield* persist(next);
    yield* disconnectConnection(key);
    yield* writeSecret('mcp:' + key + ':token', '');
    yield* writeSecret('mcp:' + key + ':env', '');
  }, exclusive);

  const getConnection = Effect.fn('McpManager.getConnection')(
    function* (key: string) {
      const profile = builtIns.get(key);
      const server = profile?.definition ?? servers[key];
      if (closed || !server?.enabled) {
        return yield* Effect.fail(new McpConnectionError('MCP connection is unavailable'));
      }
      const existing = connections.get(key);
      if (existing) {
        return existing;
      }
      const connection = McpConnection.make({
        scope: connectionScope,
        transport: transportFor(server, undefined, undefined, profile?.redirect),
        toolsTtl: profile?.toolsTtl,
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
    timeout = builtIns.get(key)?.callTimeoutMs ?? 60_000,
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
    bundled,
    load,
    test,
    save,
    setEnabled,
    remove,
    connect,
    discover,
    call,
    disconnect,
    close,
  };
});

export type McpManager = Effect.Success<ReturnType<typeof make>>;
export const McpManager = { make };
