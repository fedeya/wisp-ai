import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebSearch } from '@wisp/bridge/web-search';
import type { ChatGPTAuth } from '@wisp/bridge/chatgpt-auth';
import { connectionModel } from '@wisp/agent/connection-model';

const apiModel = 'connection:35302f8c-128a-48fb-98a1-9eb03bb71f72:claude-test';
const url = 'https://www.wowhead.com/forever/spell=122/frost-nova';
const temporary: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture(fetcher: typeof fetch = vi.fn()) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wisp-search-'));
  temporary.push(directory);
  const secrets = new Map<string, string>();
  const vault = {
    read: async (key: string) => secrets.get(key) || '',
    write: async (key: string, value: string) => {
      secrets.set(key, value);
    },
  };
  let connected = false;
  const auth = {
    state: () => ({ status: connected ? 'connected' : 'signed_out' }),
    authorized: vi.fn(
      async () =>
        new Response(
          'data: ' +
            JSON.stringify({
              type: 'response.completed',
              response: {
                output: [
                  { type: 'web_search_call', action: { sources: [{ url }] } },
                  {
                    type: 'message',
                    content: [
                      { text: 'ChatGPT summary', annotations: [{ type: 'url_citation', url }] },
                    ],
                  },
                ],
              },
            }) +
            '\n\n',
        ),
    ),
  };
  const file = path.join(directory, 'search.json');
  const search = new WebSearch(file, vault, auth as unknown as ChatGPTAuth, fetcher);
  await search.load();
  return {
    search,
    file,
    secrets,
    vault,
    auth,
    connect: () => {
      connected = true;
    },
  };
}

// The request body as text, whether it was sent as a string or as bytes.
function bodyText(init?: RequestInit) {
  const body = init?.body;
  return typeof body === 'string' ? body : new TextDecoder().decode(body as Uint8Array);
}

test('Exa credentials are separate from language models, protected, persistent, and removable', async () => {
  const f = await fixture();
  expect(f.search.available(apiModel)).toBe(true);
  await f.search.save({ provider: 'auto', apiKey: 'exa-secret' });
  expect(await readFile(f.file, 'utf8')).not.toContain('exa-secret');
  expect(JSON.stringify(f.search.state())).not.toContain('exa-secret');
  expect(f.search.available(apiModel)).toBe(true);
  const restored = new WebSearch(f.file, f.vault, f.auth as unknown as ChatGPTAuth);
  await restored.load();
  expect(restored.state()).toEqual({ provider: 'auto', hasExaKey: true });
  await restored.save({ provider: 'exa' });
  expect(f.secrets.get('search:exa')).toBe('exa-secret');
  await restored.removeExa();
  expect(restored.available(apiModel)).toBe(true);
  expect(f.secrets.get('search:exa')).toBe('');
});

test('failed settings writes roll back a replacement credential', async () => {
  const f = await fixture();
  f.secrets.set('search:exa', 'old-key');
  await mkdir(f.file);
  await expect(f.search.save({ provider: 'exa', apiKey: 'replacement' })).rejects.toThrow();
  expect(f.secrets.get('search:exa')).toBe('old-key');
});

