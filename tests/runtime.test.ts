import { test, expect, vi } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { startBridge, type BridgeOptions } from '@wisp/bridge/runtime';
import { packetSchema } from '@wisp/protocol/protocol';
import { statusSchema } from '@wisp/protocol/desktop';
import { newChat } from '@wisp/bridge/chat-lifecycle';

async function fixture() {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'wisp-runtime-'));
  await writeFile(
    path.join(dataDirectory, 'config.local.json'),
    JSON.stringify({ wow: path.join(dataDirectory, 'wow') }),
  );
  let child: ChildProcess | undefined;
  const options: BridgeOptions = {
    dataDirectory,
    agentPort: 0,
    desktopPort: 0,
    vault: { read: async () => '', write: async () => {} },
    client: {
      health: async () => {},
      info: async () => ({ agent: {} }),
      sessions: {},
    } as unknown as BridgeOptions['client'],
    startAgent: () => {
      child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      return child;
    },
  };
  return { dataDirectory, options, child: () => child };
}

test(
  'two development runtimes share history live with separate ports, tokens and engine directories',
  { timeout: 20000 },
  async () => {
    const shared = await mkdtemp(path.join(tmpdir(), 'wisp-shared-runtime-'));
    const a = await fixture(),
      b = await fixture();
    const origins: string[] = [],
      engineRoots: string[] = [],
      evePorts: number[] = [];
    for (const f of [a, b]) {
      const start = f.options.startAgent!;
      f.options.startAgent = (options) => {
        origins.push(options.environment.WOW_BRIDGE_URL!);
        engineRoots.push(options.root);
        evePorts.push(options.port!);
        return start(options);
      };
    }
    let first: Awaited<ReturnType<typeof startBridge>> | undefined;
    let second: Awaited<ReturnType<typeof startBridge>> | undefined;
    vi.stubEnv('WISP_SHARED_DATA_DIR', shared);
    try {
      vi.stubEnv('WISP_EVE_PORT', '51001');
      first = await startBridge(a.options);
      vi.stubEnv('WISP_EVE_PORT', '51002');
      second = await startBridge(b.options);
      const identityA = JSON.parse(
        await readFile(path.join(a.dataDirectory, 'runtime/desktop.json'), 'utf8'),
      );
      const identityB = JSON.parse(
        await readFile(path.join(b.dataDirectory, 'runtime/desktop.json'), 'utf8'),
      );
      expect(identityA.port).not.toBe(identityB.port);
      expect(identityA.token).not.toBe(identityB.token);
      expect(origins[0]).not.toBe(origins[1]);
      expect(engineRoots[0]).not.toBe(engineRoots[1]);
      expect(evePorts).toEqual([51001, 51002]);
      first.state.chats.push({
        ...newChat('shared-chat', 'game-a'),
        status: 'done',
        eveId: 'private-a',
        messages: [{ role: 'user', text: 'From A' }],
      });
      first.receive(packetSchema.parse({ type: 'hello', session: 'game-a', seq: 1, at: 1 }));
      await vi.waitFor(
        () =>
          expect(second!.state.chats.find((c) => c.id === 'shared-chat')?.messages[0].text).toBe(
            'From A',
          ),
        { timeout: 5000 },
      );
      expect(second.state.chats[0].eveId).toBeUndefined();
      expect(second.state.activeTransport).toBe('');
      second.state.chats[0].messages.push({ role: 'assistant', text: 'From B' });
      second.receive(packetSchema.parse({ type: 'hello', session: 'game-b', seq: 1, at: 1 }));
      await vi.waitFor(
        () =>
          expect(
            first!.state.chats.find((c) => c.id === 'shared-chat')?.messages.at(-1)?.text,
          ).toBe('From B'),
        { timeout: 5000 },
      );
      await first.stop();
      first = undefined;
      const response = await fetch(`http://127.0.0.1:${identityB.port}/status`, {
        headers: { authorization: 'Bearer ' + identityB.token },
      });
      expect(response.ok).toBe(true);
    } finally {
      await first?.stop();
      await second?.stop();
      vi.unstubAllEnvs();
      for (const directory of [a.dataDirectory, b.dataDirectory, shared]) {
        await rm(directory, { recursive: true, force: true });
      }
    }
  },
);

