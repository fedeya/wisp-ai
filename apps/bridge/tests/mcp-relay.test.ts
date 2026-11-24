import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { McpManager, mcpSetup } from '../src/integrations/mcp/mcp-manager.ts';
import { McpRelay } from '../src/integrations/mcp/mcp-relay.ts';
import { CapabilitySettings } from '../src/integrations/capabilities.ts';
import { mcpCapabilityCatalog } from '../src/integrations/mcp/mcp-capabilities.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'mcp-relay-'));
  const reached = deferred();
  const release = deferred();
  let calls = 0;
  const tools = [
    { name: 'echo', inputSchema: { type: 'object' as const }, annotations: { readOnlyHint: true } },
    { name: 'write', inputSchema: { type: 'object' as const } },
  ];
  const upstream = new Server({ name: 'fixture', version: '1' }, { capabilities: { tools: {} } });
  upstream.setRequestHandler(ListToolsRequestSchema, async () => {
    reached.resolve();
    await release.promise;
    return { tools };
  });
  upstream.setRequestHandler(CallToolRequestSchema, async () => {
    calls++;
    return { content: [{ type: 'text', text: 'ok' }] };
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  await upstream.connect(transport);
  const upstreamHttp = createServer((req, res) => {
    void transport.handleRequest(req, res).catch(() => res.writeHead(500).end());
  });
  await new Promise<void>((resolve) => upstreamHttp.listen(0, '127.0.0.1', resolve));
  const upstreamPort = (upstreamHttp.address() as { port: number }).port;
  const manager = new McpManager(path.join(root, 'mcp.json'), root, {
    read: async () => '',
    write: async () => {},
  });
  manager.servers.test = {
    ...mcpSetup.parse({ server: { name: 'test', url: `http://127.0.0.1:${upstreamPort}/mcp` } })
      .server,
    tools,
  };
  const settings = new CapabilitySettings(
    path.join(root, 'capabilities.json'),
    mcpCapabilityCatalog(manager.list()),
  );
  await settings.load();
  const relay = new McpRelay(manager, (name, tool) =>
    settings.enabled(tool ? `mcp_tool:${name}:${tool}` : `mcp:${name}`),
  );
  const http = createServer((req, res) => {
    void relay.handle(req, res, 'test').catch(() => res.writeHead(500).end());
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const port = (http.address() as { port: number }).port;
  const client = new Client({ name: 'test', version: '1' }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  return {
    client,
    manager,
    settings,
    relay,
    reached,
    release,
    calls: () => calls,
    async close() {
      release.resolve();
      await client.close();
      await relay.close();
      await manager.close();
      await upstream.close();
      await Promise.all(
        [http, upstreamHttp].map(
          (server) =>
            new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            ),
        ),
      );
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('durably disabling an individual tool during initial discovery prevents dispatch', async () => {
  const f = await fixture();
  try {
    const result = f.client.callTool({ name: 'echo', arguments: {} }).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await f.reached.promise;
    await f.settings.set('mcp_tool:test:echo', false);
    const persisted = new CapabilitySettings(f.settings.file, f.settings.catalog);
    await persisted.load();
    assert.equal(persisted.enabled('mcp_tool:test:echo'), false);
    assert.equal(f.settings.enabled('mcp:test'), true);
    assert.equal(f.manager.servers.test.enabled, true);
    f.release.resolve();
    const outcome = await result;
    assert.equal(f.calls(), 0, 'revoked tool must not reach upstream callTool');
    assert.ok('error' in outcome);
    assert.match(String(outcome.error), /MCP tool disabled/);
  } finally {
    await f.close();
  }
});

test('enabled calls work and pre-disabled tools are rejected before discovery', async () => {
  const f = await fixture();
  try {
    await f.settings.set('mcp_tool:test:echo', false);
    await assert.rejects(f.client.callTool({ name: 'echo' }), /MCP tool disabled/);
    assert.equal(f.manager.clients.size, 0);
    await f.settings.set('mcp_tool:test:echo', true);
    f.release.resolve();
    assert.deepEqual((await f.client.callTool({ name: 'echo' })).content, [
      { type: 'text', text: 'ok' },
    ]);
    assert.equal(f.calls(), 1);
  } finally {
    await f.close();
  }
});

test('read-only mode still filters discovery and rejects tools without an explicit hint', async () => {
  const f = await fixture();
  try {
    f.relay.readOnlyMode = () => true;
    f.release.resolve();
    assert.deepEqual(
      (await f.client.listTools()).tools.map((tool) => tool.name),
      ['echo'],
    );
    await assert.rejects(f.client.callTool({ name: 'write' }), /Only explicitly read-only/);
    await f.client.callTool({ name: 'echo' });
    assert.equal(f.calls(), 1);
  } finally {
    await f.close();
  }
});