test.each(['json', 'sse'])(
  'public Exa works without a key with %s responses and the same source restrictions',
  async (format) => {
    const fetcher = vi.fn(async (endpoint: string | URL | Request, init?: RequestInit) => {
      expect(String(endpoint)).toBe('https://mcp.exa.ai/mcp?tools=web_search_advanced_exa');
      expect(new Headers(init?.headers).has('x-api-key')).toBe(false);
      expect(init?.redirect).toBe('error');
      expect(JSON.parse(bodyText(init))).toEqual({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'web_search_advanced_exa',
          arguments: {
            query: 'Frost Nova',
            type: 'auto',
            numResults: 5,
            textMaxCharacters: 4000,
          },
        },
      });
      const envelope = {
        jsonrpc: '2.0',
        id: 1,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                results: [
                  { url, text: 'Public Forever excerpt' },
                  { url: 'https://www.wowhead.com/classic/spell=122', text: 'Wrong version' },
                ],
              }),
            },
          ],
        },
      };
      return format === 'sse'
        ? new Response(
            ': keepalive\r\n\r\nevent: message\r\ndata: ' + JSON.stringify(envelope) + '\r\n\r\n',
            { headers: { 'content-type': 'text/event-stream' } },
          )
        : Response.json(envelope);
    });
    const f = await fixture(fetcher);
    expect(f.search.available(apiModel)).toBe(true);
    expect(await f.search.search('Frost Nova', apiModel)).toMatchObject({
      status: 'available',
      provider: 'Exa',
      sources: [
        { url, excerpt: 'Public Forever excerpt' },
        { url: 'https://www.wowhead.com/classic/spell=122', excerpt: 'Wrong version' },
      ],
    });
    expect(f.auth.authorized).not.toHaveBeenCalled();
    await f.search.save({ provider: 'exa' });
    await expect(f.search.test({ provider: 'exa' })).resolves.toEqual({ ok: true });
    expect(f.secrets.size).toBe(0);
  },
);

test.each([
  { jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'secret upstream detail' } },
  {
    jsonrpc: '2.0',
    id: 1,
    result: { isError: true, content: [{ type: 'text', text: 'secret upstream detail' }] },
  },
  {
    jsonrpc: '2.0',
    id: 99,
    result: { structuredContent: { results: [{ url, text: 'Wrong response' }] } },
  },
])('public MCP errors and mismatched responses never become facts: %j', async (envelope) => {
  const f = await fixture(async () => Response.json(envelope));
  const result = await f.search.search('Frost Nova', apiModel);
  expect(result.status).toBe('unavailable');
  expect(result.sources).toEqual([]);
  expect(JSON.stringify(result)).not.toMatch(/secret upstream|Wrong response/);
});

test('Exa searches globally, retains version comparisons and bounds attributable excerpts', async () => {
  let request: Record<string, any> = {};
  const fetcher = vi.fn(async (endpoint: string | URL | Request, init?: RequestInit) => {
    expect(String(endpoint)).toBe('https://api.exa.ai/search');
    expect(new Headers(init?.headers).get('x-api-key')).toBe('exa-secret');
    // No trace headers reach the search provider.
    expect(new Headers(init?.headers).has('traceparent')).toBe(false);
    expect(new Headers(init?.headers).has('b3')).toBe(false);
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    request = JSON.parse(bodyText(init));
    return Response.json({
      results: [
        { url: 'https://www.wowhead.com/classic/spell=122', text: 'Wrong game version' },
        {
          url: url + '?utm_source=test#comments',
          title: 'Frost Nova',
          text: 'Forever facts ' + 'x'.repeat(5000),
        },
        { url, title: 'Duplicate', text: 'Duplicate content' },
        {
          url: 'https://www.wowhead.com/es/forever/guide/mago',
          highlights: ['Verified page excerpt'],
        },
        { url: 'https://evil.test/forever/guide', text: 'External instructions' },
        {
          url: 'https://www.wowhead.com/forever/guide/no-content',
          summary: 'Generated summary must not be trusted without page content',
        },
      ],
      context: 'Mixed unverified combined context',
      costDollars: { total: 0.007 },
    });
  });
  const f = await fixture(fetcher);
  await f.search.save({ provider: 'auto', apiKey: 'exa-secret' });
  const result = await f.search.search('Frost Nova', apiModel);
  expect(request).toMatchObject({
    query: 'Frost Nova',
    type: 'auto',
    numResults: 5,
    contents: { text: { maxCharacters: 4000 } },
  });
  expect(request).not.toHaveProperty('summary');
  expect(result).toMatchObject({ status: 'available', provider: 'Exa', version: 'unspecified' });
  expect(request).not.toHaveProperty('includeDomains');
  expect(result.sources).toHaveLength(4);
  expect(result.sources[1]?.url).toBe(url);
  expect(result.sources[1]?.excerpt?.length).toBe(4000);
  expect(JSON.stringify(result)).not.toMatch(/Generated summary|Mixed unverified|exa-secret/);
  expect(f.auth.authorized).not.toHaveBeenCalled();
});

