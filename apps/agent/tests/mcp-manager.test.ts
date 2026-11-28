import { assert, describe, it, layer } from '@effect/vitest';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { mcpSetup } from '@wisp/protocol/mcp-setup';
import {
  ConfigProvider,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Path,
  Predicate,
  Redacted,
  Ref,
  Schema,
  Scope,
} from 'effect';
import { createServer } from 'node:http';
import { delimiter, dirname, join } from 'node:path';
import * as AgentConfig from '../src/host/agent-config.ts';
import * as Capabilities from '../src/host/capabilities.ts';
import * as McpStorage from '../src/host/mcp-storage.ts';
import * as Everloot from '../src/integrations/everloot.ts';
import * as McpConnection from '../src/integrations/mcp-connection.ts';
import * as McpManager from '../src/integrations/mcp-manager.ts';
import * as Mcp from '../src/integrations/mcp-tools.ts';

const parseSetup = Schema.decodeUnknownSync(mcpSetup);

/** The SDK adapter in a source checkout: none of the agent's variables are set. */
const sdkConnection = McpConnection.layer.pipe(
  Layer.provide(AgentConfig.layer),
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
);

/** What a host saved, kept in memory. */
interface Saved {
  readonly config: Ref.Ref<string | undefined>;
  readonly secrets: Ref.Ref<ReadonlyMap<string, string>>;
}

const makeSaved = (config?: string) =>
  Effect.all({
    config: Ref.make(config),
    secrets: Ref.make<ReadonlyMap<string, string>>(new Map()),
  });

/** Saves like the host: the servers as `{ servers }` JSON, the secrets by key. */
const memoryStorage = (saved: Saved) =>
  Layer.succeed(
    McpStorage.Service,
    McpStorage.Service.of({
      readConfig: Ref.get(saved.config),
      writeConfig: (servers) => Ref.set(saved.config, JSON.stringify({ servers })),
      readSecret: (key) =>
        Ref.get(saved.secrets).pipe(Effect.map((secrets) => Redacted.make(secrets.get(key) ?? ''))),
      writeSecret: (key, value) =>
        Ref.update(saved.secrets, (secrets) => new Map(secrets).set(key, Redacted.value(value))),
    }),
  );

const savedServers = (...names: string[]) =>
  JSON.stringify({
    servers: Object.fromEntries(
      names.map((name) => [name, { name, url: 'https://example.com/mcp', args: [] }]),
    ),
  });

type Attempt = 'open' | 'fail' | 'hang';

interface FakeOptions {
  /** How each open goes, in order; the ones past the list open. */
  readonly attempts?: readonly Attempt[];
  readonly tools?: readonly McpConnection.McpTool[];
  /** Runs when a session is released, before it reads as released. */
  readonly release?: Effect.Effect<void>;
  /** Calls wait for this, then fail. */
  readonly failCallsAfter?: Deferred.Deferred<void>;
}

/** An `McpConnection` that opens numbered sessions and logs what happens to them. */
const fakeConnection = Effect.fnUntraced(function* (options: FakeOptions = {}) {
  const log = yield* Ref.make<readonly string[]>([]);
  const calls = yield* Ref.make<readonly { session: number; params: unknown; timeout: number }[]>(
    [],
  );
  const hanging = yield* Deferred.make<void>();
  const calling = yield* Deferred.make<void>();
  const opens = yield* Ref.make(0);
  const record = (event: string) => Ref.update(log, (events) => [...events, event]);
  const layer = Layer.succeed(
    McpConnection.Service,
    McpConnection.Service.of({
      open: () =>
        Effect.gen(function* () {
          const session = yield* Ref.updateAndGet(opens, (count) => count + 1);
          yield* Effect.acquireRelease(record(`open ${session}`), () =>
            (options.release ?? Effect.void).pipe(Effect.andThen(record(`release ${session}`))),
          );
          const attempt = options.attempts?.[session - 1] ?? 'open';
          if (attempt === 'fail') {
            return yield* new McpConnection.McpConnectionError({
              reason: 'Protocol',
              message: 'Handshake failed',
            });
          }
          if (attempt === 'hang') {
            yield* Deferred.succeed(hanging, undefined);
            return yield* Effect.never.pipe(
              Effect.onInterrupt(() => record(`interrupt ${session}`)),
            );
          }
          return {
            tools: record(`list ${session}`).pipe(Effect.as(options.tools ?? [])),
            callTool: (name, args, timeout) =>
              Effect.gen(function* () {
                yield* Ref.update(calls, (all) => [
                  ...all,
                  {
                    session,
                    params: { name, arguments: args },
                    timeout: Duration.toMillis(timeout),
                  },
                ]);
                if (options.failCallsAfter) {
                  yield* Deferred.succeed(calling, undefined);
                  yield* Deferred.await(options.failCallsAfter);
                  return yield* new McpConnection.McpConnectionError({
                    reason: 'Transport',
                    message: 'Call failed',
                  });
                }
                return { content: [], structuredContent: { items: [] } };
              }),
          } satisfies McpConnection.McpSession;
        }),
    }),
  );
  return { layer, log: Ref.get(log), calls: Ref.get(calls), hanging, calling };
});

