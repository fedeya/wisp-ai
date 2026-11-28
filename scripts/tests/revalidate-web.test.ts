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

it.effect.each([401, 403, 503])('HTTP %s fails the invalidation', (status) =>
  Effect.gen(function* () {
    const site = website(() => new Response(null, { status }));
    const error = yield* Effect.flip(
      revalidateWeb('https://wisp.test', secret('secret')).pipe(Effect.provide(site.layer)),
    );
    expect(error.message).toBe(`Web revalidation failed (${status}).`);
    expect(site.sent).toHaveLength(1);
  }),
);

it.effect('an unexpected success response does not report successful invalidation', () =>
  Effect.gen(function* () {
    const site = website(() => Response.json({ revalidated: false }));
    const error = yield* Effect.flip(
      revalidateWeb('https://wisp.test', secret('secret')).pipe(Effect.provide(site.layer)),
    );
    expect(error.message).toContain('Web revalidation failed');
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