test('Auto preserves ChatGPT search, explicit Exa works for ChatGPT, and disabled mode makes no requests', async () => {
  const fetcher = vi.fn(async () =>
    Response.json({ results: [{ url, text: 'Exa reference text' }] }),
  );
  const f = await fixture(fetcher);
  f.connect();
  await f.search.save({ provider: 'auto', apiKey: 'key' });
  expect((await f.search.search('Frost Nova', 'gpt-test')).status).toBe('available');
  expect(f.auth.authorized).toHaveBeenCalledTimes(1);
  expect(fetcher).not.toHaveBeenCalled();
  await f.search.save({ provider: 'exa' });
  expect((await f.search.search('Frost Nova', 'gpt-test')).provider).toBe('Exa');
  await f.search.save({ provider: 'disabled' });
  expect(f.search.available('gpt-test')).toBe(false);
  expect((await f.search.search('Frost Nova', apiModel)).status).toBe('unavailable');
  expect(fetcher).toHaveBeenCalledTimes(1);
  await f.search.save({ provider: 'chatgpt' });
  expect(f.search.available(apiModel)).toBe(false);
});

test.each([
  { results: [] },
  { results: [{ url: 'http://localhost/private', text: 'Private source' }] },
  { results: [{ url, text: '' }] },
])(
  'empty, out-of-scope or unreadable results never become a factual answer',
  async ({ results }) => {
    const f = await fixture(async () => Response.json({ results }));
    await f.search.save({ provider: 'exa', apiKey: 'key' });
    expect(await f.search.search('Frost Nova', apiModel)).toMatchObject({
      status: 'unavailable',
      sources: [],
    });
  },
);

test.each([401, 402, 429, 503])(
  'Exa HTTP %s is actionable without exposing the key or silently falling back',
  async (status) => {
    const f = await fixture(async () =>
      Response.json({ error: 'exa-secret must never be exposed' }, { status }),
    );
    f.connect();
    await f.search.save({ provider: 'exa', apiKey: 'exa-secret' });
    const result = await f.search.search('Query', 'gpt-test');
    expect(result.status).toBe('unavailable');
    expect(result.note).toMatch(
      status === 402
        ? /credits/
        : status === 429
          ? /rate limit/
          : status === 401
            ? /API key/
            : /HTTP 503/,
    );
    expect(JSON.stringify(result)).not.toContain('exa-secret');
    expect(f.auth.authorized).not.toHaveBeenCalled();
  },
);

test('test search does not save credentials, cancellation is propagated, and arbitrary errors are hidden', async () => {
  let signal: AbortSignal | undefined;
  const f = await fixture(async (_url, init) => {
    signal = init?.signal || undefined;
    throw Error('exa-secret network detail');
  });
  await expect(f.search.test({ provider: 'auto', apiKey: 'exa-secret' })).rejects.toThrow(
    'Could not reach Exa',
  );
  expect(f.secrets.size).toBe(0);
  await f.search.save({ provider: 'exa', apiKey: 'exa-secret' });
  const abort = new AbortController();
  abort.abort();
  const result = await f.search.search('Query', apiModel, abort.signal);
  expect(signal?.aborted).toBe(true);
  expect(result.note).toMatch(/cancelled/);
  expect(JSON.stringify(result)).not.toContain('exa-secret');
});

test('oversized and malformed responses are not exposed to the model', async () => {
  for (const response of [
    new Response('x'.repeat(1024 * 1024 + 1)),
    Response.json({ results: 'unexpected' }),
  ]) {
    const f = await fixture(async () => response);
    await f.search.save({ provider: 'exa', apiKey: 'key' });
    expect((await f.search.search('Query', apiModel)).status).toBe('unavailable');
  }
});