const managerOn = <E1, E2>(
  connection: Layer.Layer<McpConnection.Service, E1>,
  storage: Layer.Layer<McpStorage.Service, E2>,
  options?: McpManager.Options,
) => McpManager.layer(options).pipe(Layer.provide([connection, storage]));

const capabilities = { enabled: () => true, disabledMcpTools: () => [] };
const capabilitiesLayer = Layer.succeed(
  Capabilities.Service,
  Capabilities.Service.of({
    read: Effect.succeed(capabilities),
    featureEnabled: () => Effect.succeed(false),
  }),
);

/** The model's MCP tools for a session, under a host policy, from the manager in context. */
const modelTools = (policy: Mcp.McpPolicy) => (session: string) =>
  Effect.flatMap(Mcp.Mcp, (mcp) => mcp.tools(session, capabilities)).pipe(
    Effect.provide(Mcp.layerWithPolicy(policy).pipe(Layer.provide(capabilitiesLayer))),
  );

const failureMessage = (cause: unknown) => (Predicate.isError(cause) ? cause.message : undefined);

/** A Streamable HTTP MCP server on a local port with one tool, closed with the scope. */
const httpServer = Effect.fnUntraced(function* () {
  const authorizations: (string | undefined)[] = [];
  const http = createServer((req, res) => {
    authorizations.push(req.headers.authorization);
    const server = new Server({ name: 'test', version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: [{ name: 'lookup', inputSchema: { type: 'object' } }],
    }));
    server.setRequestHandler(CallToolRequestSchema, () => ({
      content: [{ type: 'text', text: 'found' }],
    }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    void server.connect(transport).then(() => transport.handleRequest(req, res));
  });
  yield* Effect.acquireRelease(
    Effect.callback<void>((resume) => {
      http.listen(0, '127.0.0.1', () => resume(Effect.void));
    }),
    () =>
      Effect.callback<void>((resume) => {
        http.closeAllConnections();
        http.close(() => resume(Effect.void));
      }),
  );
  const address = http.address();
  assert.ok(address && typeof address === 'object');
  return { url: `http://127.0.0.1:${address.port}/upstream`, authorizations };
});

/** An SDK module's URL, for a server script to import. */
const sdk = (module: string) =>
  JSON.stringify(import.meta.resolve(`@modelcontextprotocol/sdk/${module}`));

/** Writes a stdio MCP server script into a temporary folder that goes with the scope. */
const stdioScript = Effect.fnUntraced(function* (body: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: 'wow-mcp-' });
  const script = path.join(root, 'server.mjs');
  yield* fs.writeFileString(
    script,
    `
import { Server } from ${sdk('server/index.js')};
import { StdioServerTransport } from ${sdk('server/stdio.js')};
import { ListToolsRequestSchema, CallToolRequestSchema } from ${sdk('types.js')};
${body}
await server.connect(new StdioServerTransport());
`,
  );
  return { root, script };
});

