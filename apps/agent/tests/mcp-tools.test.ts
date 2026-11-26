import { afterEach, expect, test, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Effect, Exit, Fiber, Scope } from 'effect';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { setAgentHost } from '../src/host/agent-host.ts';
import { AgentCapabilities, layerFromFile } from '../src/host/capabilities.ts';
import * as Mcp from '../src/integrations/mcp-tools.ts';
import { gate } from './gate.ts';

afterEach(() => setAgentHost(undefined));

const readConnections = (config: string) =>
  Effect.runPromise(
    Effect.flatMap(AgentCapabilities, (settings) =>
      Effect.flatMap(settings.read, (capabilities) =>
        Mcp.mcpConnections(capabilities, () => config),
      ),
    ).pipe(Effect.provide(layerFromFile()), Effect.provide(NodeFileSystem.layer)),
  );

const connections = { test: { url: 'http://127.0.0.1:1/mcp', description: 'Test' } };

test('concurrent turns share the MCP handshake and tool discovery', async () => {
  const connecting = gate();
  const connected = gate();
  const connect = vi.spyOn(Client.prototype, 'connect').mockImplementation(() => {
    connecting.open();
    return connected.promise;
  });
  const list = vi.spyOn(Client.prototype, 'listTools').mockResolvedValue({
    tools: [{ name: 'lookup', inputSchema: { type: 'object' } }],
  });
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const mcp = yield* Mcp.make();
          const first = yield* Effect.forkChild(mcp.tools(connections));
          yield* Effect.promise(() => connecting.promise);
          const second = yield* Effect.forkChild(mcp.tools(connections), {
            startImmediately: true,
          });
          connected.open();
          for (const turn of [first, second]) {
            const result = yield* Fiber.join(turn);
            expect(result.map((tool) => tool.name)).toEqual(['test__lookup']);
          }
          expect(connect).toHaveBeenCalledTimes(1);
          expect(list).toHaveBeenCalledTimes(1);
        }),
      ),
    );
  } finally {
    connected.open();
    connect.mockRestore();
    list.mockRestore();
  }
});

test('closing the scope interrupts a pending handshake and waits for the client to close', async () => {
  const connecting = gate();
  const closing = gate();
  const closed = gate();
  const connect = vi
    .spyOn(Client.prototype, 'connect')
    .mockImplementation((_transport, options) => {
      const signal = options?.signal;
      if (!signal) throw new Error('Expected a cancellable handshake');
      return new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        });
        connecting.open();
      });
    });
  const close = vi.spyOn(Client.prototype, 'close').mockImplementation(() => {
    closing.open();
    return closed.promise;
  });
  const scope = Scope.makeUnsafe();
  try {
    const mcp = await Effect.runPromise(Mcp.make().pipe(Effect.provideService(Scope.Scope, scope)));
    const listing = Effect.runPromise(mcp.tools(connections));
    await connecting.promise;
    let shutdownFinished = false;
    const shutdown = Effect.runPromise(Scope.close(scope, Exit.void)).then(() => {
      shutdownFinished = true;
    });
    await closing.promise;
    expect(connect.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(shutdownFinished).toBe(false);
    closed.open();
    await shutdown;
    expect(await listing).toEqual([]);
    expect(close.mock.contexts).toEqual(connect.mock.contexts);
    expect(await Effect.runPromise(mcp.tools(connections))).toEqual([]);
  } finally {
    closed.open();
    await Effect.runPromise(Scope.close(scope, Exit.void));
    connect.mockRestore();
    close.mockRestore();
  }
});

test('a failed discovery closes the client and the next turn reconnects', async () => {
  const connect = vi.spyOn(Client.prototype, 'connect').mockResolvedValue(undefined);
  const close = vi.spyOn(Client.prototype, 'close').mockResolvedValue(undefined);
  const list = vi
    .spyOn(Client.prototype, 'listTools')
    .mockRejectedValueOnce(new Error('Discovery unavailable'))
    .mockResolvedValue({ tools: [{ name: 'lookup', inputSchema: { type: 'object' } }] });
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const mcp = yield* Mcp.make();
          expect(yield* mcp.tools(connections)).toEqual([]);
          expect(close.mock.contexts).toEqual([connect.mock.contexts[0]]);
          const tools = yield* mcp.tools(connections);
          expect(tools.map((tool) => tool.name)).toEqual(['test__lookup']);
          expect(connect).toHaveBeenCalledTimes(2);
          expect(connect.mock.contexts[1]).not.toBe(connect.mock.contexts[0]);
        }),
      ),
    );
    expect(close.mock.contexts).toEqual(connect.mock.contexts);
  } finally {
    connect.mockRestore();
    close.mockRestore();
    list.mockRestore();
  }
});

test('relayed MCP servers become namespaced, filtered tools through the MCP SDK client', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'wisp-mcp-tools-'));
  const authorizations: (string | undefined)[] = [];
  const calls: unknown[] = [];
  // Stands in for the bridge's MCP relay at /mcp/<name>.
  const http = createServer(async (req, res) => {
    authorizations.push(req.headers.authorization);
    const server = new Server({ name: 'relay', version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: ['lookup', 'blocked_tool'].map((name) => ({
        name,
        description: 'Fixture ' + name,
        inputSchema: {
          type: 'object' as const,
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      calls.push(request.params);
      return { content: [{ type: 'text', text: 'found ' + request.params.arguments?.query }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + (http.address() as { port: number }).port;
  const flags = path.join(directory, 'capabilities.json');
  const config = path.join(directory, 'mcp.json');
  await writeFile(
    flags,
    JSON.stringify({
      enabled: { 'mcp:everloot': false, 'mcp_tool:my_tools:blocked_tool': false },
    }),
  );
  await writeFile(
    config,
    JSON.stringify({ servers: { my_tools: { enabled: true, description: 'Player tools' } } }),
  );
  setAgentHost({ origin, token: 'relay-token', capabilitiesFile: flags });
  const scope = Scope.makeUnsafe();
  try {
    const mcp = await Effect.runPromise(Mcp.make().pipe(Effect.provideService(Scope.Scope, scope)));
    const tools = await Effect.runPromise(mcp.tools(await readConnections(config)));
    expect(tools.map((tool) => tool.name)).toEqual(['my-tools__lookup']);
    const [lookup] = tools;
    expect(lookup!.description).toBe('Player tools\nFixture lookup');
    expect(lookup!.inputSchema).toMatchObject({
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    });
    expect(await lookup!.call({ query: 'nova' }, AbortSignal.timeout(10000))).toMatchObject({
      content: [{ type: 'text', text: 'found nova' }],
    });
    expect(calls).toEqual([
      expect.objectContaining({ name: 'lookup', arguments: { query: 'nova' } }),
    ]);
    // The relay sees the bridge token on every request.
    expect(authorizations.length).toBeGreaterThan(0);
    expect(new Set(authorizations)).toEqual(new Set(['Bearer relay-token']));
    // Turning the server off drops it on the next turn.
    await writeFile(
      flags,
      JSON.stringify({ enabled: { 'mcp:everloot': false, 'mcp:my_tools': false } }),
    );
    expect(await Effect.runPromise(mcp.tools(await readConnections(config)))).toEqual([]);
    await expect(lookup!.call({ query: 'nova' }, AbortSignal.timeout(10000))).rejects.toThrow(
      'MCP connection is unavailable',
    );
    expect(calls).toHaveLength(1);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    http.close();
    await rm(directory, { recursive: true, force: true });
  }
});
