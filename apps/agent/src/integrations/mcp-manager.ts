// @effect-migrated
import type { Capability } from '@wisp/protocol/capabilities';
import { mcpDefinition, mcpName, mcpSetup } from '@wisp/protocol/mcp-setup';
import {
  Array as Arr,
  Cause,
  Context,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Predicate,
  Redacted,
  Ref,
  Schema,
  Scope,
  ScopedCache,
  Semaphore,
} from 'effect';
import * as Environment from '../host/environment.ts';
import * as McpStorage from '../host/mcp-storage.ts';
import type { SavedServer } from '../host/mcp-storage.ts';
import * as McpConnection from './mcp-connection.ts';
import { McpConnectionError } from './mcp-connection.ts';
import type { McpCallResult, McpSession, McpTool } from './mcp-connection.ts';

type Setup = typeof mcpSetup.Type;
const decodeName = Schema.decodeUnknownEffect(mcpName);
const decodeSetup = Schema.decodeUnknownEffect(mcpSetup);
const decodeDefinition = Schema.decodeUnknownEffect(mcpDefinition);

/** The saved file: a JSON object of servers by name, each decoded on its own. */
const decodeSavedFile = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      servers: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
    }),
  ),
);
const decodeSavedEntry = Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Unknown));

/** What a test found and what is kept in the vault, saved beside the definition. */
const decodeSavedExtras = Schema.decodeUnknownEffect(
  Schema.Struct({
    tools: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        description: Schema.optional(Schema.String),
      }),
    ).pipe(Schema.withDecodingDefault(Effect.sync(() => []))),
    hasToken: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
    envKeys: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.sync(() => []))),
  }),
);

/** The environment secret: a JSON object of variable values by name. */
const decodeSavedEnv = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
);

export interface McpToolGroup {
  namespace: string;
  description: string;
  allow?: readonly string[];
  provided?: Record<string, unknown>;
}

export interface BundledMcp {
  definition: SavedServer;
  capabilities: readonly Capability[];
  redirect?: RequestRedirect;
  toolsTtl?: Duration.Input;
  callTimeoutMs?: number;
  /** Only the tools in the curated allowlists are trusted to be read-only. */
  trustedReadOnly?: boolean;
  toolGroups: readonly (McpToolGroup & { allow: readonly string[] })[];
}

/** A setup or switch is invalid, a tool may not be called, or the configuration did not save. */
export class McpConfigurationError extends Schema.TaggedError<McpConfigurationError>()(
  'McpConfigurationError',
  { message: Schema.String, cause: Schema.optionalKey(Schema.Defect()) },
) {}