layer(NodeServices.layer)('McpManager with the SDK', (it) => {
  it.effect(
    'stdio MCP settings and agent tools share one manager and enforce live, session-specific policy',
    () =>
      Effect.gen(function* () {
        const echoSchema = {
          type: 'object',
          properties: { value: { anyOf: [{ type: 'string' }, { type: 'number' }] } },
        };
        const { root, script } = yield* stdioScript(`
const server = new Server({ name: 'Test', version: '1' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'echo', description: 'Echo', inputSchema: ${JSON.stringify(echoSchema)}, annotations: { readOnlyHint: true } },
    { name: 'write', inputSchema: { type: 'object', properties: {} } },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async () => ({
  content: [{
    type: 'text',
    text: JSON.stringify({
      ok: process.env.TEST_SECRET === 'private-test-value',
      bridgeTokenLeaked: !!process.env.WOW_BRIDGE_TOKEN,
    }),
  }],
}));
`);
        const saved = yield* makeSaved();
        yield* Effect.gen(function* () {
          const manager = yield* McpManager.Service;
          yield* manager.load();
          const input = parseSetup({
            server: { name: 'test_server', transport: 'stdio', command: 'node', args: [script] },
            env: { TEST_SECRET: 'private-test-value' },
          });
          let serverAllowed = true;
          let toolsAllowed = true;
          let readOnlySession = 'automatic';
          const list = modelTools({
            allowed: (name, tool) =>
              name === 'test_server' && serverAllowed && (tool === undefined || toolsAllowed),
            readOnly: (session) => session === readOnlySession,
          });
          assert.strictEqual((yield* manager.save(input)).count, 2);
          assert.ok(!(yield* Ref.get(saved.config))?.includes('private-test-value'));
          assert.ok((yield* Ref.get(saved.secrets)).size > 0);
          const tools = yield* list('manual');
          assert.deepStrictEqual(
            tools.map((tool) => tool.name),
            ['test-server__echo', 'test-server__write'],
          );
          const [echo, write] = tools;
          assert.ok(echo && write);
          assert.deepStrictEqual(echo.inputSchema, echoSchema);
          assert.deepStrictEqual(
            (yield* list('automatic')).map((tool) => tool.name),
            ['test-server__echo'],
          );
          assert.deepStrictEqual(yield* echo.call({}), {
            content: [
              { type: 'text', text: JSON.stringify({ ok: true, bridgeTokenLeaked: false }) },
            ],
          });
          // A different automatic session must not block a manual write.
          yield* write.call({});
          readOnlySession = 'manual';
          assert.strictEqual(
            failureMessage((yield* Effect.flip(write.call({}))).cause),
            'Only explicitly read-only MCP tools are available during automatic advice',
          );
          toolsAllowed = false;
          assert.deepStrictEqual(yield* list('manual'), []);
          assert.strictEqual(
            failureMessage((yield* Effect.flip(echo.call({}))).cause),
            'MCP tool disabled',
          );
          serverAllowed = false;
          assert.deepStrictEqual(yield* list('manual'), []);
          const savedServer = Effect.gen(function* () {
            const [server] = yield* manager.list();
            assert.ok(server, 'test_server is saved');
            return server;
          });
          yield* manager.setEnabled('test_server', false);
          assert.strictEqual((yield* savedServer).enabled, false);
          assert.match(
            (yield* Effect.flip(manager.discover('test_server'))).message,
            /unavailable/,
          );
          const savedTools = (yield* savedServer).tools;
          yield* manager.setEnabled('test_server', true);
          assert.deepStrictEqual(
            (yield* savedServer).tools,
            savedTools,
            'switching preserves discovery',
          );
          assert.strictEqual(
            (yield* Ref.get(saved.secrets)).get('mcp:test_server:env'),
            JSON.stringify(input.env),
          );
          assert.strictEqual((yield* manager.discover('test_server'))[0]?.name, 'echo');
          yield* manager.remove('test_server');
          assert.strictEqual((yield* manager.list()).length, 0);
          assert.strictEqual((yield* Ref.get(saved.secrets)).get('mcp:test_server:env'), '');
        }).pipe(Effect.provide(managerOn(sdkConnection, memoryStorage(saved), { root })));
      }).pipe(Effect.scoped),
    30_000,
  );

  it.effect('configured HTTP servers are called directly using the saved token', () =>
    Effect.gen(function* () {
      const http = yield* httpServer();
      const saved = yield* makeSaved();
      yield* Effect.gen(function* () {
        const manager = yield* McpManager.Service;
        yield* manager.save(
          parseSetup({
            server: { name: 'http_test', url: http.url },
            token: 'private-test-token',
          }),
        );
        const tools = yield* modelTools({
          allowed: (name) => name === 'http_test',
          readOnly: () => false,
        })('manual');
        assert.deepStrictEqual(
          tools.map((tool) => tool.name),
          ['http-test__lookup'],
        );
        const [lookup] = tools;
        assert.ok(lookup);
        assert.deepStrictEqual(yield* lookup.call({}), {
          content: [{ type: 'text', text: 'found' }],
        });
        assert.deepStrictEqual([...new Set(http.authorizations)], ['Bearer private-test-token']);
      }).pipe(Effect.provide(managerOn(sdkConnection, memoryStorage(saved))));
    }).pipe(Effect.scoped),
  );

  it.effect('an HTTP server without a saved token sends the variable its configuration names', () =>
    Effect.gen(function* () {
      const http = yield* httpServer();
      const tokenEnv = 'WISP_TEST_MCP_TOKEN';
      yield* Effect.gen(function* () {
        const manager = yield* McpManager.Service;
        const probe = (environment: Record<string, string>) =>
          manager
            .test(parseSetup({ server: { name: 'env_test', url: http.url, tokenEnv } }))
            .pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(environment))));
        assert.strictEqual((yield* probe({ [tokenEnv]: 'env-test-token' })).count, 1);
        assert.deepStrictEqual([...new Set(http.authorizations)], ['Bearer env-test-token']);
        // An empty or unset variable sends no credentials.
        http.authorizations.length = 0;
        yield* probe({ [tokenEnv]: '' });
        yield* probe({});
        assert.deepStrictEqual([...new Set(http.authorizations)], [undefined]);
      }).pipe(Effect.provide(managerOn(sdkConnection, McpStorage.layerNone)));
    }).pipe(Effect.scoped),
  );

  it.effect(
    'a stdio server inherits the set variables, with the bundled runtimes first on PATH',
    () =>
      Effect.gen(function* () {
        // The server reports what it inherited as its only tool's description.
        const { root, script } = yield* stdioScript(`
const inherited = {
  PATH: process.env.PATH,
  ComSpec: process.env.ComSpec ?? null,
  PATHEXT: process.env.PATHEXT ?? null,
  WOW_BRIDGE_TOKEN: process.env.WOW_BRIDGE_TOKEN ?? null,
};
const server = new Server({ name: 'Test', version: '1' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: 'env', description: JSON.stringify(inherited), inputSchema: { type: 'object' } }],
}));
`);
        const environment = ConfigProvider.fromUnknown({
          PATH: 'inherited-path',
          ComSpec: 'inherited-shell',
          PATHEXT: '',
          WOW_BRIDGE_TOKEN: 'not-inherited',
        });
        const { tools } = yield* Effect.flatMap(McpManager.Service, (manager) =>
          manager
            .test(
              parseSetup({
                server: { name: 'env_test', transport: 'stdio', command: 'node', args: [script] },
              }),
            )
            .pipe(Effect.provide(ConfigProvider.layer(environment))),
        ).pipe(Effect.provide(managerOn(sdkConnection, McpStorage.layerNone, { root })));
        assert.deepStrictEqual(
          yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
            tools[0]?.description ?? '',
          ),
          {
            PATH: [join(root, 'runtime'), dirname(process.execPath), 'inherited-path'].join(
              delimiter,
            ),
            ComSpec: 'inherited-shell',
            PATHEXT: null,
            WOW_BRIDGE_TOKEN: null,
          },
        );
      }).pipe(Effect.scoped),
    30_000,
  );
});

