import { test, vi } from 'vitest';
import type { z } from 'zod';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { McpManager, mcpSetup } from '../src/integrations/mcp/mcp-manager.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createServer } from 'node:http';
import { McpRelay } from '../src/integrations/mcp/mcp-relay.ts';

function isPublicationFailure(error: unknown) {
  return (
    error instanceof Error &&
    'code' in error &&
    ['EISDIR', 'EPERM', 'EACCES'].includes(String(error.code)) &&
    'syscall' in error &&
    error.syscall === 'rename'
  );
}

async function saveFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'wow-mcp-save-'));
  const secrets = new Map<string, string>();
  const writes: [string, string][] = [];
  const vault = {
    read: async (key: string) => secrets.get(key) || '',
    write: async (key: string, value: string) => {
      writes.push([key, value]);
      secrets.set(key, value);
    },
  };
  const manager = new McpManager(path.join(root, 'mcp.json'), root, vault);
  const script = path.join(root, 'server.mjs');
  await writeFile(
    script,
    `import {Server} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/index.js'))};
import {StdioServerTransport} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/stdio.js'))};
import {ListToolsRequestSchema,CallToolRequestSchema} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/types.js'))};
const server=new Server({name:'SaveTest',version:'1'},{capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:'credential',inputSchema:{type:'object'}}]}));
server.setRequestHandler(CallToolRequestSchema,async()=>({content:[{type:'text',text:process.env.TEST_SECRET||'empty'}]}));
await server.connect(new StdioServerTransport());`,
  );
  const input = mcpSetup.parse({
    server: { name: 'saved', transport: 'stdio', command: 'node', args: [script] },
    token: 'old-token',
    env: { TEST_SECRET: 'old-env' },
  });
  return {
    root,
    manager,
    secrets,
    writes,
    vault,
    input,
    async blockPublication() {
      await rename(manager.file, manager.file + '.saved');
      await mkdir(manager.file);
      return async () => {
        await rm(manager.file, { recursive: true });
        await rename(manager.file + '.saved', manager.file);
      };
    },
    async close() {
      await manager.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test(
  'rejected MCP metadata publication preserves saved credentials and reconnect behavior',
  { timeout: 30000 },
  async () => {
    const f = await saveFixture();
    try {
      await f.manager.save(f.input);
      const before = await readFile(f.manager.file, 'utf8');
      const definitions = f.manager.list();
      const unblock = await f.blockPublication();
      try {
        await assert.rejects(
          f.manager.save({
            ...f.input,
            server: { ...f.input.server, description: 'rejected edit' },
            token: 'new-token',
            env: { TEST_SECRET: 'new-env' },
          }),
          isPublicationFailure,
        );
      } finally {
        await unblock();
      }
      assert.equal(await readFile(f.manager.file, 'utf8'), before);
      assert.deepEqual(f.manager.list(), definitions);
      assert.deepEqual(Object.fromEntries(f.secrets), {
        'mcp:saved:token': 'old-token',
        'mcp:saved:env': JSON.stringify(f.input.env),
      });
      const connection = await f.manager.connect('saved');
      const result = await connection.client.callTool({ name: 'credential', arguments: {} });
      assert.deepEqual(result.content, [{ type: 'text', text: 'old-env' }]);
    } finally {
      await f.close();
    }
  },
);

const credentialCases: Pick<z.infer<typeof mcpSetup>, 'token' | 'env'>[] = [
  { token: 'new-token', env: { TEST_SECRET: 'new-env' } },
  { token: '' },
  { env: {} },
  {},
];
for (const existing of [false, true]) {
  for (const credentials of credentialCases) {
    test(`publication failure restores only supplied credentials (${existing ? 'update' : 'create'}, ${JSON.stringify(credentials)})`, async () => {
      const f = await saveFixture();
      vi.spyOn(f.manager, 'test').mockResolvedValue({ tools: [], count: 0 });
      try {
        if (existing) await f.manager.save(f.input);
        else await writeFile(f.manager.file, JSON.stringify({ servers: {} }));
        f.secrets.set('mcp:unrelated:token', 'untouched');
        const before = new Map(f.secrets);
        const metadata = await readFile(f.manager.file, 'utf8');
        const definitions = f.manager.list();
        f.writes.length = 0;
        const unblock = await f.blockPublication();
        const edit = { server: f.input.server, ...credentials };
        try {
          await assert.rejects(f.manager.save(edit), isPublicationFailure);
        } finally {
          await unblock();
        }
        assert.equal(await readFile(f.manager.file, 'utf8'), metadata);
        assert.deepEqual(f.manager.list(), definitions);
        for (const key of ['mcp:saved:token', 'mcp:saved:env', 'mcp:unrelated:token']) {
          assert.equal(await f.vault.read(key), before.get(key) || '');
        }
        const touched = Object.keys(credentials).map((field) => 'mcp:saved:' + field);
        assert.deepEqual(f.writes.map(([key]) => key).sort(), [...touched, ...touched].sort());
        await f.manager.save(edit);
        assert.equal(f.manager.list().length, 1, 'queue progresses after rejection');
        assert.equal(
          await f.vault.read('mcp:saved:token'),
          credentials.token ?? before.get('mcp:saved:token') ?? '',
        );
        assert.equal(
          await f.vault.read('mcp:saved:env'),
          credentials.env !== undefined
            ? JSON.stringify(credentials.env)
            : before.get('mcp:saved:env') || '',
        );
        assert.equal(
          f.manager.list()[0].hasToken,
          credentials.token !== undefined ? !!credentials.token : definitions[0]?.hasToken,
        );
        assert.deepEqual(
          f.manager.list()[0].envKeys,
          credentials.env !== undefined ? Object.keys(credentials.env) : definitions[0]?.envKeys,
        );
      } finally {
        await f.close();
      }
    });
  }
}

for (const existing of [false, true]) {
  for (const mutate of [false, true]) {
    test(`second vault write failure rolls back attempted writes (${existing ? 'update' : 'create'}, mutate=${mutate})`, async () => {
      const f = await saveFixture();
      vi.spyOn(f.manager, 'test').mockResolvedValue({ tools: [], count: 0 });
      try {
        if (existing) await f.manager.save(f.input);
        const before = new Map(f.secrets);
        const definitions = f.manager.list();
        const failure = Error('synthetic env write failure');
        const write = f.vault.write;
        let fail = true;
        f.vault.write = async (key, value) => {
          if (fail && key.endsWith(':env')) {
            fail = false;
            if (mutate) await write(key, value);
            throw failure;
          }
          await write(key, value);
        };
        const edit = { ...f.input, token: 'new-token', env: { TEST_SECRET: 'new-env' } };
        await assert.rejects(f.manager.save(edit), (error) => error === failure);
        assert.deepEqual(f.manager.list(), definitions);
        for (const field of ['token', 'env']) {
          const key = 'mcp:saved:' + field;
          assert.equal(await f.vault.read(key), before.get(key) || '');
        }
        if (!existing) await assert.rejects(readFile(f.manager.file), { code: 'ENOENT' });
        await f.manager.save(edit);
        assert.equal(await f.vault.read('mcp:saved:token'), 'new-token');
        assert.equal(await f.vault.read('mcp:saved:env'), JSON.stringify(edit.env));
      } finally {
        await f.close();
      }
    });
  }
}

test('rollback reports original and restoration failures while attempting all restorations', async () => {
  const f = await saveFixture();
  vi.spyOn(f.manager, 'test').mockResolvedValue({ tools: [], count: 0 });
  try {
    await f.manager.save(f.input);
    const original = Error('synthetic save failure');
    const restoration = Error('synthetic restoration failure');
    const write = f.vault.write;
    f.vault.write = async (key, value) => {
      if (key.endsWith(':env')) {
        if (value === JSON.stringify(f.input.env)) throw restoration;
        await write(key, value);
        throw original;
      }
      await write(key, value);
    };
    await assert.rejects(
      f.manager.save({ ...f.input, token: 'new-token', env: { TEST_SECRET: 'new-env' } }),
      (error) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.cause, original);
        assert.deepEqual(error.errors, [original, restoration]);
        return true;
      },
    );
    assert.equal(
      await f.vault.read('mcp:saved:token'),
      'old-token',
      'other restoration still attempted',
    );
    assert.equal(
      await f.vault.read('mcp:saved:env'),
      JSON.stringify({ TEST_SECRET: 'new-env' }),
      'failed restoration is not claimed to succeed',
    );
    f.vault.write = write;
    await f.manager.save(f.input);
    assert.equal(await f.vault.read('mcp:saved:env'), JSON.stringify(f.input.env));
  } finally {
    await f.close();
  }
});

