import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { McpManager, mcpSetup, resolveStdioCommand } from '../src/integrations/mcp/mcp-manager.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createServer } from 'node:http';
import { McpRelay } from '../src/integrations/mcp/mcp-relay.ts';
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
      (req, res) =>
        void relay.handle(req, res, 'test_server').catch(() => res.writeHead(500).end()),
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
  },
);
test('the node runtime helper stays inside the bridge package that desktop dev deploys', async () => {
  const bridgeRoot = fileURLToPath(new URL('..', import.meta.url));
  const helper = fileURLToPath(new URL('../src/runtime-node.mjs', import.meta.url));
  assert.equal(path.dirname(path.dirname(helper)), path.resolve(bridgeRoot));
  const source = await readFile(
    new URL('../src/integrations/mcp/mcp-manager.ts', import.meta.url),
    'utf8',
  );
  const specifier = source.match(/from '([^']*runtime-node\.mjs)'/)?.[1];
  assert.equal(typeof specifier, 'string');
  const imported = fileURLToPath(
    new URL(specifier!, new URL('../src/integrations/mcp/mcp-manager.ts', import.meta.url)),
  );
  assert.equal(imported, helper);
});
test('a packaged node MCP uses the platform runtime, and development uses this process', () => {
  const root = path.join(tmpdir(), 'wisp-mcp-node');
  const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
  const previous = process.env.WISP_ENGINE_EXECUTABLE;
  process.env.WISP_ENGINE_EXECUTABLE = 'wisp-engine';
  try {
    assert.equal(
      resolveStdioCommand('node', ['server.js'], root).command,
      path.join(root, 'runtime', nodeName),
    );
    assert.equal(
      resolveStdioCommand('NODE.EXE', ['server.js'], root).command,
      path.join(root, 'runtime', nodeName),
    );
    assert.deepEqual(resolveStdioCommand('npx', ['--yes', 'some-mcp'], root), {
      command: process.execPath,
      args: ['--npx', '--yes', 'some-mcp'],
    });
  } finally {
    if (previous === undefined) delete process.env.WISP_ENGINE_EXECUTABLE;
    else process.env.WISP_ENGINE_EXECUTABLE = previous;
  }
  assert.equal(resolveStdioCommand('node', ['server.js'], root).command, process.execPath);
  assert.equal(
    resolveStdioCommand('npx', ['--yes', 'some-mcp'], root).args[0],
    path.join(root, 'runtime', 'npm', 'bin', 'npx-cli.js'),
  );
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
