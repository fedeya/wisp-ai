import { expect, it } from '@effect/vitest';
import { ConfigProvider, Effect, Fiber, Layer, Option, Redacted } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { TestClock } from 'effect/testing';
import { httpClientLayer, refresh, revalidateWeb } from '../revalidate-web.ts';

interface Sent {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

/**
 * The script's own HTTP client over a stand-in for fetch that answers every
 * request with `respond`; `sent` records what reached fetch.
 */
function website(respond: () => Response) {
  const sent: Sent[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    sent.push({ url: new Request(input).url, init });
    return Promise.resolve(respond());
  };
  const layer = httpClientLayer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)));
  return { sent, layer };
}

const secret = (value: string) => Option.some(Redacted.make(value));
const headersOf = (sent: Sent | undefined) => Object.fromEntries(new Headers(sent?.init?.headers));

it.effect('publication only sends the invalidation POST without requesting public pages', () =>
  Effect.gen(function* () {
    const site = website(() => Response.json({ revalidated: true }));
    yield* revalidateWeb('https://wisp.test', secret('secret')).pipe(Effect.provide(site.layer));
    expect(site.sent).toHaveLength(1);
    const [call] = site.sent;
    expect(call?.url).toBe('https://wisp.test/api/revalidate');
    expect(call?.init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(headersOf(call)).toEqual({ authorization: 'Bearer secret' });
  }),
);

it.effect(
  'configured Vercel automation bypass is sent together with application authorization',
  () =>
    Effect.gen(function* () {
      const site = website(() => Response.json({ revalidated: true }));
      yield* revalidateWeb('https://wisp.test', secret('app-secret'), secret('vercel-secret')).pipe(
        Effect.provide(site.layer),
      );
      expect(site.sent).toHaveLength(1);
      expect(headersOf(site.sent[0])).toEqual({
        authorization: 'Bearer app-secret',
        'x-vercel-protection-bypass': 'vercel-secret',
      });
    }),
);

it.effect('missing application secret fails before any request', () =>
  Effect.gen(function* () {
    const site = website(() => Response.json({ revalidated: true }));
    const error = yield* Effect.flip(
      revalidateWeb('https://wisp.test', Option.none(), secret('vercel-secret')).pipe(
        Effect.provide(site.layer),
      ),
    );
    expect(error.message).toContain('Configure');
    expect(site.sent).toHaveLength(0);
  }),
);

it.effect.each([503, 429, 404])('HTTP %s fails the invalidation', (status) =>
  Effect.gen(function* () {
    const site = website(() => new Response(null, { status }));
    const error = yield* Effect.flip(
      revalidateWeb('https://wisp.test', secret('secret')).pipe(Effect.provide(site.layer)),
    );
    expect(error.message).toBe(`Web revalidation failed (${status}).`);
    expect(error).toMatchObject({ transient: status !== 404 });
    expect(site.sent).toHaveLength(1);
  }),
);

it.effect.each([401, 403])('HTTP %s says the secret was rejected', (status) =>
  Effect.gen(function* () {
    const site = website(() => new Response(null, { status }));
    const error = yield* Effect.flip(
      revalidateWeb('https://wisp.test', secret('secret')).pipe(Effect.provide(site.layer)),
    );
    expect(error.message).toBe(
      `Web revalidation was rejected (${status}); check WEB_REVALIDATION_SECRET and VERCEL_AUTOMATION_BYPASS_SECRET.`,
    );
    expect(error).toMatchObject({ transient: false });
  }),
);

it.effect('an unexpected success response does not report successful invalidation', () =>
  Effect.gen(function* () {
    const site = website(() => Response.json({ revalidated: false }));
    const error = yield* Effect.flip(
      revalidateWeb('https://wisp.test', secret('secret')).pipe(Effect.provide(site.layer)),
    );
    expect(error.message).toContain('Web revalidation failed');
    expect(error).toMatchObject({ transient: false });
  }),
);

it.effect(
  'a refresh tries five times, five seconds apart, and stops at once without a secret',
  () =>
    Effect.gen(function* () {
      const site = website(() => new Response(null, { status: 503 }));
      const configured = ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          WEB_URL: 'https://wisp.test',
          WEB_REVALIDATION_SECRET: 'secret',
        }),
      );
      const fiber = yield* refresh.pipe(
        Effect.provide([site.layer, configured]),
        Effect.flip,
        Effect.forkChild,
      );
      for (let attempt = 1; attempt < 5; attempt++) {
        yield* TestClock.adjust('5 seconds');
      }
      expect((yield* Fiber.join(fiber)).message).toBe('Web revalidation failed (503).');
      expect(site.sent).toHaveLength(5);

      const unconfigured = website(() => Response.json({ revalidated: true }));
      const missing = yield* Effect.flip(
        refresh.pipe(
          Effect.provide([
            unconfigured.layer,
            ConfigProvider.layer(ConfigProvider.fromUnknown({})),
          ]),
        ),
      );
      expect(missing.message).toContain('Configure');
      expect(unconfigured.sent).toHaveLength(0);
    }),
);

const configured = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    WEB_URL: 'https://wisp.test',
    WEB_REVALIDATION_SECRET: 'secret',
  }),
);

it.effect.each([
  {
    name: 'a rejected secret (401)',
    respond: () => new Response(null, { status: 401 }),
    message: 'was rejected (401)',
  },
  {
    name: 'a rejected secret (403)',
    respond: () => new Response(null, { status: 403 }),
    message: 'was rejected (403)',
  },
  {
    name: 'a missing route (404)',
    respond: () => new Response(null, { status: 404 }),
    message: 'failed (404)',
  },
  {
    name: 'revalidated: false',
    respond: () => Response.json({ revalidated: false }),
    message: 'did not answer `revalidated: true`',
  },
])('a refresh stops at the first attempt on $name', ({ respond, message }) =>
  Effect.gen(function* () {
    const site = website(respond);
    const error = yield* Effect.flip(refresh.pipe(Effect.provide([site.layer, configured])));
    expect(error.message).toContain(message);
    expect(site.sent).toHaveLength(1);
  }),
);

it.effect.each([
  { name: 'a network error', failure: () => Promise.reject(new TypeError('fetch failed')) },
  { name: 'a 429', failure: () => Promise.resolve(new Response(null, { status: 429 })) },
  { name: 'a 502', failure: () => Promise.resolve(new Response(null, { status: 502 })) },
])('a refresh retries $name five seconds later and then succeeds', ({ failure }) =>
  Effect.gen(function* () {
    const sent: string[] = [];
    const fetch: typeof globalThis.fetch = (input) => {
      sent.push(new Request(input).url);
      return sent.length < 3 ? failure() : Promise.resolve(Response.json({ revalidated: true }));
    };
    const layer = httpClientLayer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)));
    const fiber = yield* refresh.pipe(Effect.provide([layer, configured]), Effect.forkChild);
    yield* TestClock.adjust('5 seconds');
    yield* TestClock.adjust('5 seconds');
    yield* Fiber.join(fiber);
    expect(sent).toHaveLength(3);
  }),
);