describe('McpManager connections', () => {
  it.effect(
    'Everloot model tools and game lookups share one connection and keep Forever arguments fixed',
    () =>
      Effect.gen(function* () {
        const connection = yield* fakeConnection({
          tools: [
            'item_categories',
            'auction_history',
            'market_value',
            'search_knowledge',
            'recent_changes',
            'get_by_name',
          ].map((name) => ({
            name,
            inputSchema: {
              type: 'object',
              properties: { version: { type: 'string' }, query: { type: 'string' } },
              required: ['version', 'query'],
            },
          })),
        });
        yield* Effect.gen(function* () {
          const manager = yield* McpManager.Service;
          const [tools, data] = yield* Effect.all(
            [
              modelTools({
                allowed: (_server, tool) => tool !== 'market_value',
                readOnly: () => true,
              })('manual'),
              Everloot.read(manager, 'item_categories', { quality: 'rare' }, () => true),
            ],
            { concurrency: 'unbounded' },
          );
          assert.deepStrictEqual(data, { items: [] });
          assert.deepStrictEqual(
            tools.map((tool) => tool.name),
            [
              'everloot__item_categories',
              'everloot__auction_history',
              'everloot-search__search_knowledge',
              'everloot-changes__recent_changes',
            ],
          );
          const [, , search, changes] = tools;
          assert.ok(search && changes);
          assert.deepStrictEqual(search.inputSchema, {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          });
          yield* search.call({ version: 'retail', query: 'mage' });
          yield* changes.call({ game: 'classic' });
          assert.deepStrictEqual(yield* connection.log, ['open 1', 'list 1']);
          assert.deepStrictEqual(yield* connection.calls, [
            {
              session: 1,
              params: { name: 'item_categories', arguments: { quality: 'rare' } },
              timeout: 15_000,
            },
            {
              session: 1,
              params: {
                name: 'search_knowledge',
                arguments: { version: 'forever', query: 'mage' },
              },
              timeout: 120_000,
            },
            {
              session: 1,
              params: { name: 'recent_changes', arguments: { game: 'forever' } },
              timeout: 120_000,
            },
          ]);
        }).pipe(
          Effect.provide(
            managerOn(connection.layer, McpStorage.layerNone, { bundled: [Everloot.profile] }),
          ),
        );
      }),
  );

  it.effect(
    'disabling MCP cancels an opening connection and a later enable opens a fresh one',
    () =>
      Effect.gen(function* () {
        const connection = yield* fakeConnection({ attempts: ['hang'] });
        const saved = yield* makeSaved(savedServers('test_server'));
        yield* Effect.gen(function* () {
          const manager = yield* McpManager.Service;
          yield* manager.load();
          const first = yield* Effect.forkChild(Effect.flip(manager.discover('test_server')));
          const second = yield* Effect.forkChild(Effect.flip(manager.discover('test_server')));
          yield* Deferred.await(connection.hanging);
          yield* manager.setEnabled('test_server', false);
          for (const waiting of [first, second]) {
            assert.strictEqual(
              (yield* Fiber.join(waiting)).message,
              'MCP connection is unavailable',
            );
          }
          assert.deepStrictEqual(yield* connection.log, ['open 1', 'interrupt 1', 'release 1']);
          assert.match(
            (yield* Effect.flip(manager.discover('test_server'))).message,
            /unavailable/,
          );

          yield* manager.setEnabled('test_server', true);
          yield* manager.discover('test_server');
          yield* manager.discover('test_server');
          assert.deepStrictEqual(yield* connection.log, [
            'open 1',
            'interrupt 1',
            'release 1',
            'open 2',
            'list 2',
          ]);
        }).pipe(Effect.provide(managerOn(connection.layer, memoryStorage(saved))));
      }),
  );

  it.effect('a failed MCP opening releases what it opened and allows a fresh attempt', () =>
    Effect.gen(function* () {
      const connection = yield* fakeConnection({ attempts: ['fail'] });
      const saved = yield* makeSaved(savedServers('test_server'));
      yield* Effect.gen(function* () {
        const manager = yield* McpManager.Service;
        yield* manager.load();
        assert.strictEqual(
          (yield* Effect.flip(manager.discover('test_server'))).message,
          'Handshake failed',
        );
        assert.deepStrictEqual(yield* connection.log, ['open 1', 'release 1']);
        yield* manager.discover('test_server');
        assert.deepStrictEqual(yield* connection.log, ['open 1', 'release 1', 'open 2', 'list 2']);
      }).pipe(Effect.provide(managerOn(connection.layer, memoryStorage(saved))));
    }),
  );

  it.effect('a caller that stops waiting cancels an open nobody else waits for', () =>
    Effect.gen(function* () {
      const connection = yield* fakeConnection({ attempts: ['hang'] });
      const saved = yield* makeSaved(savedServers('test_server'));
      yield* Effect.gen(function* () {
        const manager = yield* McpManager.Service;
        yield* manager.load();
        const waiting = yield* Effect.forkChild(manager.discover('test_server'));
        yield* Deferred.await(connection.hanging);
        yield* Fiber.interrupt(waiting);
        assert.deepStrictEqual(yield* connection.log, ['open 1', 'interrupt 1', 'release 1']);
        yield* manager.discover('test_server');
        assert.deepStrictEqual((yield* connection.log).slice(3), ['open 2', 'list 2']);
      }).pipe(Effect.provide(managerOn(connection.layer, memoryStorage(saved))));
    }),
  );

  it.effect('a failed call closes only the connection it ran on', () =>
    Effect.gen(function* () {
      const failCalls = yield* Deferred.make<void>();
      const connection = yield* fakeConnection({
        tools: [{ name: 'lookup', inputSchema: { type: 'object' } }],
        failCallsAfter: failCalls,
      });
      const saved = yield* makeSaved(savedServers('test_server'));
      yield* Effect.gen(function* () {
        const manager = yield* McpManager.Service;
        yield* manager.load();
        const call = yield* Effect.forkChild(
          Effect.flip(manager.call('test_server', 'lookup', {}, () => undefined)),
        );
        yield* Deferred.await(connection.calling);
        yield* manager.disconnect('test_server');
        yield* manager.discover('test_server');
        yield* Deferred.succeed(failCalls, undefined);
        assert.strictEqual((yield* Fiber.join(call)).message, 'Call failed');
        yield* manager.discover('test_server');
        assert.deepStrictEqual(yield* connection.log, [
          'open 1',
          'list 1',
          'release 1',
          'open 2',
          'list 2',
        ]);
      }).pipe(Effect.provide(managerOn(connection.layer, memoryStorage(saved))));
    }),
  );

  it.effect('MCP shutdown waits for client cleanup and rejects new connections', () =>
    Effect.gen(function* () {
      const closing = yield* Deferred.make<void>();
      const finishClose = yield* Deferred.make<void>();
      const connection = yield* fakeConnection({
        release: Deferred.succeed(closing, undefined).pipe(
          Effect.andThen(Deferred.await(finishClose)),
        ),
      });
      const saved = yield* makeSaved(savedServers('test_server'));
      const scope = yield* Scope.make();
      const manager = Context.get(
        yield* Layer.buildWithScope(managerOn(connection.layer, memoryStorage(saved)), scope),
        McpManager.Service,
      );
      yield* manager.load();
      yield* manager.discover('test_server');
      const stopped = yield* Ref.make(false);
      const shutdown = yield* Effect.forkChild(
        Scope.close(scope, Exit.void).pipe(Effect.andThen(Ref.set(stopped, true))),
      );
      yield* Deferred.await(closing);
      assert.match((yield* Effect.flip(manager.discover('test_server'))).message, /unavailable/);
      assert.strictEqual(yield* Ref.get(stopped), false);
      assert.deepStrictEqual(yield* connection.log, ['open 1', 'list 1']);
      yield* Deferred.succeed(finishClose, undefined);
      yield* Fiber.join(shutdown);
      assert.deepStrictEqual(yield* connection.log, ['open 1', 'list 1', 'release 1']);
    }),
  );
});

