import { test, vi } from 'vitest';
import { Effect } from 'effect';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { McpManager, mcpSetup } from '../src/integrations/mcp/mcp-manager.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createServer } from 'node:http';
import { createAgentHandler } from '../src/agent/agent-server.ts';
import { McpRelay } from '../src/integrations/mcp/mcp-relay.ts';
import { runBridgeEffect } from './capture-logs.ts';
test(
  'stdio MCP setup tests real tools, encrypts through the vault interface and gates relay calls',
  { timeout: 30000 },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'wow-mcp-'));
    const secrets = new Map<string, string>();
    const vault = {
      read: async (k: string) => secrets.get(k) || '',
      write: async (k: string, v: string) => {
        secrets.set(k, v);
      },
    };
    const file = path.join(root, 'mcp.json');
    const manager = McpManager.make(file, root, vault);
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
    const input = mcpSetup.parse({
      server: { name: 'test_server', transport: 'stdio', command: 'node', args: [script] },
      env: { TEST_SECRET: 'private-test-value' },
    });
    let serverAllowed = true;
    let toolsAllowed = true;
    const relay = runBridgeEffect(
      McpRelay.make(
        manager,
        (_name, tool) => serverAllowed && (tool === undefined || toolsAllowed),
      ),
    );
    const http = createServer(
      runBridgeEffect(
        createAgentHandler({ token: 'test', mcpRelay: relay } as Parameters<
          typeof createAgentHandler
        >[0]),
      ),
    );
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
    const port = (http.address() as { port: number }).port;
    const url = new URL(`http://127.0.0.1:${port}/mcp/test_server`);
    const authorization = 'Bearer test';
    const accept = 'application/json, text/event-stream';
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization } },
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        if (init?.method === 'POST' && response.status === 200) {
          assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/);
        }
        return response;
      },
    });
    const client = new Client({ name: 'test', version: '1' }, { capabilities: {} });
    try {
      assert.equal((await Effect.runPromise(manager.save(input))).count, 2);
      assert.ok(!(await readFile(file, 'utf8')).includes('private-test-value'));
      assert.ok(secrets.size > 0);
      const forbidden = await fetch(url, { headers: { accept } });
      assert.equal(forbidden.status, 403);
      assert.equal(await forbidden.text(), 'Forbidden');
      await client.connect(transport);
      const sessionId = transport.sessionId;
      assert.ok(sessionId);
      const { tools } = await client.listTools();
      assert.deepEqual(
        tools.map((tool) => tool.name),
        ['echo', 'write'],
      );
      assert.deepEqual(tools[0].inputSchema, echoSchema);
      relay.readOnlyMode = () => true;
      assert.deepEqual(
        (await client.listTools()).tools.map((tool) => tool.name),
        ['echo'],
      );
      await assert.rejects(
        client.callTool({ name: 'write', arguments: {} }),
        /Only explicitly read-only MCP tools/,
      );
      const result = await client.callTool({ name: 'echo', arguments: {} });
      assert.deepEqual(result.content, [
        { type: 'text', text: JSON.stringify({ ok: true, bridgeTokenLeaked: false }) },
      ]);
      toolsAllowed = false;
      assert.deepEqual((await client.listTools()).tools, []);
      await assert.rejects(client.callTool({ name: 'echo', arguments: {} }), /MCP tool disabled/);
      serverAllowed = false;
      const disabled = await fetch(url, { headers: { authorization, accept } });
      assert.equal(disabled.status, 403);
      assert.equal(await disabled.text(), 'MCP disabled');
      serverAllowed = true;
      await transport.terminateSession();
      const expired = await fetch(url, {
        headers: { authorization, accept, 'mcp-session-id': sessionId },
      });
      assert.equal(expired.status, 404);
      assert.equal(await expired.text(), 'Unknown MCP session');
      await Effect.runPromise(manager.setEnabled('test_server', false));
      assert.equal(manager.list()[0].enabled, false);
      await assert.rejects(Effect.runPromise(manager.connect('test_server')), /unavailable/);
      const savedTools = manager.list()[0].tools;
      await Effect.runPromise(manager.setEnabled('test_server', true));
      assert.deepEqual(manager.list()[0].tools, savedTools, 'switching preserves discovery');
      assert.equal(secrets.get('mcp:test_server:env'), JSON.stringify(input.env));
      const reopened = await Effect.runPromise(manager.connect('test_server'));
      assert.equal(reopened.tools[0].name, 'echo');
      await Effect.runPromise(manager.remove('test_server'));
      assert.equal(manager.list().length, 0);
      assert.equal(secrets.get('mcp:test_server:env'), '');
    } finally {
      await client.close().catch(() => {});
      await relay.close();
      await Effect.runPromise(manager.close());
      http.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('disabling MCP cancels an opening connection and a later enable opens a fresh client', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wow-mcp-'));
  const manager = McpManager.make(path.join(root, 'mcp.json'), root, {
    read: async () => '',
    write: async () => {},
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
  manager.servers.test_server = mcpSetup.parse({
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
  const manager = McpManager.make('mcp.json', '.', {
    read: async () => '',
    write: async () => {},
  });
  using connect = vi
    .spyOn(Client.prototype, 'connect')
    .mockRejectedValueOnce(Error('Handshake failed'))
    .mockResolvedValue(undefined);
  using close = vi.spyOn(Client.prototype, 'close').mockResolvedValue(undefined);
  using listTools = vi.spyOn(Client.prototype, 'listTools').mockResolvedValue({ tools: [] });
  manager.servers.test_server = mcpSetup.parse({
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
  const vault = { read: async () => '', write: async () => {} };
  const file = path.join(root, 'mcp.json');
  const manager = McpManager.make(file, root, vault);
  try {
    for (const name of ['first', 'second']) {
      manager.servers[name] = mcpSetup.parse({
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
    const restored = McpManager.make(file, root, vault);
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

test('MCP shutdown waits for client cleanup and rejects new connections', async () => {
  const manager = McpManager.make('mcp.json', '.', {
    read: async () => '',
    write: async () => {},
  });
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
  manager.servers.test_server = mcpSetup.parse({
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
    mcpSetup.parse({ server: { name: 'test', url: 'https://user:secret@example.com/mcp' } }),
  );
  assert.throws(() =>
    mcpSetup.parse({ server: { name: 'everloot', url: 'https://example.com/mcp' } }),
  );
  for (const name of ['wow', 'questie', 'wisp', 'everloot_search']) {
    assert.throws(() => mcpSetup.parse({ server: { name, url: 'https://example.com/mcp' } }));
  }
  assert.equal(
    mcpSetup.parse({
      server: { name: 'test', transport: 'stdio', command: 'node', args: ['literal; not a shell'] },
    }).server.args[0],
    'literal; not a shell',
  );
});
