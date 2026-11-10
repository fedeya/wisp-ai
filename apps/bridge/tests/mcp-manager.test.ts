import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { McpManager, mcpSetup } from '@wisp/bridge/mcp-manager';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createServer } from 'node:http';
import { McpRelay } from '@wisp/bridge/mcp-relay';
test('stdio MCP setup tests real tools, encrypts through the vault interface and gates relay calls', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wow-mcp-'));
  const secrets = new Map<string, string>();
  const vault = {
    read: async (k: string) => secrets.get(k) || '',
    write: async (k: string, v: string) => {
      secrets.set(k, v);
    },
  };
  const manager = new McpManager(path.join(root, 'mcp.json'), root, vault);
  await manager.load();
  const script = path.join(root, 'server.mjs');
  await writeFile(
    script,
    `import {Server} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/index.js'))};import {StdioServerTransport} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/stdio.js'))};import {ListToolsRequestSchema,CallToolRequestSchema} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/types.js'))};const server=new Server({name:'Test',version:'1'},{capabilities:{tools:{}}});server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:'echo',description:'Echo',inputSchema:{type:'object',properties:{}},annotations:{readOnlyHint:true}}]}));server.setRequestHandler(CallToolRequestSchema,async()=>({content:[{type:'text',text:JSON.stringify({ok:process.env.TEST_SECRET==='private-test-value',bridgeTokenLeaked:!!process.env.WOW_BRIDGE_TOKEN})}]}));await server.connect(new StdioServerTransport());`,
  );
  const input = mcpSetup.parse({
    server: { name: 'test_server', transport: 'stdio', command: 'node', args: [script] },
    env: { TEST_SECRET: 'private-test-value' },
  });
  let allowed = true;
  const relay = new McpRelay(manager, () => allowed);
  const http = createServer(
    (req, res) => void relay.handle(req, res, 'test_server').catch(() => res.writeHead(500).end()),
  );
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const port = (http.address() as { port: number }).port;
  const client = new Client({ name: 'test', version: '1' }, { capabilities: {} });
  try {
    assert.equal((await manager.save(input)).count, 1);
    assert.ok(!(await readFile(manager.file, 'utf8')).includes('private-test-value'));
    assert.ok(secrets.size > 0);
    await client.connect(
      new StreamableHTTPClientTransport(new URL('http://127.0.0.1:' + port + '/mcp')),
    );
    assert.equal((await client.listTools()).tools[0].name, 'echo');
    const result = await client.callTool({ name: 'echo', arguments: {} });
    assert.match(JSON.stringify(result), /bridgeTokenLeaked/);
    assert.match(JSON.stringify(result), /true/);
    allowed = false;
    await assert.rejects(() => client.callTool({ name: 'echo', arguments: {} }));
    await manager.setEnabled('test_server', false);
    assert.equal(manager.list()[0].enabled, false);
    await assert.rejects(manager.connect('test_server'), /unavailable/);
    const savedTools = manager.list()[0].tools;
    await manager.setEnabled('test_server', true);
    assert.deepEqual(manager.list()[0].tools, savedTools, 'switching preserves discovery');
    assert.equal(secrets.get('mcp:test_server:env'), JSON.stringify(input.env));
    const reopened = await manager.connect('test_server');
    assert.equal(reopened.tools[0].name, 'echo');
    await manager.remove('test_server');
    assert.equal(manager.list().length, 0);
    assert.equal(secrets.get('mcp:test_server:env'), '');
  } finally {
    await client.close().catch(() => {});
    await relay.close();
    await manager.close();
    http.close();
    await rm(root, { recursive: true, force: true });
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