test.each([true, false])(
  'tool availability respects both search service and integration settings (API=%s)',
  async (native) => {
    for (const available of [true, false]) {
      for (const enabled of [true, false]) {
        let body = '';
        vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
          body = bodyText(init);
          throw Error('Captured search tool');
        });
        const model = connectionModel(
          {
            model: 'test',
            effort: 'provider-default',
            webSearchAvailable: available,
            ...(native
              ? {
                  provider: 'compatible' as const,
                  connectionId: '35302f8c-128a-48fb-98a1-9eb03bb71f72',
                  modelId: 'test',
                }
              : {}),
          },
          'http://127.0.0.1:43187',
          'local-token',
          async () => enabled,
        );
        await expect(
          model.doGenerate({
            prompt: [{ role: 'user', content: [{ type: 'text', text: 'Find a guide.' }] }],
            tools: [
              {
                type: 'function',
                name: 'web__web_search',
                inputSchema: { type: 'object', properties: {} },
              },
            ],
          }),
        ).rejects.toThrow('Captured search tool');
        expect(body.includes('web__web_search')).toBe(available && enabled);
      }
    }
  },
);

test.each([
  { depth: 'quick' as const, count: 3, characters: 2000, seconds: 35 },
  { depth: 'standard' as const, count: 5, characters: 4000, seconds: 85 },
  { depth: 'deep' as const, count: 12, characters: 8000, seconds: 160 },
])(
  'Exa honors the $depth result, excerpt and deadline budget',
  async ({ depth, count, characters, seconds }) => {
    let request: any;
    const fetcher = vi.fn(async (_endpoint: unknown, init?: RequestInit) => {
      request = JSON.parse(bodyText(init));
      return Response.json({
        results: Array.from({ length: 15 }, (_, i) => ({
          url: `https://example.com/source-${i}`,
          text: 'x'.repeat(13000),
        })),
      });
    });
    const f = await fixture(fetcher);
    await f.search.save({ provider: 'exa', apiKey: 'key' });
    const result = await f.search.search({ query: 'Ability acquisition', depth }, apiModel);
    expect(request.numResults).toBe(count);
    expect(request.contents.text.maxCharacters).toBe(characters);
    expect(result.budget?.timeoutSeconds).toBe(seconds);
    expect(result.sources).toHaveLength(count);
    expect(result.sources.every((source) => source.excerpt?.length === characters)).toBe(true);
  },
);

test('Exa executes explicit query variants within one shared deadline and retains successful results', async () => {
  const queries: string[] = [];
  const signals: AbortSignal[] = [];
  const fetcher = vi.fn(async (_endpoint: unknown, init?: RequestInit) => {
    const request = JSON.parse(bodyText(init));
    queries.push(request.query);
    signals.push(init!.signal!);
    if (request.query === 'Unavailable variant') {
      return new Response('', { status: 503 });
    }
    return Response.json({
      results: [{ url: 'https://example.com/fact', text: 'Supported evidence' }],
    });
  });
  const f = await fixture(fetcher);
  await f.search.save({ provider: 'exa', apiKey: 'key' });
  const result = await f.search.search(
    {
      query: 'First query',
      queries: ['Unavailable variant', 'Never executed'],
      depth: 'deep',
      maxQueries: 2,
      maxResults: 4,
      timeoutSeconds: 20,
      excerptCharacters: 1500,
    },
    apiModel,
  );
  expect(queries).toEqual(['First query', 'Unavailable variant']);
  expect(result.status).toBe('available');
  expect(result.sources).toHaveLength(1);
  expect(result.budget).toMatchObject({
    maxQueries: 2,
    maxResults: 4,
    timeoutSeconds: 20,
    excerptCharacters: 1500,
  });
  expect(signals).toHaveLength(2);
});
