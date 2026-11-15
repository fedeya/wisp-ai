import { test, expect, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { startBridge, type BridgeOptions } from '../src/runtime.ts';
import { packetSchema } from '@wisp/protocol/protocol';
import { UPLINK_KIND, encodeMessage, replaceUplink } from '@wisp/protocol/mailbox';
import { statusSchema } from '@wisp/protocol/desktop';
import { newChat } from '../src/chat-lifecycle.ts';

async function fixture(configured = true) {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'wisp-runtime-'));
  if (configured) {
    await writeFile(
      path.join(dataDirectory, 'config.local.json'),
      JSON.stringify({ wow: path.join(dataDirectory, 'wow') }),
    );
  }
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
  return {
    dataDirectory,
    options,
    agentStopped: () =>
      child !== undefined && (child.exitCode !== null || child.signalCode !== null),
  };
}

test('addon maintenance switches WoW folders without stopping Eve or the desktop API', async () => {
  const f = await fixture(false);
  f.options.deferWowTransport = true;
  const startAgent = vi.fn(f.options.startAgent!);
  f.options.startAgent = startAgent;
  let bridge: Awaited<ReturnType<typeof startBridge>> | undefined;
  async function game(name: string) {
    const folder = path.join(f.dataDirectory, name);
    const addon = path.join(folder, 'Interface/AddOns/WispAI');
    const file = path.join(folder, 'WTF/Account/account/realm/character/AddOns.txt');
    await mkdir(path.dirname(file), { recursive: true });
    await mkdir(addon, { recursive: true });
    await writeFile(file, '');
    await writeFile(path.join(addon, 'WispAI.toc'), '## Title: Wisp');
    return {
      folder,
      async hello(session: string, seq: number) {
        const packet = { type: 'hello', session, seq, at: seq, transportVersion: 2 };
        const [frame] = encodeMessage(Buffer.from(JSON.stringify(packet)), UPLINK_KIND, 1, seq);
        await writeFile(file, replaceUplink(await readFile(file, 'utf8'), frame));
      },
    };
  }
  try {
    const first = await game('first');
    const second = await game('second');
    const config = path.join(f.dataDirectory, 'config.local.json');
    await writeFile(config, JSON.stringify({ wow: first.folder }));
    bridge = await startBridge(f.options);
    const state = bridge.state;
    const { port, token } = JSON.parse(
      await readFile(path.join(f.dataDirectory, 'runtime/desktop.json'), 'utf8'),
    );
    async function request(route: string, body?: unknown) {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, data: await response.json() };
    }
    const transport = (action: 'pause' | 'resume', wow?: string) =>
      request('/addon/transport', { action, wow });

    await first.hello('cached', 1);
    expect(state.activeTransport).toBe('');
    expect(startAgent).toHaveBeenCalledTimes(1);
    expect((await request('/status')).status).toBe(200);

    // The upgrade path resumes the configured folder once the addon is ready.
    expect((await transport('resume')).status).toBe(200);
    expect(state.activeTransport).toBe('');
    await first.hello('first', 2);
    await vi.waitFor(() => expect(state.activeTransport).toBe('first'), { timeout: 3000 });

    expect((await transport('pause')).status).toBe(200);
    expect(state.activeTransport).toBe('');
    const saved = await request('/connections/save', {
      provider: 'compatible',
      name: 'Local model',
      baseURL: 'http://localhost:1234/v1',
      models: [{ id: 'local-test', contextWindow: 64000 }],
    });
    expect(saved.status).toBe(200);
    expect((await transport('resume', path.join(f.dataDirectory, 'missing'))).status).toBe(400);
    expect(JSON.parse(await readFile(config, 'utf8')).wow).toBe(first.folder);

    // Failed installs can restore the previous folder. Successful installs switch it.
    expect((await transport('resume')).status).toBe(200);
    expect((await transport('resume', second.folder)).status).toBe(200);
    await first.hello('old-folder', 3);
    await second.hello('second', 4);
    await vi.waitFor(() => expect(state.activeTransport).toBe('second'), { timeout: 3000 });
    expect(JSON.parse(await readFile(config, 'utf8')).wow).toBe(second.folder);
    expect((await request('/status')).status).toBe(200);
    expect(startAgent).toHaveBeenCalledTimes(1);
    expect(f.agentStopped()).toBe(false);
  } finally {
    await bridge?.stop();
    await rm(f.dataDirectory, { recursive: true, force: true });
  }
});

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
    const { ChatStore } = await import('../src/chat-store.ts');
    const store = new ChatStore(path.join(f.dataDirectory, 'runtime/wisp.sqlite'), () => {});
    const saved = await store.load();
    await store.close();
    expect(saved.map((chat: { id: string }) => chat.id)).toContain('chat');
    expect(saved.find((chat: { id: string }) => chat.id === 'chat')!.messages).toEqual([
      { role: 'user', text: 'Hello' },
    ]);
    expect(saved.map((chat: { id: string }) => chat.id)).not.toContain('draft');
    await vi.waitFor(() => expect(f.agentStopped()).toBe(true));
    await bridge.stop();
  } finally {
    await bridge?.stop();
    await rm(f.dataDirectory, { recursive: true, force: true });
  }
});