test('a fresh addon installation starts before a default model is selected', async () => {
  const f = await fixture();
  const config = { wow: path.join(f.dataDirectory, 'wow'), model: '' };
  await writeFile(path.join(f.dataDirectory, 'config.local.json'), JSON.stringify(config));
  let bridge: Awaited<ReturnType<typeof startBridge>> | undefined;
  try {
    bridge = await startBridge(f.options);
    const identity = JSON.parse(
      await readFile(path.join(f.dataDirectory, 'runtime/desktop.json'), 'utf8'),
    );
    const response = await fetch(`http://127.0.0.1:${identity.port}/status`, {
      headers: { authorization: 'Bearer ' + identity.token },
    });
    expect(response.ok).toBe(true);
    expect(statusSchema.parse(await response.json())).toMatchObject({
      auth: { status: 'signed_out' },
      gameConnected: false,
      modelConnected: false,
    });
  } finally {
    await bridge?.stop();
    await rm(f.dataDirectory, { recursive: true, force: true });
  }
});

test('an API chat searches Wowhead through Exa without a ChatGPT account', async () => {
  const f = await fixture();
  const secrets = new Map<string, string>();
  f.options.vault = {
    read: async (key) => secrets.get(key) || '',
    write: async (key, value) => {
      secrets.set(key, value);
    },
  };
  let origin = '',
    agentToken = '';
  const start = f.options.startAgent!;
  f.options.startAgent = (options) => {
    origin = options.environment.WOW_BRIDGE_URL!;
    agentToken = options.environment.WOW_BRIDGE_TOKEN!;
    return start(options);
  };
  const actualFetch = globalThis.fetch;
  const exaRequests: Record<string, unknown>[] = [];
  const exa = vi.fn(async () =>
    Response.json({
      results: [
        {
          url: 'https://www.wowhead.com/forever/spell=122/frost-nova',
          text: 'Forever reference excerpt',
        },
      ],
    }),
  );
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === 'https://api.exa.ai/search') {
      exaRequests.push(JSON.parse(String(init?.body)));
      return exa();
    }
    if (String(input).startsWith('https://mcp.exa.ai/')) {
      const response = await exa();
      return Response.json({
        jsonrpc: '2.0',
        id: 1,
        result: { content: [{ type: 'text', text: JSON.stringify(await response.json()) }] },
      });
    }
    return actualFetch(input, init);
  });
  let bridge: Awaited<ReturnType<typeof startBridge>> | undefined;
  try {
    bridge = await startBridge(f.options);
    const identity = JSON.parse(
      await readFile(path.join(f.dataDirectory, 'runtime/desktop.json'), 'utf8'),
    );
    const desktop = async (route: string, body?: unknown) => {
      const r = await actualFetch(`http://127.0.0.1:${identity.port}${route}`, {
        method: body ? 'POST' : 'GET',
        headers: { authorization: 'Bearer ' + identity.token, 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      expect(r.ok).toBe(true);
      return r.json();
    };
    const { id } = await desktop('/connections/save', {
      provider: 'compatible',
      name: 'Local',
      baseURL: 'http://localhost:1234/v1',
      models: [{ id: 'local', contextWindow: 64000 }],
    });
    bridge.receive(packetSchema.parse({ type: 'hello', session: 'live', seq: 1, at: 1 }));
    const chat = newChat('search-chat', 'live');
    chat.eveId = 'eve-search';
    chat.status = 'working';
    chat.modelSettings = { model: `connection:${id}:local`, effort: 'provider-default' };
    bridge.state.chats.push(chat);
    const agent = async (route: string, body?: unknown) => {
      const r = await actualFetch(origin + route, {
        method: body ? 'POST' : 'GET',
        headers: { authorization: 'Bearer ' + agentToken, 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      expect(r.ok).toBe(true);
      return r.json();
    };
    expect((await agent('/session-model?session=eve-search')).webSearchAvailable).toBe(true);
    expect(
      await agent('/wowhead', { eveSession: 'eve-search', query: 'Frost Nova' }),
    ).toMatchObject({ status: 'available', provider: 'Exa' });
    chat.status = 'done';
    await desktop('/search/save', { provider: 'auto', apiKey: 'private-exa-key' });
    chat.status = 'working';
    expect((await agent('/session-model?session=eve-search')).webSearchAvailable).toBe(true);
    const result = await agent('/wowhead', {
      eveSession: 'eve-search',
      query: 'Frost Nova',
      depth: 'deep',
      maxResults: 7,
      maxQueries: 1,
      timeoutSeconds: 120,
      excerptCharacters: 6000,
    });
    expect(result).toMatchObject({
      status: 'available',
      provider: 'Exa',
      budget: {
        depth: 'deep',
        maxResults: 7,
        maxQueries: 1,
        timeoutSeconds: 120,
        excerptCharacters: 6000,
      },
      sources: [{ excerpt: 'Forever reference excerpt' }],
    });
    expect(exaRequests.at(-1)).toMatchObject({
      numResults: 7,
      contents: { text: { maxCharacters: 6000 } },
    });
    expect(exa).toHaveBeenCalledTimes(2);
    chat.status = 'done';
    const status = await desktop('/status');
    expect(status.auth.status).toBe('signed_out');
    expect(status.search).toEqual({ provider: 'auto', hasExaKey: true });
    expect(JSON.stringify(status)).not.toContain('private-exa-key');
    expect(await readFile(path.join(f.dataDirectory, 'runtime/search.json'), 'utf8')).not.toContain(
      'private-exa-key',
    );
    await desktop('/search/remove-exa', {});
    chat.status = 'working';
    expect((await agent('/session-model?session=eve-search')).webSearchAvailable).toBe(true);
  } finally {
    await bridge?.stop();
    vi.unstubAllGlobals();
    await rm(f.dataDirectory, { recursive: true, force: true });
  }
});

test('the assembled runtime serves validated status, receives packets, persists and stops its process', async () => {
  const f = await fixture();
  let bridge: Awaited<ReturnType<typeof startBridge>> | undefined;
  try {
    bridge = await startBridge(f.options);
    const identity = JSON.parse(
      await readFile(path.join(f.dataDirectory, 'runtime/desktop.json'), 'utf8'),
    );
    const response = await fetch(`http://127.0.0.1:${identity.port}/status`, {
      headers: { authorization: 'Bearer ' + identity.token },
    });
    expect(statusSchema.parse(await response.json()).auth.status).toBe('signed_out');
    bridge.receive(packetSchema.parse({ type: 'hello', session: 'test', seq: 1, at: 1 }));
    bridge.receive(
      packetSchema.parse({ type: 'new', session: 'test', chat: 'chat', seq: 2, at: 2 }),
    );
    bridge.state.chats
      .find((chat) => chat.id === 'chat')!
      .messages.push({
        role: 'user',
        text: 'Hello',
      });
    bridge.receive(
      packetSchema.parse({ type: 'new', session: 'test', chat: 'draft', seq: 3, at: 3 }),
    );
    await bridge.stop();
    const { ChatStore } = await import('@wisp/bridge/chat-store');
    const store = new ChatStore(path.join(f.dataDirectory, 'runtime/wisp.sqlite'), () => {});
    const saved = await store.load();
    await store.close();
    expect(saved.map((chat: { id: string }) => chat.id)).toContain('chat');
    expect(saved.find((chat: { id: string }) => chat.id === 'chat')!.messages).toEqual([
      { role: 'user', text: 'Hello' },
    ]);
    expect(saved.map((chat: { id: string }) => chat.id)).not.toContain('draft');
    await vi.waitFor(() => expect(f.child()?.exitCode).not.toBeNull());
    await bridge.stop();
  } finally {
    await bridge?.stop();
    await rm(f.dataDirectory, { recursive: true, force: true });
  }
});

test('a late startup failure closes the agent and already-started runtime resources', async () => {
  const f = await fixture();
  const occupied = createServer();
  await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve));
  const port = (occupied.address() as { port: number }).port;
  try {
    await expect(startBridge({ ...f.options, desktopPort: port })).rejects.toThrow('EADDRINUSE');
    await vi.waitFor(() => expect(f.child()?.exitCode).not.toBeNull());
  } finally {
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
    await rm(f.dataDirectory, { recursive: true, force: true });
  }
});

test('desktop API configures a local provider and selects its default without ChatGPT', async () => {
  const f = await fixture();
  let bridge: Awaited<ReturnType<typeof startBridge>> | undefined;
  try {
    bridge = await startBridge(f.options);
    const identity = JSON.parse(
      await readFile(path.join(f.dataDirectory, 'runtime/desktop.json'), 'utf8'),
    );
    async function request(route: string, body?: unknown) {
      const response = await fetch(`http://127.0.0.1:${identity.port}${route}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: 'Bearer ' + identity.token, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      expect(response.ok).toBe(true);
      return response.json();
    }
    const { id } = await request('/connections/save', {
      provider: 'compatible',
      name: 'Local model',
      baseURL: 'http://localhost:1234/v1',
      models: [{ id: 'local-test', contextWindow: 64000 }],
    });
    const { models } = await request('/auth/models');
    expect(models).toMatchObject([{ slug: `connection:${id}:local-test`, efforts: [] }]);
    await request('/auth/model', { model: models[0].slug });
    const status = statusSchema.parse(await request('/status'));
    expect(status.modelConnected).toBe(true);
    expect(status.auth.status).toBe('signed_out');
    expect(status.connections[0]?.models[0]?.contextWindow).toBe(64000);
    await request('/connections/remove', { id });
    expect((await request('/status')).modelConnected).toBe(false);
  } finally {
    await bridge?.stop();
    await rm(f.dataDirectory, { recursive: true, force: true });
  }
});
