import { test, vi } from 'vitest';
import { Effect, Layer, Schema } from 'effect';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { McpManager, mcpSetup, type McpStorage } from '../src/integrations/mcp-manager.ts';
import * as Mcp from '../src/integrations/mcp-tools.ts';
import * as Everloot from '../src/integrations/everloot.ts';
import * as Capabilities from '../src/host/capabilities.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createServer } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

function makeManager(
  file: string,
  root: string,
  vault: Pick<McpStorage, 'readSecret' | 'writeSecret'>,
) {
  return McpManager.make(root, {
    ...vault,
    async readConfig() {
      try {
        return await readFile(file, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return undefined;
      }
    },
    writeConfig: (servers) => writeFile(file, JSON.stringify({ servers })),
  });
}

const parseSetup = Schema.decodeUnknownSync(mcpSetup);
const capabilities = { enabled: () => true, disabledMcpTools: () => [] };

function listTools(
  manager: McpManager,
  allowed: (name: string, tool?: string) => boolean,
  readOnly: (session: string) => boolean = () => false,
) {
  const layer = Mcp.layerFromManager(manager, { allowed, readOnly }).pipe(
    Layer.provide(
      Layer.succeed(Capabilities.Service, {
        read: Effect.succeed(capabilities),
        featureEnabled: () => Effect.succeed(false),
      }),
    ),
  );
  return (session: string) =>
    Effect.runPromise(
      Effect.flatMap(Mcp.Mcp, (mcp) => mcp.tools(session, capabilities)).pipe(
        Effect.provide(layer),
      ),
    );
}

test(
  'stdio MCP settings and agent tools share one manager and enforce live, session-specific policy',
  { timeout: 30000 },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'wow-mcp-'));
    const secrets = new Map<string, string>();
    const vault = {
      readSecret: async (k: string) => secrets.get(k) || '',
      writeSecret: async (k: string, v: string) => {
        secrets.set(k, v);
      },
    };
    const file = path.join(root, 'mcp.json');
    const manager = makeManager(file, root, vault);
    await Effect.runPromise(manager.load());
    const script = path.join(root, 'server.mjs');
    const echoSchema = {
      type: 'object',
      properties: { value: { anyOf: [{ type: 'string' }, { type: 'number' }] } },
    };
    await writeFile(
      script,
      `
import { Server } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/index.js'))};
import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/stdio.js'))};
import { ListToolsRequestSchema, CallToolRequestSchema } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/types.js'))};

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
await server.connect(new StdioServerTransport());
`,
    );
    const input = parseSetup({
      server: { name: 'test_server', transport: 'stdio', command: 'node', args: [script] },
      env: { TEST_SECRET: 'private-test-value' },
    });
    let serverAllowed = true;
    let toolsAllowed = true;
    let readOnlySession = 'automatic';
    const list = listTools(
      manager,
      (name, tool) =>
        name === 'test_server' && serverAllowed && (tool === undefined || toolsAllowed),
      (session) => session === readOnlySession,
    );
    try {
      assert.equal((await Effect.runPromise(manager.save(input))).count, 2);
      assert.ok(!(await readFile(file, 'utf8')).includes('private-test-value'));
      assert.ok(secrets.size > 0);
      const tools = await list('manual');
      assert.deepEqual(
        tools.map((tool) => tool.name),
        ['test-server__echo', 'test-server__write'],
      );
      const [echo, write] = tools;
      assert.ok(echo && write);
      assert.deepEqual(echo.inputSchema, echoSchema);
      assert.deepEqual(
        (await list('automatic')).map((tool) => tool.name),
        ['test-server__echo'],
      );
      assert.deepEqual(await Effect.runPromise(echo.call({})), {
        content: [{ type: 'text', text: JSON.stringify({ ok: true, bridgeTokenLeaked: false }) }],
      });
      // A different automatic session must not block a manual write.
      await Effect.runPromise(write.call({}));
      readOnlySession = 'manual';
      await assert.rejects(
        Effect.runPromise(write.call({})),
        (error: Error) =>
          error.cause instanceof Error &&
          error.cause.message ===
            'Only explicitly read-only MCP tools are available during automatic advice',
      );
      toolsAllowed = false;
      assert.deepEqual(await list('manual'), []);
      await assert.rejects(
        Effect.runPromise(echo.call({})),
        (error: Error) =>
          error.cause instanceof Error && error.cause.message === 'MCP tool disabled',
      );
      serverAllowed = false;
      assert.deepEqual(await list('manual'), []);
      const savedServer = () => {
        const [server] = manager.list();
        assert.ok(server, 'test_server is saved');
        return server;
      };
      await Effect.runPromise(manager.setEnabled('test_server', false));
      assert.equal(savedServer().enabled, false);
      await assert.rejects(Effect.runPromise(manager.connect('test_server')), /unavailable/);
      const savedTools = savedServer().tools;
      await Effect.runPromise(manager.setEnabled('test_server', true));
      assert.deepEqual(savedServer().tools, savedTools, 'switching preserves discovery');
      assert.equal(secrets.get('mcp:test_server:env'), JSON.stringify(input.env));
      const reopened = await Effect.runPromise(manager.connect('test_server'));
      assert.equal(reopened.tools[0]?.name, 'echo');
      await Effect.runPromise(manager.remove('test_server'));
      assert.equal(manager.list().length, 0);
      assert.equal(secrets.get('mcp:test_server:env'), '');
    } finally {
      await Effect.runPromise(manager.close());
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('Everloot model tools and game lookups share one connection and keep Forever arguments fixed', async () => {
  const manager = McpManager.make('.', undefined, [Everloot.profile]);
  using connect = vi.spyOn(Client.prototype, 'connect').mockResolvedValue(undefined);
  using discover = vi.spyOn(Client.prototype, 'listTools').mockResolvedValue({
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
  using call = vi.spyOn(Client.prototype, 'callTool').mockResolvedValue({
    content: [],
    structuredContent: { items: [] },
  });
  const list = listTools(
    manager,
    (_server, tool) => tool !== 'market_value',
    () => true,
  );
  try {
    const [tools, data] = await Promise.all([
      list('manual'),
      Effect.runPromise(Everloot.read(manager, 'item_categories', { quality: 'rare' }, () => true)),
    ]);
    assert.deepEqual(data, { items: [] });
    assert.deepEqual(
      tools.map((tool) => tool.name),
      [
        'everloot__item_categories',
        'everloot__auction_history',
        'everloot-search__search_knowledge',
        'everloot-changes__recent_changes',
      ],
    );
    const search = tools[2]!;
    assert.deepEqual(search.inputSchema, {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    });
    await Effect.runPromise(search.call({ version: 'retail', query: 'mage' }));
    await Effect.runPromise(tools[3]!.call({ game: 'classic' }));
    assert.equal(connect.mock.calls.length, 1);
    assert.equal(discover.mock.calls.length, 1);
    assert.equal(
      call.mock.contexts.every((client) => client === connect.mock.contexts[0]),
      true,
    );
    assert.deepEqual(
      call.mock.calls.map(([, , options]) => options?.timeout),
      [15_000, 120_000, 120_000],
    );
    assert.deepEqual(
      call.mock.calls.map(([params]) => params),
      [
        { name: 'item_categories', arguments: { quality: 'rare' } },
        { name: 'search_knowledge', arguments: { version: 'forever', query: 'mage' } },
        { name: 'recent_changes', arguments: { game: 'forever' } },
      ],
    );
  } finally {
    await Effect.runPromise(manager.close());
  }
});

test('configured HTTP servers are called directly using the saved token', async () => {
  const requests: (string | undefined)[] = [];
  const http = createServer(async (req, res) => {
    requests.push(req.headers.authorization);
    const server = new Server({ name: 'test', version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: 'lookup', inputSchema: { type: 'object' } }],
    }));
    server.setRequestHandler(CallToolRequestSchema, async () => ({
      content: [{ type: 'text', text: 'found' }],
    }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });
  const secrets = new Map<string, string>();
  const manager = McpManager.make('.', {
    readConfig: async () => undefined,
    writeConfig: async () => {},
    readSecret: async (key) => secrets.get(key) ?? '',
    writeSecret: async (key, value) => {
      secrets.set(key, value);
    },
  });
  try {
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const address = http.address();
    assert.ok(address && typeof address === 'object');
    await Effect.runPromise(
      manager.save(
        parseSetup({
          server: { name: 'http_test', url: `http://127.0.0.1:${address.port}/upstream` },
          token: 'private-test-token',
        }),
      ),
    );
    const tools = await listTools(manager, (name) => name === 'http_test')('manual');
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ['http-test__lookup'],
    );
    assert.deepEqual(await Effect.runPromise(tools[0]!.call({})), {
      content: [{ type: 'text', text: 'found' }],
    });
    assert.deepEqual([...new Set(requests)], ['Bearer private-test-token']);
  } finally {
    await Effect.runPromise(manager.close());
    http.close();
  }
});

test('disabling MCP cancels an opening connection and a later enable opens a fresh client', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wow-mcp-'));
  const manager = makeManager(path.join(root, 'mcp.json'), root, {
    readSecret: async () => '',
    writeSecret: async () => {},
  });
  let onOpening!: (signal: AbortSignal | undefined) => void;
  const opening = new Promise<AbortSignal | undefined>((resolve) => {
    onOpening = resolve;
  });
  let finishHandshake!: () => void;
  const handshake = new Promise<void>((resolve) => {
    finishHandshake = resolve;
  });
  using connect = vi
    .spyOn(Client.prototype, 'connect')
    .mockImplementationOnce((_transport, options) => {
      onOpening(options?.signal);
      return handshake;
    })
    .mockResolvedValue(undefined);
  using close = vi.spyOn(Client.prototype, 'close').mockResolvedValue(undefined);
  using listTools = vi.spyOn(Client.prototype, 'listTools').mockResolvedValue({ tools: [] });
  manager.servers.test_server = parseSetup({
    server: { name: 'test_server', url: 'https://example.com/mcp' },
  }).server;
  try {
    const cancelled = assert.rejects(Effect.runPromise(manager.connect('test_server')));
    const signal = await opening;
    assert.ok(signal);
    const alsoCancelled = assert.rejects(Effect.runPromise(manager.connect('test_server')));
    await Effect.runPromise(manager.setEnabled('test_server', false));
    await Promise.all([cancelled, alsoCancelled]);
    assert.equal(signal.aborted, true);
    assert.equal(connect.mock.calls.length, 1);
    assert.deepEqual(close.mock.contexts, [connect.mock.contexts[0]]);
    await assert.rejects(Effect.runPromise(manager.connect('test_server')), /unavailable/);

    await Effect.runPromise(manager.setEnabled('test_server', true));
    const { client } = await Effect.runPromise(manager.connect('test_server'));
    assert.notEqual(client, connect.mock.contexts[0]);
    finishHandshake();
    await handshake;
    assert.equal((await Effect.runPromise(manager.connect('test_server'))).client, client);
    assert.deepEqual(listTools.mock.contexts, [client]);
  } finally {
    finishHandshake();
    await Effect.runPromise(manager.close());
    await rm(root, { recursive: true, force: true });
  }
});