test('occupied bridge ports fall back to distinct listeners that both clients can reach', async () => {
  const f = await fixture();
  const occupied = createServer();
  await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve));
  const port = (occupied.address() as { port: number }).port;
  const startAgent = vi.fn(f.options.startAgent!);
  let bridge: Awaited<ReturnType<typeof startBridge>> | undefined;
  try {
    bridge = await startBridge({ ...f.options, agentPort: port, desktopPort: port, startAgent });
    const { WOW_BRIDGE_URL, WOW_BRIDGE_TOKEN } = startAgent.mock.calls[0][0].environment;
    const agentPort = Number(new URL(WOW_BRIDGE_URL!).port);
    const desktop = JSON.parse(
      await readFile(path.join(f.dataDirectory, 'runtime/desktop.json'), 'utf8'),
    );
    expect(new Set([port, agentPort, desktop.port]).size).toBe(3);

    const agentResponse = await fetch(WOW_BRIDGE_URL + '/session-model?session=missing', {
      headers: { authorization: 'Bearer ' + WOW_BRIDGE_TOKEN },
    });
    expect(agentResponse.status).toBe(503);
    expect(await agentResponse.text()).toBe('No model selected for this turn.');

    const desktopResponse = await fetch('http://127.0.0.1:' + desktop.port + '/status', {
      headers: { authorization: 'Bearer ' + desktop.token },
    });
    expect(desktopResponse.status).toBe(200);
    expect(statusSchema.safeParse(await desktopResponse.json()).success).toBe(true);
  } finally {
    await bridge?.stop();
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
    await rm(f.dataDirectory, { recursive: true, force: true });
  }
});

test('a late startup failure closes the agent and already-started runtime resources', async () => {
  const f = await fixture();
  try {
    await expect(startBridge({ ...f.options, desktopPort: -1 })).rejects.toMatchObject({
      code: 'ERR_SOCKET_BAD_PORT',
    });
    await vi.waitFor(() => expect(f.agentStopped()).toBe(true));
  } finally {
    await rm(f.dataDirectory, { recursive: true, force: true });
  }
});

test('desktop API saves a provider and model without WoW or a working Eve process', async () => {
  const f = await fixture(false);
  const startAgent = vi.fn(() => {
    throw Error('Agent unavailable');
  });
  f.options.startAgent = startAgent;
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
    expect(startAgent).toHaveBeenCalled();
    expect(status).toMatchObject({ ready: false, gameConnected: false, modelConnected: true });
    expect(status.auth.status).toBe('signed_out');
    expect(
      JSON.parse(await readFile(path.join(f.dataDirectory, 'config.local.json'), 'utf8')),
    ).toEqual({
      model: models[0].slug,
    });
    expect(status.connections[0]?.models[0]?.contextWindow).toBe(64000);
    await request('/connections/remove', { id });
    expect((await request('/status')).modelConnected).toBe(false);
  } finally {
    await bridge?.stop();
    await rm(f.dataDirectory, { recursive: true, force: true });
  }
});
