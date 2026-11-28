import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import { describe, expect, it } from '@effect/vitest';
import { defaultCapabilities, publicToolName } from '@wisp/protocol/capabilities';
import {
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Redacted,
  Ref,
  Schema,
} from 'effect';
import { TestClock } from 'effect/testing';
import type { LookupAddress } from 'node:dns';
import { request } from 'node:http';
import { connect } from 'node:net';
import path from 'node:path';
import * as Capabilities from '../src/host/capabilities.ts';
import * as Impit from '../src/integrations/web/impit-client.ts';
import * as Tunnel from '../src/integrations/web/public-web-tunnel.ts';
import * as Pages from '../src/integrations/web/web-fetch-pages.ts';
import * as WebFetch from '../src/integrations/web/web-fetch.ts';
import { toolOffered } from '../src/tools/enabled-tool.ts';
import definition from '../src/wisp/tools/web_fetch.ts';

/** impit answered by the test, without network: its clients and requests are recorded. */
class ImpitTest extends Context.Service<
  ImpitTest,
  {
    /** Answers every later request with `respond`. */
    readonly answer: (respond: (url: URL) => Effect.Effect<Response>) => Effect.Effect<void>;
    readonly requests: Effect.Effect<readonly string[]>;
    readonly clients: Effect.Effect<readonly Impit.ClientOptions[]>;
  }
>()('test/ImpitTest') {}

const impitTest = Layer.effectContext(
  Effect.gen(function* () {
    const respond = yield* Ref.make<(url: URL) => Effect.Effect<Response>>((url) =>
      Effect.die(new Error('Unexpected request ' + url)),
    );
    const requests = yield* Ref.make<readonly string[]>([]);
    const clients = yield* Ref.make<readonly Impit.ClientOptions[]>([]);
    const impit = Impit.Service.of({
      client: (options) =>
        Ref.update(clients, (all) => [...all, options]).pipe(
          Effect.as({
            fetch: (url: URL) =>
              Ref.update(requests, (all) => [...all, url.href]).pipe(
                Effect.andThen(Ref.get(respond)),
                Effect.flatMap((answer) => answer(url)),
                Effect.map(Impit.webResponse),
              ),
          }),
        ),
    });
    return Context.make(Impit.Service, impit).pipe(
      Context.add(
        ImpitTest,
        ImpitTest.of({
          answer: (answer) => Ref.set(respond, answer),
          requests: Ref.get(requests),
          clients: Ref.get(clients),
        }),
      ),
    );
  }),
);

/** The resolver answered by the test; it records the hosts it is asked for. */
class ResolverTest extends Context.Service<
  ResolverTest,
  {
    readonly answer: (addresses: readonly LookupAddress[]) => Effect.Effect<void>;
    readonly hosts: Effect.Effect<readonly string[]>;
  }
>()('test/ResolverTest') {}

const resolverTest = Layer.effectContext(
  Effect.gen(function* () {
    const answer = yield* Ref.make<readonly LookupAddress[]>([]);
    const hosts = yield* Ref.make<readonly string[]>([]);
    const resolver = Tunnel.Resolver.of({
      lookup: (host) =>
        Ref.update(hosts, (all) => [...all, host]).pipe(Effect.andThen(Ref.get(answer))),
    });
    return Context.make(Tunnel.Resolver, resolver).pipe(
      Context.add(
        ResolverTest,
        ResolverTest.of({
          answer: (addresses) => Ref.set(answer, addresses),
          hosts: Ref.get(hosts),
        }),
      ),
    );
  }),
);

const pagesLayer = (options: Parameters<typeof Pages.make>[0]) =>
  Layer.effect(Pages.Service, Pages.make(options)).pipe(
    Layer.provide(NodeCrypto.layerSecureRandom),
  );

/** Web fetch over the real tunnel and page store, with impit and the resolver answered by the test. */
const webFetchLayer = Layer.effect(WebFetch.Service, WebFetch.make).pipe(
  Layer.provide(pagesLayer({ ttl: '10 minutes', maxBytes: 32 * 1024 * 1024 })),
  Layer.provide(Layer.effect(Tunnel.Service, Tunnel.make)),
  Layer.provideMerge(impitTest),
  Layer.provideMerge(resolverTest),
  Layer.provide(NodeCrypto.layerSecureRandom),
);

const fetchPage = (input: WebFetch.Input) =>
  Effect.flatMap(WebFetch.Service, (web) => web.fetch(input, 'fetch-test'));

const answer = (respond: () => Response) =>
  Effect.flatMap(ImpitTest, (impit) => impit.answer(() => Effect.sync(respond)));