test('a failed MCP opening releases the client and allows a fresh attempt', async () => {
  const manager = McpManager.make();
  using connect = vi
    .spyOn(Client.prototype, 'connect')
    .mockRejectedValueOnce(Error('Handshake failed'))
    .mockResolvedValue(undefined);
  using close = vi.spyOn(Client.prototype, 'close').mockResolvedValue(undefined);
  using listTools = vi.spyOn(Client.prototype, 'listTools').mockResolvedValue({ tools: [] });
  manager.servers.test_server = parseSetup({
    server: { name: 'test_server', url: 'https://example.com/mcp' },
  }).server;
  try {
    await assert.rejects(Effect.runPromise(manager.connect('test_server')), {
      message: 'Handshake failed',
    });
    assert.deepEqual(close.mock.contexts, [connect.mock.contexts[0]]);
    const { client } = await Effect.runPromise(manager.connect('test_server'));
    assert.notEqual(client, connect.mock.contexts[0]);
    assert.deepEqual(listTools.mock.contexts, [client]);
  } finally {
    await Effect.runPromise(manager.close());
  }
});

test('concurrent MCP updates preserve both changes after an earlier update fails', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wow-mcp-'));
  const vault = { readSecret: async () => '', writeSecret: async () => {} };
  const file = path.join(root, 'mcp.json');
  const manager = makeManager(file, root, vault);
  try {
    for (const name of ['first', 'second']) {
      manager.servers[name] = parseSetup({
        server: { name, url: 'https://example.com/mcp' },
      }).server;
    }
    await Promise.all([
      assert.rejects(
        Effect.runPromise(manager.setEnabled('missing', false)),
        /Unknown MCP connection/,
      ),
      Effect.runPromise(manager.setEnabled('first', false)),
      Effect.runPromise(manager.setEnabled('second', false)),
    ]);
    const restored = makeManager(file, root, vault);
    await Effect.runPromise(restored.load());
    assert.deepEqual(
      restored.list().map(({ name, enabled }) => [name, enabled]),
      [
        ['first', false],
        ['second', false],
      ],
    );
    await Effect.runPromise(restored.close());
  } finally {
    await Effect.runPromise(manager.close());
    await rm(root, { recursive: true, force: true });
  }
});