test('credential snapshots are taken inside the mutation queue', async () => {
  const f = await saveFixture();
  let resolveDiscovery!: () => void;
  const discovery = new Promise<void>((resolve) => {
    resolveDiscovery = resolve;
  });
  let releaseQueue!: () => void;
  const release = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  const testConnection = vi.spyOn(f.manager, 'test').mockResolvedValue({ tools: [], count: 0 });
  try {
    await f.manager.save(f.input);
    testConnection.mockImplementation(async () => {
      resolveDiscovery();
      return { tools: [], count: 0 };
    });
    const unblock = await f.blockPublication();
    f.manager.queue = release.then(async () => {
      await f.vault.write('mcp:saved:token', 'queued-token');
    });
    const rejected = assert.rejects(
      f.manager.save({ server: f.input.server, token: 'rejected-token' }),
      isPublicationFailure,
    );
    await discovery;
    releaseQueue();
    try {
      await rejected;
    } finally {
      await unblock();
    }
    assert.equal(await f.vault.read('mcp:saved:token'), 'queued-token');
    assert.equal(await f.vault.read('mcp:saved:env'), JSON.stringify(f.input.env));
  } finally {
    releaseQueue();
    await f.close();
  }
});

test('snapshot read failure does not write any credentials', async () => {
  const f = await saveFixture();
  vi.spyOn(f.manager, 'test').mockResolvedValue({ tools: [], count: 0 });
  try {
    const failure = Error('synthetic read failure');
    const read = f.vault.read;
    f.vault.read = async (key) => {
      if (key.endsWith(':env')) throw failure;
      return read(key);
    };
    await assert.rejects(f.manager.save(f.input), (error) => error === failure);
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.manager.list(), []);
    f.vault.read = read;
    await f.manager.save(f.input);
    assert.equal(f.manager.list().length, 1);
  } finally {
    await f.close();
  }
});

