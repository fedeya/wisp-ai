import { afterEach, expect, test, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Effect } from 'effect';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { setAgentHost } from '../src/host/agent-host.ts';
import { AgentCapabilities, layerFromFile } from '../src/host/capabilities.ts';
import { mcpConnections, McpTools } from '../src/integrations/mcp-tools.ts';
import { gate } from './gate.ts';

afterEach(() => setAgentHost(undefined));

const readConnections = (config: string) =>
  Effect.runPromise(
    Effect.flatMap(AgentCapabilities, (settings) =>
      Effect.flatMap(settings.read, (capabilities) => mcpConnections(capabilities, () => config)),
    ).pipe(Effect.provide(layerFromFile()), Effect.provide(NodeFileSystem.layer)),
  );

test('closing MCP tools also closes a client whose connection completes after shutdown', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'wisp-mcp-tools-'));
  const flags = path.join(directory, 'capabilities.json');
  const config = path.join(directory, 'mcp.json');
  const connecting = gate();
  const connected = gate();
  const connect = vi.spyOn(Client.prototype, 'connect').mockImplementation(() => {
    connecting.open();
    return connected.promise;
  });
  const close = vi.spyOn(Client.prototype, 'close').mockResolvedValue(undefined);
  const list = vi.spyOn(Client.prototype, 'listTools').mockResolvedValue({ tools: [] });
  const mcp = new McpTools();
  try {
    await writeFile(flags, JSON.stringify({ enabled: { 'mcp:everloot': false } }));
    await writeFile(config, JSON.stringify({ servers: { my_tools: { enabled: true } } }));
    setAgentHost({ origin: 'http://127.0.0.1:1', token: 'relay-token', capabilitiesFile: flags });
    const connections = await readConnections(config);
    const listing = mcp.tools(connections, () => {});
    await Promise.race([
      connecting.promise,
      listing.then(() => {
        throw Error('MCP listing finished before opening a connection.');
      }),
    ]);
    await mcp.close();
    connected.open();
    expect(await listing).toEqual([]);
    expect(close.mock.contexts).toContain(connect.mock.contexts[0]);
    expect(list).not.toHaveBeenCalled();
    expect(await mcp.tools(connections, () => {})).toEqual([]);
    expect(connect).toHaveBeenCalledTimes(1);
  } finally {
    connected.open();
    await mcp.close();
    connect.mockRestore();
    close.mockRestore();
    list.mockRestore();
    await rm(directory, { recursive: true, force: true });
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
  const mcp = new McpTools();
  const errors: string[] = [];
  try {
    const tools = await mcp.tools(await readConnections(config), (connection) =>
      errors.push(connection),
    );
    expect(errors).toEqual([]);
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
    expect(await mcp.tools(await readConnections(config), () => {})).toEqual([]);
  } finally {
    await mcp.close();
    http.close();
    await rm(directory, { recursive: true, force: true });
  }
});
