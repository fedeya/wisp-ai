import { assert, layer } from '@effect/vitest';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type ListToolsResult,
} from '@modelcontextprotocol/sdk/types.js';
import { mcpDefinition } from '@wisp/protocol/mcp-setup';
import { ConfigProvider, Deferred, Effect, Fiber, FileSystem, Layer, Path, Redacted } from 'effect';
import { Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import * as AgentConfig from '../src/host/agent-config.ts';
import * as McpConnection from '../src/integrations/mcp-connection.ts';

/** A source checkout's settings: none of the agent's variables are set. */
const connectionLayer = McpConnection.layer.pipe(
  Layer.provide(AgentConfig.layer),
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
);

const definition = Schema.decodeUnknownSync(mcpDefinition);

const echoSchema = {
  type: 'object' as const,
  properties: { value: { anyOf: [{ type: 'string' }, { type: 'number' }] } },
};

const defaultTools: ListToolsResult['tools'] = [
  {
    name: 'echo',
    description: 'Echo',
    inputSchema: echoSchema,
    annotations: { readOnlyHint: true },
  },
  { name: 'fail', inputSchema: { type: 'object' } },
  { name: 'hang', inputSchema: { type: 'object' } },
];

interface ServerOptions {
  readonly transport?: 'http' | 'sse';
  /** Answers each page of the tool list. */
  readonly listTools?: (cursor: string | undefined) => ListToolsResult;
  /** Holds every request without answering. */
  readonly silent?: boolean;
}

/** An MCP server on a local HTTP port, closed with the test's scope. */
const mcpServer = Effect.fnUntraced(function* (options: ServerOptions = {}) {
  const requests: { method: string | undefined; authorization: string | undefined }[] = [];
  const requested = yield* Deferred.make<void>();
  const hanging = yield* Deferred.make<void>();
  const cancelled = yield* Deferred.make<void>();
  const makeServer = () => {
    const server = new Server({ name: 'Test', version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, (request) =>
      (options.listTools ?? (() => ({ tools: defaultTools })))(request.params?.cursor),
    );
    server.setRequestHandler(CallToolRequestSchema, (request, extra) => {
      switch (request.params.name) {
        case 'echo':
          return {
            content: [{ type: 'text', text: String(request.params.arguments?.value) }],
            structuredContent: { value: request.params.arguments?.value },
          };
        case 'fail':
          return { content: [{ type: 'text', text: 'It failed' }], isError: true };
        default:
          Deferred.doneUnsafe(hanging, Effect.void);
          return new Promise((_resolve, reject) => {
            extra.signal.addEventListener('abort', () => {
              Deferred.doneUnsafe(cancelled, Effect.void);
              reject(Error('Cancelled'));
            });
          });
      }
    });
    return server;
  };
  const streamable = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
  yield* Effect.promise(() => makeServer().connect(streamable));
  const sse = new Map<string, SSEServerTransport>();
  const http = createServer((req, res) => {
    requests.push({ method: req.method, authorization: req.headers.authorization });
    Deferred.doneUnsafe(requested, Effect.void);
    if (options.silent) return;
    if (options.transport !== 'sse') {
      void streamable.handleRequest(req, res);
    } else if (req.method === 'GET') {
      const transport = new SSEServerTransport('/messages', res);
      sse.set(transport.sessionId, transport);
      void makeServer().connect(transport);
    } else {
      const id = new URL(req.url ?? '', 'http://localhost').searchParams.get('sessionId') ?? '';
      void sse.get(id)?.handlePostMessage(req, res);
    }
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
  const url = `http://127.0.0.1:${address.port}/${options.transport === 'sse' ? 'sse' : 'mcp'}`;
  return { url, requests, requested, hanging, cancelled };
});

const openHttp = Effect.fnUntraced(function* (
  url: string,
  options: { transport?: 'http' | 'sse'; token?: string } = {},
) {
  const connection = yield* McpConnection.Service;
  return yield* connection.open(
    definition({ name: 'test_server', url, transport: options.transport ?? 'http' }),
    options.token === undefined ? undefined : Redacted.make(options.token),
    {},
    { root: '.' },
  );
});

const failure = <A, R>(effect: Effect.Effect<A, McpConnection.McpConnectionError, R>) =>
  Effect.flip(effect);

layer(Layer.mergeAll(connectionLayer, NodeServices.layer))('McpConnection', (it) => {
  it.effect('lists a Streamable HTTP server’s tools and calls them with the bearer token', () =>
    Effect.gen(function* () {
      const server = yield* mcpServer();
      const session = yield* openHttp(server.url, { token: 'private-test-token' });
      assert.deepStrictEqual(yield* session.tools, [
        {
          name: 'echo',
          description: 'Echo',
          inputSchema: echoSchema,
          annotations: { readOnlyHint: true },
        },
        { name: 'fail', inputSchema: { type: 'object' } },
        { name: 'hang', inputSchema: { type: 'object' } },
      ]);
      assert.deepStrictEqual(yield* session.callTool('echo', { value: 'hi' }, '5 seconds'), {
        content: [{ type: 'text', text: 'hi' }],
        structuredContent: { value: 'hi' },
      });
      assert.deepStrictEqual(
        [...new Set(server.requests.map(({ authorization }) => authorization))],
        ['Bearer private-test-token'],
      );
    }).pipe(Effect.scoped),
  );

  it.effect('a tool that reports an error returns it as a result', () =>
    Effect.gen(function* () {
      const server = yield* mcpServer();
      const session = yield* openHttp(server.url);
      assert.deepStrictEqual(yield* session.callTool('fail', {}, '5 seconds'), {
        content: [{ type: 'text', text: 'It failed' }],
        isError: true,
      });
      assert.deepStrictEqual(
        server.requests.map(({ authorization }) => authorization),
        server.requests.map(() => undefined),
      );
    }).pipe(Effect.scoped),
  );

  it.effect('an SSE server receives the bearer token on its event stream and its posts', () =>
    Effect.gen(function* () {
      const server = yield* mcpServer({ transport: 'sse' });
      const session = yield* openHttp(server.url, { transport: 'sse', token: 'sse-token' });
      assert.deepStrictEqual(
        (yield* session.tools).map(({ name }) => name),
        ['echo', 'fail', 'hang'],
      );
      assert.deepStrictEqual(
        (yield* session.callTool('echo', { value: 1 }, '5 seconds')).structuredContent,
        { value: 1 },
      );
      assert.deepStrictEqual(
        [
          ...new Set(
            server.requests.map(({ method, authorization }) => `${method} ${authorization}`),
          ),
        ],
        ['GET Bearer sse-token', 'POST Bearer sse-token'],
      );
    }).pipe(Effect.scoped),
  );

  it.effect('pages through the tools and leaves out the pages past the tenth', () =>
    Effect.gen(function* () {
      const server = yield* mcpServer({
        listTools: (cursor) => {
          const page = Number(cursor ?? 0);
          return {
            tools: [{ name: `tool_${page}`, inputSchema: { type: 'object' } }],
            nextCursor: String(page + 1),
          };
        },
      });
      const session = yield* openHttp(server.url);
      assert.deepStrictEqual(
        (yield* session.tools).map(({ name }) => name),
        Array.from({ length: 10 }, (_, page) => `tool_${page}`),
      );
    }).pipe(Effect.scoped),
  );

  it.effect('a server with more than 1000 tools fails with Limit', () =>
    Effect.gen(function* () {
      const server = yield* mcpServer({
        listTools: () => ({
          tools: Array.from({ length: 1001 }, (_, index) => ({
            name: `tool_${index}`,
            inputSchema: { type: 'object' as const },
          })),
        }),
      });
      const session = yield* openHttp(server.url);
      const error = yield* failure(session.tools);
      assert.strictEqual(error.reason, 'Limit');
      assert.strictEqual(error.message, 'MCP exposes too many tools');
    }).pipe(Effect.scoped),
  );

  it.effect('a call past its timeout fails with Timeout', () =>
    Effect.gen(function* () {
      const server = yield* mcpServer();
      const session = yield* openHttp(server.url);
      const error = yield* failure(session.callTool('hang', {}, '100 millis'));
      assert.strictEqual(error.reason, 'Timeout');
    }).pipe(Effect.scoped),
  );

  it.effect('interrupting a call cancels it on the server', () =>
    Effect.gen(function* () {
      const server = yield* mcpServer();
      const session = yield* openHttp(server.url);
      const call = yield* Effect.forkChild(session.callTool('hang', {}, '1 minute'));
      yield* Deferred.await(server.hanging);
      yield* Fiber.interrupt(call);
      yield* Deferred.await(server.cancelled);
    }).pipe(Effect.scoped),
  );

  it.effect('an opening that takes 15 seconds fails with Timeout', () =>
    Effect.gen(function* () {
      const server = yield* mcpServer({ silent: true });
      const opening = yield* Effect.forkChild(Effect.scoped(failure(openHttp(server.url))));
      yield* Deferred.await(server.requested);
      yield* TestClock.adjust('15 seconds');
      const error = yield* Fiber.join(opening);
      assert.strictEqual(error.reason, 'Timeout');
    }).pipe(Effect.scoped),
  );

  it.effect('a server that cannot be reached fails with Transport', () =>
    Effect.gen(function* () {
      // Nothing listens on the discard port of the loopback interface.
      const error = yield* failure(openHttp('http://127.0.0.1:9/mcp'));
      assert.strictEqual(error.reason, 'Transport');
    }).pipe(Effect.scoped),
  );

  it.effect(
    'a stdio server runs with the given environment and stops with the scope',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: 'wisp-mcp-' });
        const script = path.join(root, 'server.mjs');
        const sdk = (module: string) =>
          JSON.stringify(import.meta.resolve(`@modelcontextprotocol/sdk/${module}`));
        yield* fs.writeFileString(
          script,
          `
import { Server } from ${sdk('server/index.js')};
import { StdioServerTransport } from ${sdk('server/stdio.js')};
import { ListToolsRequestSchema, CallToolRequestSchema } from ${sdk('types.js')};

const server = new Server({ name: 'Test', version: '1' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: 'secret', inputSchema: { type: 'object' } }],
}));
server.setRequestHandler(CallToolRequestSchema, async () => ({
  content: [{ type: 'text', text: process.env.TEST_SECRET ?? '' }],
}));
await server.connect(new StdioServerTransport());
`,
        );
        const connection = yield* McpConnection.Service;
        const session = yield* Effect.scoped(
          Effect.gen(function* () {
            const session = yield* connection.open(
              definition({
                name: 'test_server',
                transport: 'stdio',
                command: 'node',
                args: [script],
              }),
              undefined,
              { TEST_SECRET: 'private-test-value' },
              { root },
            );
            assert.deepStrictEqual(
              (yield* session.tools).map(({ name }) => name),
              ['secret'],
            );
            assert.deepStrictEqual(yield* session.callTool('secret', {}, '5 seconds'), {
              content: [{ type: 'text', text: 'private-test-value' }],
            });
            return session;
          }),
        );
        yield* failure(session.callTool('secret', {}, '5 seconds'));
      }).pipe(Effect.scoped),
    30_000,
  );
});
