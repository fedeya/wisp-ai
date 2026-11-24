import { afterEach, expect, test } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { setAgentHost } from '../src/agent-host.ts';
import { McpTools } from '../src/mcp-tools.ts';

afterEach(() => setAgentHost(undefined));

test('relayed MCP servers become namespaced, filtered tools through Mastra MCPClient', async () => {
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
  const mcp = new McpTools(() => config);
  const errors: string[] = [];
  try {
    const tools = await mcp.tools((connection) => errors.push(connection));
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
    expect(await mcp.tools(() => {})).toEqual([]);
  } finally {
    await mcp.close();
    http.close();
    await rm(directory, { recursive: true, force: true });
  }
});