/** A server's saved credentials could not be read or written. */
export class McpVaultError extends Schema.TaggedError<McpVaultError>()('McpVaultError', {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

/**
 * The failure's own message. A storage failure already carries the text the
 * host shows the player, such as Node's for a file or the vault's own.
 */
const messageOf = (cause: unknown) => (Predicate.isError(cause) ? cause.message : String(cause));
const configurationError = (cause: unknown) =>
  new McpConfigurationError({ message: messageOf(cause), cause });
const vaultError = (cause: unknown) => new McpVaultError({ message: messageOf(cause), cause });
const unavailable = () =>
  new McpConnectionError({ reason: 'Closed', message: 'MCP connection is unavailable' });

/** A connection evicted or closed before it opened reads as unavailable. */
const whenClosed = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.catchCause(effect, (cause): Effect.Effect<never, E | McpConnectionError> =>
    Cause.hasInterruptsOnly(cause) ? Effect.fail(unavailable()) : Effect.failCause(cause),
  );

/** An open session, the tools it listed on opening and its cached tool list. */
interface Connected {
  readonly session: McpSession;
  readonly tools: readonly McpTool[];
  readonly listTools: Effect.Effect<readonly McpTool[], McpConnectionError>;
}

/** What testing a setup found. */
export interface Probe {
  readonly tools: { name: string; description?: string | undefined }[];
  readonly count: number;
}

export interface Interface {
  /** The servers Wisp ships, which are not saved and cannot be removed. */
  readonly bundled: readonly BundledMcp[];
  /** The custom servers, as saved. */
  readonly list: () => Effect.Effect<SavedServer[]>;
  /** Reads the saved servers, adding them to the ones already known. */
  readonly load: () => Effect.Effect<void, McpConfigurationError>;
  /** Connects to a setup and lists its tools, saving nothing. */
  readonly test: (
    setup: Setup,
  ) => Effect.Effect<Probe, McpConfigurationError | McpConnectionError | McpVaultError>;
  /** Tests a setup, then saves it and its credentials, replacing its open connection. */
  readonly save: (
    setup: Setup,
  ) => Effect.Effect<Probe, McpConfigurationError | McpConnectionError | McpVaultError>;
  /** Switches a custom server on or off; switching it off closes its connection. */
  readonly setEnabled: (
    key: string,
    enabled: boolean,
  ) => Effect.Effect<void, McpConfigurationError>;
  /** Removes a custom server, its connection and its credentials. */
  readonly remove: (key: string) => Effect.Effect<void, McpConfigurationError | McpVaultError>;
  /** The tools of an enabled server, connecting to it if needed. */
  readonly discover: (
    key: string,
  ) => Effect.Effect<readonly McpTool[], McpConnectionError | McpVaultError>;
  /**
   * Calls one of a server's tools. `refuse` sees the tool as the server lists
   * it now and returns why the call may not run, or `undefined` to run it.
   * `timeout` defaults to the bundled server's own, or 60 seconds.
   */
  readonly call: (
    key: string,
    toolName: string,
    input: Readonly<Record<string, unknown>>,
    refuse: (tool: McpTool) => string | undefined,
    timeout?: Duration.Input,
  ) => Effect.Effect<McpCallResult, McpConfigurationError | McpConnectionError | McpVaultError>;
  /** Closes a server's connection; the next use opens a new one. */
  readonly disconnect: (key: string) => Effect.Effect<void>;
}

/**
 * The MCP servers: the bundled ones and the custom ones the host saves, and
 * one shared connection to each enabled server. Connections close with the
 * layer's scope.
 */
export class Service extends Context.Service<Service, Interface>()('@wisp/agent/McpManager') {}

export interface Options {
  /** Wisp's root, where stdio servers run; the working directory by default. */
  readonly root?: string;
  readonly bundled?: readonly BundledMcp[];
}

const make = Effect.fnUntraced(function* ({ root = '.', bundled = [] }: Options) {
  const connection = yield* McpConnection.Service;
  const storage = yield* McpStorage.Service;
  const builtIns = new Map(bundled.map((profile) => [profile.definition.name, profile]));
  const reservedNames = new Set(
    bundled.flatMap(({ definition, toolGroups }) => [
      definition.name,
      ...toolGroups.map(({ namespace }) => namespace.replace(/-/g, '_')),
    ]),
  );
  const servers = yield* Ref.make<Readonly<Record<string, SavedServer>>>({});
  // Saved entries that did not decode, as they were read, and the saved key
  // order: every rewrite keeps them, so a player can repair one by hand.
  const kept = yield* Ref.make<Readonly<Record<string, Schema.Json>>>({});
  const savedOrder = yield* Ref.make<readonly string[]>([]);
  const updates = yield* Semaphore.make(1);

  /** Saved changes run one at a time; a caller can cancel while waiting, but a started write finishes. */
  const exclusive = <A, E>(effect: Effect.Effect<A, E>) =>
    updates.withPermit(Effect.uninterruptible(effect));

  const customName = Effect.fnUntraced(function* (key: string) {
    const parsed = yield* decodeName(key).pipe(Effect.mapError(configurationError));
    if (reservedNames.has(parsed)) {
      return yield* new McpConfigurationError({ message: 'MCP name is reserved: ' + parsed });
    }
    return parsed;
  });

  const parseSetup = Effect.fnUntraced(function* (input: Setup) {
    const setup = yield* decodeSetup(input).pipe(Effect.mapError(configurationError));
    yield* customName(setup.server.name);
    return setup;
  });

  const readSecret = (key: string) => storage.readSecret(key).pipe(Effect.mapError(vaultError));
  const writeSecret = (key: string, value: string) =>
    storage.writeSecret(key, Redacted.make(value)).pipe(Effect.mapError(vaultError));

  const load = Effect.fn('McpManager.load')(function* () {
    const text = yield* storage.readConfig.pipe(Effect.mapError(configurationError));
    if (text === undefined) {
      return;
    }
    const file = yield* decodeSavedFile(text).pipe(Effect.mapError(configurationError));
    // A malformed entry is skipped and reported, so one bad server does not
    // keep the others, or the host, from starting. It stays in the file.
    yield* Ref.set(savedOrder, Object.keys(file.servers ?? {}));
    const loaded = yield* Effect.forEach(Object.entries(file.servers ?? {}), ([key, saved]) =>
      Effect.gen(function* () {
        const name = yield* customName(key);
        const entry = yield* decodeSavedEntry(saved).pipe(Effect.mapError(configurationError));
        const definition = yield* decodeDefinition({ ...entry, name }).pipe(
          Effect.mapError(configurationError),
        );
        const extras = yield* decodeSavedExtras(entry).pipe(Effect.mapError(configurationError));
        return [key, { ...definition, ...extras }] as const;
      }).pipe(
        Effect.map(Option.some),
        Effect.catchTag('McpConfigurationError', (error) =>
          Effect.logWarning('Skipped a malformed saved MCP server').pipe(
            Effect.annotateLogs({
              event: 'mcp.config.entry_invalid',
              server: key,
              reason: error.message,
            }),
            Effect.andThen(Ref.update(kept, (current) => ({ ...current, [key]: saved }))),
            Effect.as(Option.none()),
          ),
        ),
      ),
    ).pipe(Effect.map(Arr.getSomes));
    yield* Ref.update(servers, (current) => ({ ...current, ...Object.fromEntries(loaded) }));
  }, exclusive);

  const list = Effect.fn('McpManager.list')(function* () {
    return Object.values(yield* Ref.get(servers)).map((s) => ({ ...s, args: [...s.args] }));
  });

  /** The bearer token and environment a server connects with. */
  const credentialsFor = Effect.fn('McpManager.credentialsFor')(function* (
    server: SavedServer,
    token?: string,
    providedEnv?: Readonly<Record<string, string>>,
  ) {
    const secret =
      token !== undefined
        ? Redacted.make(token)
        : server.hasToken
          ? yield* readSecret('mcp:' + server.name + ':token')
          : server.tokenEnv
            ? Option.getOrUndefined(
                yield* Environment.secret(server.tokenEnv).pipe(Effect.mapError(vaultError)),
              )
            : undefined;
    let env = providedEnv;
    if (env === undefined && server.envKeys?.length) {
      const stored = Redacted.value(yield* readSecret('mcp:' + server.name + ':env'));
      // The decode failure names values, so only the fact that it failed is kept.
      env = yield* decodeSavedEnv(stored || '{}').pipe(
        Effect.mapError(
          () =>
            new McpVaultError({
              message: 'Saved environment for ' + server.name + ' is not valid',
            }),
        ),
      );
    }
    return { secret, env: env ?? {} };
  });

  /** Opens a session and lists its tools, both within 15 seconds. */
  const openSession = Effect.fnUntraced(
    function* (
      server: SavedServer,
      credentials: Effect.Success<ReturnType<typeof credentialsFor>>,
      redirect?: RequestRedirect,
      toolsTtl?: Duration.Input,
    ) {
      const session = yield* connection.open(server, credentials.secret, credentials.env, {
        root,
        redirect,
      });
      const listTools =
        toolsTtl !== undefined
          ? yield* Effect.cachedWithTTL(session.tools, (exit) =>
              Exit.isSuccess(exit) ? toolsTtl : Duration.zero,
            )
          : yield* Effect.cached(session.tools);
      const tools = yield* listTools;
      return { session, tools, listTools } satisfies Connected;
    },
    Effect.timeout('15 seconds'),
    Effect.catchTag('TimeoutError', (cause) =>
      Effect.fail(new McpConnectionError({ reason: 'Timeout', message: cause.message, cause })),
    ),
  );

  /** A bundled server, or an enabled custom one, by key. */
  const enabledServer = Effect.fnUntraced(function* (key: string) {
    const profile = builtIns.get(key);
    const server = profile?.definition ?? (yield* Ref.get(servers))[key];
    if (!server?.enabled) {
      return yield* unavailable();
    }
    return { server, profile };
  });

  const open = Effect.fn('McpManager.open')(function* (key: string) {
    const { server, profile } = yield* enabledServer(key);
    const credentials = yield* credentialsFor(server);
    return yield* openSession(server, credentials, profile?.redirect, profile?.toolsTtl);
  });

  // One connection per key. Callers of the same key share an open in flight;
  // a failed open is not kept, so the next caller tries again.
  const connections = yield* ScopedCache.makeWith<
    string,
    Connected,
    McpConnectionError | McpVaultError
  >({
    capacity: Number.POSITIVE_INFINITY,
    lookup: (key: string) =>
      Effect.gen(function* () {
        const entry = yield* Scope.Scope;
        // What the open acquires lives in its own scope, released as soon as opening fails.
        const resources = yield* Scope.fork(entry, 'sequential');
        // Evicting the entry interrupts an open in flight, then releases what it acquired.
        const opening = yield* open(key).pipe(
          Scope.provide(resources),
          Effect.onError((cause) => Scope.close(resources, Exit.failCause(cause))),
          Effect.forkIn(entry),
        );
        return yield* Fiber.join(opening);
      }),
    timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
  });

  const connected = Effect.fnUntraced(function* (key: string) {
    yield* enabledServer(key);
    return yield* whenClosed(ScopedCache.get(connections, key));
  });

  /** Closes `entry` if it is still the key's connection; a newer one stays. */
  const evict = (key: string, entry: Connected) =>
    ScopedCache.invalidateWhen(connections, key, (current) => current === entry).pipe(
      Effect.asVoid,
    );

  /** Closes the key's connection and waits for it to close; a closed manager has none. */
  const disconnectConnection = (key: string) =>
    ScopedCache.invalidate(connections, key).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.failCause(cause),
      ),
    );

  const probe = Effect.fn('McpManager.probe')(function* (setup: Setup) {
    const server = { ...(yield* Ref.get(servers))[setup.server.name], ...setup.server };
    const credentials = yield* credentialsFor(server, setup.token, setup.env);
    const { tools } = yield* Effect.scoped(openSession(server, credentials));
    return {
      tools: tools.map((t) => ({ name: t.name, description: t.description })),
      count: tools.length,
    };
  });

  /**
   * Writes `next` with the entries that did not decode, in the saved order. A
   * server saved under a broken entry's name, or removed by it, replaces it.
   */
  const persist = Effect.fn('McpManager.persist')(function* (
    next: Readonly<Record<string, SavedServer>>,
    removed?: string,
  ) {
    const rest = Object.fromEntries(
      Object.entries(yield* Ref.get(kept)).filter(
        ([name]) => !Object.hasOwn(next, name) && name !== removed,
      ),
    );
    const all: Readonly<Record<string, SavedServer | Schema.Json>> = { ...rest, ...next };
    const order = (yield* Ref.get(savedOrder)).filter((name) => Object.hasOwn(all, name));
    const written = Object.fromEntries(
      [...order, ...Object.keys(all).filter((name) => !order.includes(name))].flatMap((name) => {
        const entry = all[name];
        return entry === undefined ? [] : [[name, entry] as const];
      }),
    );
    yield* storage.writeConfig(written).pipe(Effect.mapError(configurationError));
    yield* Ref.set(servers, next);
    yield* Ref.set(kept, rest);
    yield* Ref.set(savedOrder, Object.keys(written));
  });

  const saveTestedSetup = Effect.fn('McpManager.saveTestedSetup')(function* (
    setup: Setup,
    tools: SavedServer['tools'],
  ) {
    const key = setup.server.name;
    if (setup.token !== undefined) {
      yield* writeSecret('mcp:' + key + ':token', setup.token);
    }
    if (setup.env !== undefined) {
      yield* writeSecret('mcp:' + key + ':env', JSON.stringify(setup.env));
    }
    const current = yield* Ref.get(servers);
    const old = current[key];
    const definition = {
      ...setup.server,
      tools,
      hasToken: setup.token !== undefined ? !!setup.token : old?.hasToken,
      envKeys: setup.env !== undefined ? Object.keys(setup.env) : old?.envKeys,
    };
    yield* persist({ ...current, [key]: definition });
    yield* disconnectConnection(key);
  }, exclusive);

  const test = Effect.fn('McpManager.test')(function* (input: Setup) {
    return yield* probe(yield* parseSetup(input));
  });

  const save = Effect.fn('McpManager.save')(function* (input: Setup) {
    const setup = yield* parseSetup(input);
    const tested = yield* probe(setup);
    yield* saveTestedSetup(setup, tested.tools);
    return tested;
  });

  const setEnabled = Effect.fn('McpManager.setEnabled')(function* (key: string, enabled: boolean) {
    yield* customName(key);
    if (!Predicate.isBoolean(enabled)) {
      return yield* new McpConfigurationError({ message: 'Invalid MCP switch' });
    }
    const current = yield* Ref.get(servers);
    const server = current[key];
    if (!server) {
      return yield* new McpConfigurationError({ message: 'Unknown MCP connection' });
    }
    if (server.enabled !== enabled) {
      yield* persist({ ...current, [key]: { ...server, enabled } });
      if (!enabled) {
        yield* disconnectConnection(key);
      }
    }
  }, exclusive);

  const remove = Effect.fn('McpManager.remove')(function* (key: string) {
    yield* customName(key);
    const next = Object.fromEntries(
      Object.entries(yield* Ref.get(servers)).filter(([name]) => name !== key),
    );
    yield* persist(next, key);
    yield* disconnectConnection(key);
    yield* writeSecret('mcp:' + key + ':token', '');
    yield* writeSecret('mcp:' + key + ':env', '');
  }, exclusive);

  const discover = Effect.fn('McpManager.discover')(function* (key: string) {
    const entry = yield* connected(key);
    return yield* entry.listTools.pipe(Effect.tapError(() => evict(key, entry)));
  });

  const call = Effect.fn('McpManager.call')(function* (
    key: string,
    toolName: string,
    input: Readonly<Record<string, unknown>>,
    refuse: (tool: McpTool) => string | undefined,
    timeout?: Duration.Input,
  ) {
    const entry = yield* connected(key);
    const tools = yield* entry.listTools.pipe(Effect.tapError(() => evict(key, entry)));
    const current = yield* ScopedCache.getSuccess(connections, key);
    if (Option.getOrUndefined(current) !== entry) {
      return yield* new McpConfigurationError({ message: 'MCP connection is unavailable' });
    }
    const tool = tools.find((tool) => tool.name === toolName);
    if (!tool) {
      return yield* new McpConfigurationError({ message: 'Unknown MCP tool' });
    }
    const refusal = refuse(tool);
    if (refusal !== undefined) {
      return yield* new McpConfigurationError({ message: refusal });
    }
    return yield* entry.session
      .callTool(toolName, input, timeout ?? builtIns.get(key)?.callTimeoutMs ?? 60_000)
      .pipe(Effect.tapError(() => evict(key, entry)));
  });

  const disconnect = Effect.fn('McpManager.disconnect')(function* (key: string) {
    yield* exclusive(disconnectConnection(key));
  });

  return Service.of({
    bundled,
    list,
    load,
    test,
    save,
    setEnabled,
    remove,
    discover,
    call,
    disconnect,
  });
});

/** Needs the host's `McpStorage` and an `McpConnection` to open servers with. */
export const layer = (options: Options = {}) => Layer.effect(Service, make(options));