test('first vault write rejection restores its mutation without touching the unattempted env', async () => {
  const f = await saveFixture();
  vi.spyOn(f.manager, 'test').mockResolvedValue({ tools: [], count: 0 });
  try {
    await f.manager.save(f.input);
    const failure = Error('synthetic token write failure');
    const write = f.vault.write;
    f.vault.write = async (key, value) => {
      await write(key, value);
      if (value === 'new-token') throw failure;
    };
    f.writes.length = 0;
    await assert.rejects(
      f.manager.save({ ...f.input, token: 'new-token', env: {} }),
      (error) => error === failure,
    );
    assert.deepEqual(f.writes, [
      ['mcp:saved:token', 'new-token'],
      ['mcp:saved:token', 'old-token'],
    ]);
    assert.equal(await f.vault.read('mcp:saved:env'), JSON.stringify(f.input.env));
  } finally {
    await f.close();
  }
});

test('post-commit disconnect failure does not roll back committed credentials', async () => {
  const f = await saveFixture();
  vi.spyOn(f.manager, 'test').mockResolvedValue({ tools: [], count: 0 });
  try {
    await f.manager.save(f.input);
    const failure = Error('synthetic disconnect failure');
    const disconnect = vi.spyOn(f.manager, 'disconnect').mockRejectedValueOnce(failure);
    await assert.rejects(
      f.manager.save({ ...f.input, token: 'committed-token' }),
      (error) => error === failure,
    );
    disconnect.mockRestore();
    assert.equal(await f.vault.read('mcp:saved:token'), 'committed-token');
    const saved = JSON.parse(await readFile(f.manager.file, 'utf8'));
    assert.equal(saved.servers.saved.hasToken, true);
    assert.deepEqual(f.manager.list(), Object.values(saved.servers));
  } finally {
    await f.close();
  }
});
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
