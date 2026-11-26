import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { McpManager, mcpSetup } from '../src/integrations/mcp/mcp-manager.ts';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'wisp-mcp-close-'));
  const script = path.join(root, 'server.mjs');
  await writeFile(
    script,
    `import {z} from ${JSON.stringify(import.meta.resolve('zod'))};
import {Server} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/index.js'))};
import {StdioServerTransport} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/stdio.js'))};
import {ListToolsRequestSchema,CallToolRequestSchema,NotificationSchema} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/types.js'))};
const server=new Server({name:'CloseFixture',version:'1'},{capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:'echo',inputSchema:{type:'object'},annotations:{readOnlyHint:true}}]}));
server.setRequestHandler(CallToolRequestSchema,async()=>({content:[{type:'text',text:'fixture working'}]}));
server.setNotificationHandler(NotificationSchema.extend({method:z.literal('fixture/close')}),async()=>{await server.close();process.exit(0)});
await server.connect(new StdioServerTransport());`,
  );
  const vault = { read: async () => '', write: async () => {} };
  const manager = new McpManager(path.join(root, 'mcp.json'), root, vault);
  const definition = mcpSetup.parse({
    server: { name: 'close_fixture', transport: 'stdio', command: 'node', args: [script] },
  }).server;
  manager.servers[definition.name] = definition;
  return { root, manager, definition, vault };
}

test(
  'a fresh explicit call reconnects after a real SDK transport closes',
  { timeout: 15000 },
  async () => {
    const { root, manager, definition, vault } = await fixture();
    const control = new McpManager(path.join(root, 'control.json'), root, vault);
    control.servers[definition.name] = definition;
    try {
      const [first, concurrent] = await Promise.all([
        manager.connect(definition.name),
        manager.connect(definition.name),
      ]);
      assert.equal(first, concurrent, 'concurrent callers share one connection');
      assert.equal(first.tools[0].name, 'echo');
      assert.match(
        JSON.stringify(await first.client.callTool({ name: 'echo' })),
        /fixture working/,
      );
      console.log('Causal evidence: discovery and first real SDK tool call succeeded');

      await first.client.notification({ method: 'fixture/close' });
      await vi.waitFor(() => assert.equal(first.client.transport, undefined), { timeout: 3000 });
      await assert.rejects(first.client.callTool({ name: 'echo' }), /Not connected/);
      console.log('Causal evidence: remote transport closed; old SDK client does not reconnect');

      const healthy = await control.connect(definition.name);
      assert.match(
        JSON.stringify(await healthy.client.callTool({ name: 'echo' })),
        /fixture working/,
      );
      console.log('Causal evidence: independent connection to the same fixture still works');

      const next = await manager.connect(definition.name);
      console.log('Causal evidence: fresh manager.connect reused closed client:', next === first);
      assert.match(JSON.stringify(await next.client.callTool({ name: 'echo' })), /fixture working/);
      assert.notEqual(next, first);
      assert.equal(manager.list()[0].enabled, true, 'no toggle was needed');
    } finally {
      await control.close();
      await manager.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'a stale close callback cannot evict a replacement after explicit disconnect',
  { timeout: 15000 },
  async () => {
    const { root, manager, definition } = await fixture();
    try {
      const first = await manager.connect(definition.name);
      const staleClose = first.client.onclose;
      assert.ok(staleClose, 'cache eviction is attached to the SDK client callback');
      const disconnect = manager.disconnect(definition.name);
      const replacement = manager.connect(definition.name);
      await disconnect;
      const next = await replacement;
      assert.notEqual(next, first);
      // Deliver an old callback after the new connection owns the cache key.
      staleClose();
      assert.equal(await manager.connect(definition.name), next);
      assert.match(JSON.stringify(await next.client.callTool({ name: 'echo' })), /fixture working/);
    } finally {
      await manager.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('an old opening rejection cannot evict its replacement', { timeout: 15000 }, async () => {
  const { root, manager, definition, vault } = await fixture();
  let rejectFailure!: (error: Error) => void;
  const failure = new Promise<string>((_, reject) => {
    rejectFailure = reject;
  });
  let reads = 0;
  vault.read = async () => (++reads === 1 ? failure : '');
  manager.servers[definition.name] = { ...definition, hasToken: true };
  try {
    const first = manager.connect(definition.name);
    const rejected = assert.rejects(first, /old opening failed/);
    const disconnect = manager.disconnect(definition.name);
    const next = await manager.connect(definition.name);
    rejectFailure(new Error('old opening failed'));
    await rejected;
    await disconnect;
    assert.equal(await manager.connect(definition.name), next);
    assert.match(JSON.stringify(await next.client.callTool({ name: 'echo' })), /fixture working/);
  } finally {
    rejectFailure(new Error('fixture cleanup'));
    await manager.close();
    await rm(root, { recursive: true, force: true });
  }
});

test(
  'an initial opening failure is evicted so a later explicit connection can succeed',
  { timeout: 15000 },
  async () => {
    const { root, manager, definition, vault } = await fixture();
    let reads = 0;
    vault.read = async () => {
      if (++reads === 1) {
        throw new Error('initial opening failed');
      }
      return '';
    };
    manager.servers[definition.name] = { ...definition, hasToken: true };
    try {
      await assert.rejects(manager.connect(definition.name), /initial opening failed/);
      assert.equal(manager.clients.size, 0);
      const next = await manager.connect(definition.name);
      assert.match(JSON.stringify(await next.client.callTool({ name: 'echo' })), /fixture working/);
      assert.equal(reads, 2);
    } finally {
      await manager.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