describe('McpManager settings', () => {
  it.effect('concurrent MCP updates preserve both changes after an earlier update fails', () =>
    Effect.gen(function* () {
      const connection = yield* fakeConnection();
      const saved = yield* makeSaved(savedServers('first', 'second'));
      const manager = managerOn(connection.layer, memoryStorage(saved));
      yield* Effect.gen(function* () {
        const servers = yield* McpManager.Service;
        yield* servers.load();
        const [missing] = yield* Effect.all(
          [
            Effect.flip(servers.setEnabled('missing', false)),
            servers.setEnabled('first', false),
            servers.setEnabled('second', false),
          ],
          { concurrency: 'unbounded' },
        );
        assert.match(missing.message, /Unknown MCP connection/);
      }).pipe(Effect.provide(manager));
      const restored = yield* Effect.gen(function* () {
        const servers = yield* McpManager.Service;
        yield* servers.load();
        return yield* servers.list();
      }).pipe(Effect.provide(manager));
      assert.deepStrictEqual(
        restored.map(({ name, enabled }) => [name, enabled]),
        [
          ['first', false],
          ['second', false],
        ],
      );
    }),
  );

  it.effect('a missing MCP config loads no custom servers and a malformed file fails', () =>
    Effect.gen(function* () {
      const connection = yield* fakeConnection();
      const saved = yield* makeSaved();
      yield* Effect.gen(function* () {
        const manager = yield* McpManager.Service;
        yield* manager.load();
        assert.deepStrictEqual(yield* manager.list(), []);
        for (const text of ['invalid JSON', '[]', '{"servers":5}']) {
          yield* Ref.set(saved.config, text);
          const error = yield* Effect.flip(manager.load());
          assert.strictEqual(error._tag, 'McpConfigurationError');
        }
        assert.deepStrictEqual(yield* manager.list(), []);
      }).pipe(Effect.provide(managerOn(connection.layer, memoryStorage(saved))));
    }),
  );

  it.effect('a malformed saved server is skipped and the others still load', () =>
    Effect.gen(function* () {
      const connection = yield* fakeConnection();
      const good = { url: 'https://example.com/mcp', tools: [{ name: 'echo' }], hasToken: true };
      const saved = yield* makeSaved(
        JSON.stringify({
          servers: {
            first: good,
            bad_url: { url: 'ftp://example.com/mcp' },
            bad_tools: { url: 'https://example.com/mcp', tools: 'echo' },
            bad_token_flag: { url: 'https://example.com/mcp', hasToken: 'yes' },
            bad_env_keys: { url: 'https://example.com/mcp', envKeys: [1] },
            not_an_object: 5,
            wisp: { url: 'https://example.com/mcp' },
            second: { url: 'https://example.com/mcp', envKeys: ['API_KEY'] },
          },
        }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* McpManager.Service;
        yield* manager.load();
        const servers = yield* manager.list();
        assert.deepStrictEqual(
          servers.map(({ name, tools, hasToken, envKeys }) => [name, tools, hasToken, envKeys]),
          [
            ['first', [{ name: 'echo' }], true, []],
            ['second', [], false, ['API_KEY']],
          ],
        );
      }).pipe(Effect.provide(managerOn(connection.layer, memoryStorage(saved))));
    }),
  );

  it.effect('a malformed saved environment fails the open without naming its values', () =>
    Effect.gen(function* () {
      const connection = yield* fakeConnection();
      const config = JSON.stringify({
        servers: { test_server: { url: 'https://example.com/mcp', envKeys: ['API_KEY'] } },
      });
      const saved = yield* makeSaved(config);
      yield* Effect.gen(function* () {
        const manager = yield* McpManager.Service;
        yield* manager.load();
        for (const secret of ['{"API_KEY":"hunter2",', '{"API_KEY":42}', '["hunter2"]']) {
          yield* Ref.update(saved.secrets, (all) =>
            new Map(all).set('mcp:test_server:env', secret),
          );
          const error = yield* Effect.flip(manager.discover('test_server'));
          assert.strictEqual(error._tag, 'McpVaultError');
          assert.strictEqual(error.message, 'Saved environment for test_server is not valid');
        }
        assert.deepStrictEqual(yield* connection.log, []);
        yield* Ref.update(saved.secrets, (all) =>
          new Map(all).set('mcp:test_server:env', '{"API_KEY":"hunter2"}'),
        );
        yield* manager.discover('test_server');
        assert.deepStrictEqual(yield* connection.log, ['open 1', 'list 1']);
      }).pipe(Effect.provide(managerOn(connection.layer, memoryStorage(saved))));
    }),
  );

  it.effect('the manager reserves bundled MCP names and their model namespaces', () =>
    Effect.gen(function* () {
      const connection = yield* fakeConnection();
      yield* Effect.gen(function* () {
        const manager = yield* McpManager.Service;
        for (const name of ['everloot', 'everloot_search', 'everloot_changes']) {
          const input = parseSetup({ server: { name, url: 'https://example.com/mcp' } });
          assert.match((yield* Effect.flip(manager.test(input))).message, /MCP name is reserved/);
          assert.match((yield* Effect.flip(manager.save(input))).message, /MCP name is reserved/);
        }
        assert.deepStrictEqual(yield* connection.log, []);
      }).pipe(
        Effect.provide(
          managerOn(connection.layer, McpStorage.layerNone, { bundled: [Everloot.profile] }),
        ),
      );
    }),
  );

  it('MCP setup rejects embedded URL credentials and keeps command arguments structured', () => {
    assert.throws(() =>
      parseSetup({ server: { name: 'test', url: 'https://user:secret@example.com/mcp' } }),
    );
    for (const name of ['wow', 'questie', 'wisp']) {
      assert.throws(() => parseSetup({ server: { name, url: 'https://example.com/mcp' } }));
    }
    assert.strictEqual(
      parseSetup({
        server: {
          name: 'test',
          transport: 'stdio',
          command: 'node',
          args: ['literal; not a shell'],
        },
      }).server.args[0],
      'literal; not a shell',
    );
  });
});