const failureOf = <A, E extends Error>(effect: Effect.Effect<A, E, WebFetch.Service>) =>
  Effect.map(Effect.flip(effect), (error) => error.message);

/** Whether the loopback `port` refuses connections: a closed tunnel does. */
const refusesConnections = (port: number) =>
  Effect.callback<boolean>((resume) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resume(Effect.succeed(false));
    });
    socket.once('error', () => resume(Effect.succeed(true)));
  });

/** The port of the tunnel the latest impit client went through. */
const proxyPort = Effect.flatMap(ImpitTest, (impit) => impit.clients).pipe(
  Effect.map((clients) =>
    Number(new URL(Redacted.value(clients.at(-1)?.proxyUrl ?? Redacted.make(''))).port),
  ),
);

describe('web_fetch', () => {
  it.effect('fetch is registered independently of Wowhead search and respects its own switch', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = path.join(
        yield* fs.makeTempDirectoryScoped({ prefix: 'wisp-fetch-' }),
        'capabilities.json',
      );
      const offered = Effect.flatMap(Capabilities.Service, (settings) => settings.read).pipe(
        Effect.map((capabilities) => toolOffered(definition, capabilities)),
        Effect.provide(Capabilities.layerFromFile(() => file)),
      );
      yield* fs.writeFileString(file, JSON.stringify({ enabled: { 'tool:web_search': false } }));
      expect(yield* offered).toBe(true);
      expect(definition.deferred).toBe(false);
      yield* fs.writeFileString(file, JSON.stringify({ enabled: { 'tool:web_fetch': false } }));
      expect(yield* offered).toBe(false);
      expect(publicToolName('web_fetch')).toBe('web_fetch');
      expect(defaultCapabilities().find((c) => c.id === 'tool:web_fetch')).toMatchObject({
        parent: 'integration:web',
        toolName: 'web_fetch',
      });
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.effect(
    'the tool reads the page for its conversation and stops when the turn is cancelled',
    () =>
      Effect.gen(function* () {
        yield* answer(
          () => new Response('x'.repeat(60_000), { headers: { 'content-type': 'text/plain' } }),
        );
        const webFetch = yield* WebFetch.Service;
        const runEffect = Effect.runPromiseWith(yield* Effect.context<never>());
        const execute = (input: unknown, abortSignal: AbortSignal) =>
          Schema.decodeUnknownEffect(WebFetch.Input)(input).pipe(
            Effect.flatMap((decoded) =>
              Effect.tryPromise({
                try: () =>
                  Promise.resolve(
                    definition.execute(decoded, {
                      session: { id: 'chat-a' },
                      abortSignal,
                      callId: 'call',
                      webFetch,
                      runEffect,
                    }),
                  ),
                catch: (error) => (error instanceof Error ? error : new Error(String(error))),
              }),
            ),
          );
        const open = yield* Effect.abortSignal;
        // The URL is trimmed, as zod's `.url()` did.
        const first = yield* execute({ url: ' https://example.com/guide ' }, open);
        expect(first).toMatchObject({ url: 'https://example.com/guide', truncated: true });
        const cursor = first.nextCursor ?? '';
        // The snapshot belongs to the tool call's conversation.
        expect(yield* execute({ url: first.url, cursor }, open)).toMatchObject({
          truncated: false,
        });
        expect(
          yield* Effect.flatMap(WebFetch.Service, (web) =>
            Effect.flip(web.fetch({ url: first.url, cursor }, 'chat-b')),
          ),
        ).toMatchObject({ _tag: 'InvalidWebCursor' });

        expect(
          Exit.isFailure(
            yield* Effect.exit(execute({ url: 'https://example.com/other' }, AbortSignal.abort())),
          ),
        ).toBe(true);
        expect(yield* Effect.flatMap(ImpitTest, (impit) => impit.requests)).toEqual([
          'https://example.com/guide',
        ]);
      }).pipe(Effect.provide(webFetchLayer)),
  );

  it.effect(
    'continuation reads the same snapshot without refetching or losing long-line Unicode content',
    () =>
      Effect.gen(function* () {
        const original = '🧙'.repeat(30000) + '\n' + 'tail\n'.repeat(2500);
        yield* answer(() => new Response(original, { headers: { 'content-type': 'text/plain' } }));
        let result = yield* fetchPage({ url: 'https://example.com/guide', format: 'text' });
        let combined = result.content;
        const firstCursor = result.nextCursor ?? '';
        while (result.nextCursor) {
          const previousEnd = result.endOffset;
          result = yield* fetchPage({ url: result.url, cursor: result.nextCursor });
          expect(result.startOffset).toBe(previousEnd);
          expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(50 * 1024);
          combined += result.content;
        }
        expect(combined).toBe(original);
        expect(result.truncated).toBe(false);
        expect(result.endOffset).toBe(original.length);
        expect(yield* Effect.flatMap(ImpitTest, (impit) => impit.requests)).toHaveLength(1);
        const retry = yield* fetchPage({ url: result.url, cursor: firstCursor });
        expect(retry.startOffset).toBeGreaterThan(0);
        expect(
          yield* failureOf(fetchPage({ url: result.url, cursor: firstCursor, format: 'html' })),
        ).toMatch(/mismatch/i);
        expect(
          yield* failureOf(fetchPage({ url: 'https://example.com/other', cursor: firstCursor })),
        ).toMatch(/mismatch/i);
      }).pipe(Effect.provide(webFetchLayer)),
  );

  it.effect(
    'cursor snapshots enforce conversation ownership, expiration and bounded retention',
    () =>
      Effect.gen(function* () {
        const pages = yield* Pages.Service;
        const snapshot = {
          content: 'x'.repeat(60_000),
          contentType: 'text/plain',
          url: 'https://example.com/final',
          requestedUrl: 'https://example.com/original',
          format: 'text',
          owner: 'chat-a',
        };
        const failure = <A, E extends Error>(effect: Effect.Effect<A, E>) =>
          Effect.map(Effect.flip(effect), (error) => error.message);
        const first = yield* pages.first(snapshot);
        const cursor = first.nextCursor ?? '';
        expect(yield* failure(pages.next(cursor, snapshot.url, 'chat-b'))).toMatch(/mismatch/i);
        expect((yield* pages.next(cursor, snapshot.requestedUrl, 'chat-a')).truncated).toBe(false);
        expect(
          yield* failure(pages.next(cursor.split(':')[0] + ':1', snapshot.url, 'chat-a')),
        ).toMatch(/Invalid/i);
        yield* TestClock.adjust(1001);
        expect(yield* failure(pages.next(cursor, snapshot.url, 'chat-a'))).toMatch(/expired/i);
        const second = yield* pages.first(snapshot);
        yield* pages.first(snapshot); // Exceeds the total cache budget, evicting the oldest.
        expect(yield* failure(pages.next(second.nextCursor ?? '', snapshot.url, 'chat-a'))).toMatch(
          /expired/i,
        );
        expect(yield* failure(pages.first({ ...snapshot, content: 'x'.repeat(120_000) }))).toMatch(
          /too large to retain/i,
        );
      }).pipe(Effect.provide(pagesLayer({ ttl: 1000, maxBytes: 110_000 }))),
  );

  it.effect(
    'Impit converts HTML to Markdown without scripts and sends the working navigation headers',
    () =>
      Effect.gen(function* () {
        yield* answer(
          () =>
            new Response(
              '<html><h1>Guide</h1><p>Read <a href="https://example.com/details">details</a>.</p><script>evil()</script></html>',
              { headers: { 'content-type': 'text/html' } },
            ),
        );
        const result = yield* fetchPage({ url: 'https://example.com/guide' });
        expect(result).toMatchObject({ url: 'https://example.com/guide', truncated: false });
        expect(result.content).toContain('# Guide');
        expect(result.content).toContain('[details](https://example.com/details)');
        expect(result.content).not.toContain('evil()');
        const [client] = yield* Effect.flatMap(ImpitTest, (impit) => impit.clients);
        expect(client).toMatchObject({
          browser: 'chrome',
          timeout: 30_000,
          headers: expect.objectContaining({
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Dest': 'document',
          }),
        });
        expect(Redacted.value(client?.proxyUrl ?? Redacted.make(''))).toContain('@127.0.0.1:');
      }).pipe(Effect.provide(webFetchLayer)),
  );

  it.effect('Impit preserves HTTP challenge failures without retry loops', () =>
    Effect.gen(function* () {
      yield* answer(
        () => new Response('Forbidden', { status: 403, headers: { 'cf-mitigated': 'challenge' } }),
      );
      const result = yield* fetchPage({ url: 'https://example.com' });
      expect(yield* Effect.flatMap(ImpitTest, (impit) => impit.requests)).toHaveLength(1);
      expect(result.content).toContain('Request failed with status code: 403');
    }).pipe(Effect.provide(webFetchLayer)),
  );

  it.effect('rejects unsafe destinations before fetching', () =>
    Effect.gen(function* () {
      for (const url of [
        'http://example.com',
        'https://localhost',
        'https://127.0.0.1',
        'https://169.254.169.254',
        'https://[::1]',
        'https://user:secret@example.com',
      ]) {
        expect(yield* Effect.flip(fetchPage({ url }))).toMatchObject({
          _tag: 'UnsafeWebDestination',
        });
      }
      expect(yield* Effect.flatMap(ImpitTest, (impit) => impit.requests)).toEqual([]);
    }).pipe(Effect.provide(webFetchLayer)),
  );

  it.effect('validates redirect targets and bounds response size and model output', () =>
    Effect.gen(function* () {
      yield* answer(
        () =>
          new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private' } }),
      );
      expect(yield* failureOf(fetchPage({ url: 'https://example.com' }))).toMatch(
        /private|localhost/i,
      );
      expect(yield* Effect.flatMap(ImpitTest, (impit) => impit.requests)).toHaveLength(1);
      yield* answer(() => new Response('large', { headers: { 'content-length': '6000000' } }));
      expect(yield* failureOf(fetchPage({ url: 'https://example.com' }))).toMatch(/too large/i);
      yield* answer(
        () => new Response('a'.repeat(100_000), { headers: { 'content-type': 'text/plain' } }),
      );
      const result = yield* fetchPage({ url: 'https://example.com' });
      expect(result.truncated).toBe(true);
      expect(result.content.length).toBeLessThan(100_000);
    }).pipe(Effect.provide(webFetchLayer)),
  );

  it.effect('DNS validation rejects mixed public/private answers and IPv4-mapped loopback', () =>
    Effect.gen(function* () {
      const resolver = yield* ResolverTest;
      const failure = Effect.map(
        Effect.flip(Tunnel.publicWebAddresses('example.com')),
        (error) => error.message,
      );
      yield* resolver.answer([
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.1', family: 4 },
      ]);
      expect(yield* failure).toMatch(/private/i);
      yield* resolver.answer([{ address: '::ffff:127.0.0.1', family: 6 }]);
      expect(yield* failure).toMatch(/private/i);
      yield* resolver.answer([]);
      expect(yield* failure).toMatch(/private/i);
      yield* resolver.answer([{ address: '93.184.216.34', family: 4 }]);
      expect(yield* Tunnel.publicWebAddresses('example.com')).toHaveLength(1);
    }).pipe(Effect.provide(resolverTest)),
  );

  it.effect(
    'the CONNECT tunnel checks authentication and rejects private DNS answers before dialing',
    () =>
      Effect.gen(function* () {
        const tunnels = yield* Tunnel.Service;
        const resolver = yield* ResolverTest;
        const tunnel = yield* tunnels.open;
        const proxy = new URL(Redacted.value(tunnel.proxyUrl));
        yield* tunnel.allow(new URL('https://example.com'));
        const connectStatus = (authorized: boolean) =>
          Effect.callback<number, Error>((resume) => {
            const req = request({
              hostname: proxy.hostname,
              port: proxy.port,
              method: 'CONNECT',
              path: 'example.com:443',
              headers: authorized
                ? {
                    'Proxy-Authorization':
                      'Basic ' +
                      Buffer.from(proxy.username + ':' + proxy.password).toString('base64'),
                  }
                : {},
            });
            req.on('connect', (res, socket) => {
              socket.destroy();
              resume(Effect.succeed(res.statusCode ?? 0));
            });
            req.on('error', (error) => resume(Effect.fail(error)));
            req.end();
          });
        expect(yield* connectStatus(false)).toBe(403);
        expect(yield* resolver.hosts).toEqual([]);
        expect(yield* tunnel.failure).toMatchObject({
          value: { message: 'Unapproved web destination.' },
        });
        yield* resolver.answer([{ address: '127.0.0.1', family: 4 }]);
        expect(yield* connectStatus(true)).toBe(403);
        expect(yield* resolver.hosts).toEqual(['example.com']);
        expect(yield* tunnel.failure).toMatchObject({
          value: { message: expect.stringMatching(/private/i) },
        });
      }).pipe(
        Effect.provide(
          Layer.effect(Tunnel.Service, Tunnel.make).pipe(
            Layer.provideMerge(resolverTest),
            Layer.provide(NodeCrypto.layerSecureRandom),
          ),
        ),
      ),
  );

  it.effect('enforces streamed size limits, redirects and text/HTML formats', () =>
    Effect.gen(function* () {
      yield* answer(() => new Response('x'.repeat(5 * 1024 * 1024 + 1)));
      expect(yield* failureOf(fetchPage({ url: 'https://example.com' }))).toMatch(/too large/i);
      yield* answer(() => new Response(null, { status: 302, headers: { location: '/loop' } }));
      expect(yield* failureOf(fetchPage({ url: 'https://example.com' }))).toMatch(/redirects/i);
      // The first request and ten redirects.
      expect((yield* Effect.flatMap(ImpitTest, (impit) => impit.requests)).slice(1)).toHaveLength(
        11,
      );
      for (const format of ['text', 'html'] as const) {
        yield* answer(
          () =>
            new Response('<html><body><p>Guide</p></body></html>', {
              headers: { 'content-type': 'text/html' },
            }),
        );
        const result = yield* fetchPage({ url: 'https://example.com', format });
        expect(result.content).toContain(format === 'html' ? '<p>Guide</p>' : 'Guide');
        if (format === 'text') {
          expect(result.content).not.toContain('<p>');
        }
      }
    }).pipe(Effect.provide(webFetchLayer)),
  );

  it.effect('times out after the requested seconds, at most 120, and closes the tunnel', () =>
    Effect.gen(function* () {
      for (const [timeout, seconds] of [
        [undefined, 30],
        [500, 120],
      ] as const) {
        const arrived = yield* Deferred.make<void>();
        yield* Effect.flatMap(ImpitTest, (impit) =>
          impit.answer(() =>
            Deferred.succeed(arrived, undefined).pipe(Effect.andThen(Effect.never)),
          ),
        );
        const fiber = yield* fetchPage({
          url: 'https://example.com',
          ...(timeout === undefined ? {} : { timeout }),
        }).pipe(Effect.forkChild);
        yield* Deferred.await(arrived);
        yield* TestClock.adjust(seconds * 1000 - 1);
        expect(fiber.pollUnsafe()).toBeUndefined();
        yield* TestClock.adjust(1);
        expect(yield* Effect.flip(Fiber.join(fiber))).toMatchObject({
          _tag: 'WebFetchFailed',
          message: 'The operation was aborted due to timeout',
        });
        expect(yield* refusesConnections(yield* proxyPort)).toBe(true);
        expect((yield* Effect.flatMap(ImpitTest, (impit) => impit.clients)).at(-1)).toMatchObject({
          timeout: seconds * 1000,
        });
      }
    }).pipe(Effect.provide(webFetchLayer)),
  );

  it.effect('interrupting a fetch cancels the request and closes the tunnel', () =>
    Effect.gen(function* () {
      const arrived = yield* Deferred.make<void>();
      const cancelled = yield* Deferred.make<void>();
      yield* Effect.flatMap(ImpitTest, (impit) =>
        impit.answer(() =>
          Deferred.succeed(arrived, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(cancelled, undefined)),
          ),
        ),
      );
      const fiber = yield* fetchPage({ url: 'https://example.com' }).pipe(Effect.forkChild);
      yield* Deferred.await(arrived);
      yield* Fiber.interrupt(fiber);
      yield* Deferred.await(cancelled);
      expect(yield* refusesConnections(yield* proxyPort)).toBe(true);
    }).pipe(Effect.provide(webFetchLayer)),
  );

  it.effect(
    'impit reaches the tunnel with its credentials, and the refusal explains the failure',
    () =>
      Effect.gen(function* () {
        const resolver = yield* ResolverTest;
        yield* resolver.answer([{ address: '127.0.0.1', family: 4 }]);
        expect(yield* Effect.flip(fetchPage({ url: 'https://example.com/guide' }))).toMatchObject({
          _tag: 'UnsafeWebDestination',
          message: 'URL must not resolve to private, localhost or reserved addresses.',
        });
        // Only an authenticated CONNECT for the approved host gets as far as DNS.
        expect(yield* resolver.hosts).toEqual(['example.com']);
      }).pipe(
        Effect.provide(
          Layer.effect(WebFetch.Service, WebFetch.make).pipe(
            Layer.provide(pagesLayer({ ttl: '10 minutes', maxBytes: 32 * 1024 * 1024 })),
            Layer.provide(Layer.effect(Tunnel.Service, Tunnel.make)),
            Layer.provide(Impit.layer),
            Layer.provideMerge(resolverTest),
            Layer.provide(NodeCrypto.layerSecureRandom),
          ),
        ),
      ),
  );

  it.effect('the system resolver answers for localhost, which is not public', () =>
    Effect.gen(function* () {
      expect(
        yield* Effect.flatMap(Tunnel.Resolver, (resolver) => resolver.lookup('localhost')),
      ).not.toEqual([]);
      expect(yield* Effect.flip(Tunnel.publicWebAddresses('localhost'))).toMatchObject({
        _tag: 'UnsafeWebDestination',
      });
    }).pipe(Effect.provide(Tunnel.resolverLayer)),
  );
});
