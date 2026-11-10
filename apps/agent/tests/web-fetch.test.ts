import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { dynamicEvaluate } from '../node_modules/eve/dist/src/dynamic/definition.js';
import definition from '../agent/tools/web_fetch.ts';
import type { WebFetchInput } from '../src/web-fetch.ts';
import { WebFetchPages } from '../src/web-fetch-pages.ts';
import { defaultCapabilities, publicToolName } from '@wisp/protocol/capabilities';
import { publicWebAddresses } from '../src/public-web-tunnel.ts';
import { publicWebTunnel } from '../src/public-web-tunnel.ts';
import { request } from 'node:http';

const { impitFetch, impitOptions, dnsLookup } = vi.hoisted(() => ({
  impitFetch: vi.fn(),
  impitOptions: vi.fn(),
  dnsLookup: vi.fn(),
}));
vi.mock('../src/impit-client.ts', () => ({
  impitClient(options: unknown) {
    impitOptions(options);
    return { fetch: impitFetch };
  },
}));
vi.mock('node:dns/promises', () => ({ lookup: dnsLookup }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.useRealTimers();
});

async function tool() {
  vi.stubEnv('WOW_CAPABILITIES_FILE', '');
  const resolved = (await dynamicEvaluate(definition)({} as never))!;
  return {
    async execute(input: WebFetchInput, ctx: Parameters<typeof resolved.execute>[1]) {
      const result = await resolved.execute(input, {
        ...ctx,
        session: { id: 'fetch-test' },
      } as never);
      if (!('content' in result)) {
        throw new Error('Unexpected streaming result');
      }
      return result;
    },
  };
}

test('fetch is registered independently of Wowhead search and respects its own switch', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'wisp-fetch-'));
  try {
    const file = path.join(directory, 'capabilities.json');
    vi.stubEnv('WOW_CAPABILITIES_FILE', file);
    await writeFile(file, JSON.stringify({ enabled: { 'tool:web_search': false } }));
    expect(await dynamicEvaluate(definition)({} as never)).toMatchObject({ deferred: true });
    await writeFile(file, JSON.stringify({ enabled: { 'tool:web_fetch': false } }));
    expect(await dynamicEvaluate(definition)({} as never)).toBeNull();
    expect(publicToolName('web_fetch')).toBe('web_fetch');
    expect(defaultCapabilities().find((c) => c.id === 'tool:web_fetch')).toMatchObject({
      parent: 'integration:web',
      toolName: 'web_fetch',
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('continuation reads the same snapshot without refetching or losing long-line Unicode content', async () => {
  const original = '🧙'.repeat(30000) + '\n' + 'tail\n'.repeat(2500);
  impitFetch.mockResolvedValueOnce(
    new Response(original, { headers: { 'content-type': 'text/plain' } }),
  );
  const fetchTool = await tool();
  let result = await fetchTool.execute(
    { url: 'https://example.com/guide', format: 'text' },
    {} as never,
  );
  let combined = result.content;
  const firstCursor = result.nextCursor!;
  while (result.nextCursor) {
    const previousEnd = result.endOffset;
    result = await fetchTool.execute({ url: result.url, cursor: result.nextCursor }, {} as never);
    expect(result.startOffset).toBe(previousEnd);
    expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(50 * 1024);
    combined += result.content;
  }
  expect(combined).toBe(original);
  expect(result.truncated).toBe(false);
  expect(result.endOffset).toBe(original.length);
  expect(impitFetch).toHaveBeenCalledTimes(1);
  const retry = await fetchTool.execute({ url: result.url, cursor: firstCursor }, {} as never);
  expect(retry.startOffset).toBeGreaterThan(0);
  await expect(
    fetchTool.execute({ url: result.url, cursor: firstCursor, format: 'html' }, {} as never),
  ).rejects.toThrow(/mismatch/i);
  await expect(
    fetchTool.execute({ url: 'https://example.com/other', cursor: firstCursor }, {} as never),
  ).rejects.toThrow(/mismatch/i);
});

test('cursor snapshots enforce conversation ownership, expiration and bounded retention', () => {
  vi.useFakeTimers();
  const pages = new WebFetchPages(1000, 110000);
  const snapshot = {
    content: 'x'.repeat(60000),
    contentType: 'text/plain',
    url: 'https://example.com/final',
    requestedUrl: 'https://example.com/original',
    format: 'text',
    owner: 'chat-a',
  };
  const first = pages.first(snapshot);
  expect(() => pages.next(first.nextCursor!, snapshot.url, 'chat-b')).toThrow(/mismatch/i);
  expect(pages.next(first.nextCursor!, snapshot.requestedUrl, 'chat-a').truncated).toBe(false);
  expect(() => pages.next(first.nextCursor!.split(':')[0] + ':1', snapshot.url, 'chat-a')).toThrow(
    /Invalid/i,
  );
  vi.advanceTimersByTime(1001);
  expect(() => pages.next(first.nextCursor!, snapshot.url, 'chat-a')).toThrow(/expired/i);
  const second = pages.first(snapshot);
  pages.first(snapshot); // Exceeds the total cache budget, evicting the oldest.
  expect(() => pages.next(second.nextCursor!, snapshot.url, 'chat-a')).toThrow(/expired/i);
});

test('Impit converts HTML to Markdown without scripts and sends the working navigation headers', async () => {
  const fetcher = vi.fn(
    async () =>
      new Response(
        '<html><h1>Guide</h1><p>Read <a href="https://example.com/details">details</a>.</p><script>evil()</script></html>',
        { headers: { 'content-type': 'text/html' } },
      ),
  );
  impitFetch.mockImplementation(fetcher);
  const result = await (await tool()).execute({ url: 'https://example.com/guide' }, {} as never);
  expect(result).toMatchObject({ url: 'https://example.com/guide', truncated: false });
  expect(result.content).toContain('# Guide');
  expect(result.content).toContain('[details](https://example.com/details)');
  expect(result.content).not.toContain('evil()');
  expect(fetcher.mock.calls[0]).toBeTruthy();
  expect(impitOptions).toHaveBeenCalledWith(
    expect.objectContaining({
      browser: 'chrome',
      proxyUrl: expect.stringContaining('@127.0.0.1:'),
      headers: expect.objectContaining({
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Dest': 'document',
      }),
    }),
  );
});

test('Impit preserves HTTP challenge failures without retry loops', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      new Response('Forbidden', { status: 403, headers: { 'cf-mitigated': 'challenge' } }),
    );
  impitFetch.mockImplementation(fetcher);
  const result = await (await tool()).execute({ url: 'https://example.com' }, {} as never);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(result.content).toContain('Request failed with status code: 403');
});

test.each([
  'http://example.com',
  'https://localhost',
  'https://127.0.0.1',
  'https://169.254.169.254',
  'https://[::1]',
])('rejects unsafe destination %s before fetching', async (url) => {
  const fetcher = vi.fn();
  impitFetch.mockImplementation(fetcher);
  await expect((await tool()).execute({ url }, {} as never)).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});

test('validates redirect targets and bounds response size and model output', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private' } }),
    );
  impitFetch.mockImplementation(fetcher);
  const fetchTool = await tool();
  await expect(fetchTool.execute({ url: 'https://example.com' }, {} as never)).rejects.toThrow(
    /private|localhost/i,
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
  fetcher.mockResolvedValue(new Response('large', { headers: { 'content-length': '6000000' } }));
  await expect(fetchTool.execute({ url: 'https://example.com' }, {} as never)).rejects.toThrow(
    /too large/i,
  );
  fetcher.mockResolvedValue(
    new Response('a'.repeat(100000), { headers: { 'content-type': 'text/plain' } }),
  );
  const result = await fetchTool.execute({ url: 'https://example.com' }, {} as never);
  expect(result.truncated).toBe(true);
  expect(result.content.length).toBeLessThan(100000);
});