test('a missing MCP config loads no custom servers and malformed JSON fails', async () => {
  let config: string | undefined;
  const manager = McpManager.make('.', {
    readConfig: async () => config,
    writeConfig: async () => {},
    readSecret: async () => '',
    writeSecret: async () => {},
  });
  try {
    await Effect.runPromise(manager.load());
    assert.deepEqual(manager.list(), []);
    config = 'invalid JSON';
    await assert.rejects(
      Effect.runPromise(manager.load()),
      (error: Error) => error.cause instanceof SyntaxError,
    );
  } finally {
    await Effect.runPromise(manager.close());
  }
});

test('MCP shutdown waits for client cleanup and rejects new connections', async () => {
  const manager = McpManager.make();
  let onClosing!: () => void;
  const closing = new Promise<void>((resolve) => {
    onClosing = resolve;
  });
  let finishClose!: () => void;
  const release = new Promise<void>((resolve) => {
    finishClose = resolve;
  });
  using connect = vi.spyOn(Client.prototype, 'connect').mockResolvedValue(undefined);
  using listTools = vi.spyOn(Client.prototype, 'listTools').mockResolvedValue({ tools: [] });
  using close = vi.spyOn(Client.prototype, 'close').mockImplementation(async () => {
    onClosing();
    await release;
  });
  manager.servers.test_server = parseSetup({
    server: { name: 'test_server', url: 'https://example.com/mcp' },
  }).server;
  try {
    const { client } = await Effect.runPromise(manager.connect('test_server'));
    let stopped = false;
    const shutdown = Effect.runPromise(manager.close()).then(() => {
      stopped = true;
    });
    await closing;
    await assert.rejects(Effect.runPromise(manager.connect('test_server')), /unavailable/);
    assert.equal(stopped, false);
    assert.equal(connect.mock.calls.length, 1);
    assert.deepEqual(listTools.mock.contexts, [client]);
    assert.deepEqual(close.mock.contexts, [client]);
    finishClose();
    await shutdown;
  } finally {
    finishClose();
    await Effect.runPromise(manager.close());
  }
});

test('MCP setup rejects embedded URL credentials and keeps command arguments structured', () => {
  assert.throws(() =>
    parseSetup({ server: { name: 'test', url: 'https://user:secret@example.com/mcp' } }),
  );
  for (const name of ['wow', 'questie', 'wisp']) {
    assert.throws(() => parseSetup({ server: { name, url: 'https://example.com/mcp' } }));
  }
  assert.equal(
    parseSetup({
      server: { name: 'test', transport: 'stdio', command: 'node', args: ['literal; not a shell'] },
    }).server.args[0],
    'literal; not a shell',
  );
});

test('the manager reserves bundled MCP names and their model namespaces', async () => {
  const manager = McpManager.make('.', undefined, [Everloot.profile]);
  try {
    for (const name of ['everloot', 'everloot_search', 'everloot_changes']) {
      const input = parseSetup({ server: { name, url: 'https://example.com/mcp' } });
      await assert.rejects(Effect.runPromise(manager.test(input)), /MCP name is reserved/);
      await assert.rejects(Effect.runPromise(manager.save(input)), /MCP name is reserved/);
    }
  } finally {
    await Effect.runPromise(manager.close());
  }
});