test('DNS validation rejects mixed public/private answers and IPv4-mapped loopback', async () => {
  dnsLookup.mockResolvedValue([
    { address: '93.184.216.34', family: 4 },
    { address: '10.0.0.1', family: 4 },
  ]);
  await expect(publicWebAddresses('example.com')).rejects.toThrow(/private/i);
  dnsLookup.mockResolvedValue([{ address: '::ffff:127.0.0.1', family: 6 }]);
  await expect(publicWebAddresses('example.com')).rejects.toThrow(/private/i);
  dnsLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  expect(await publicWebAddresses('example.com')).toHaveLength(1);
});

test('the CONNECT tunnel checks authentication and rejects private DNS answers before dialing', async () => {
  const tunnel = await publicWebTunnel(new AbortController().signal);
  const proxy = new URL(tunnel.proxyUrl);
  tunnel.allow(new URL('https://example.com'));
  const connectStatus = (authorized: boolean) =>
    new Promise<number>((resolve, reject) => {
      const req = request({
        hostname: proxy.hostname,
        port: proxy.port,
        method: 'CONNECT',
        path: 'example.com:443',
        headers: authorized
          ? {
              'Proxy-Authorization':
                'Basic ' + Buffer.from(proxy.username + ':' + proxy.password).toString('base64'),
            }
          : {},
      });
      req.on('connect', (res, socket) => {
        socket.destroy();
        resolve(res.statusCode!);
      });
      req.on('error', reject);
      req.end();
    });
  try {
    expect(await connectStatus(false)).toBe(403);
    expect(dnsLookup).not.toHaveBeenCalled();
    dnsLookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    expect(await connectStatus(true)).toBe(403);
    expect(tunnel.failure()?.message).toMatch(/private/i);
  } finally {
    tunnel.close();
  }
});

test('enforces streamed size limits, cancellation, redirects and text/HTML formats', async () => {
  const fetchTool = await tool();
  impitFetch.mockResolvedValue(new Response('x'.repeat(5 * 1024 * 1024 + 1)));
  await expect(fetchTool.execute({ url: 'https://example.com' }, {} as never)).rejects.toThrow(
    /too large/i,
  );
  const controller = new AbortController();
  controller.abort();
  await expect(
    fetchTool.execute({ url: 'https://example.com' }, { abortSignal: controller.signal } as never),
  ).rejects.toThrow();
  impitFetch.mockResolvedValue(new Response(null, { status: 302, headers: { location: '/loop' } }));
  await expect(fetchTool.execute({ url: 'https://example.com' }, {} as never)).rejects.toThrow(
    /redirects/i,
  );
  for (const format of ['text', 'html'] as const) {
    impitFetch.mockResolvedValue(
      new Response('<html><body><p>Guide</p></body></html>', {
        headers: { 'content-type': 'text/html' },
      }),
    );
    const result = await fetchTool.execute({ url: 'https://example.com', format }, {} as never);
    expect(result.content).toContain(format === 'html' ? '<p>Guide</p>' : 'Guide');
    if (format === 'text') {
      expect(result.content).not.toContain('<p>');
    }
  }
});
