import { assert, describe, it } from '@effect/vitest';
import { Effect, Fiber, Layer } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { TestClock } from 'effect/testing';
import { HttpClientLive } from '../src/integrations/http-client.ts';
import { TheWoWDB } from '../src/integrations/thewowdb.ts';

const spell = {
  id: 122,
  kind: 'spell',
  version: 'forever',
  name: 'Frost Nova',
  build: 'beta-build',
  links: { html: 'https://thewowdb.com/wow-forever/spell/frost-nova-122/' },
  attribution: { required: true, text: 'Data from TheWoWDB' },
};

/** TheWoWDB on a fake fetch. */
function withFetch(fetcher: (url: URL, init?: RequestInit) => Promise<Response>) {
  return Effect.provide(
    TheWoWDB.layer.pipe(
      Layer.provide(HttpClientLive),
      Layer.provide(
        Layer.succeed(FetchHttpClient.Fetch, ((input: RequestInfo | URL, init?: RequestInit) =>
          fetcher(new URL(String(input)), init)) as typeof fetch),
      ),
    ),
  );
}

describe('TheWoWDB', () => {
  it.effect('fixes Forever in the URL and preserves build, credit and search pagination', () => {
    const urls: URL[] = [];
    return Effect.gen(function* () {
      const database = yield* TheWoWDB;
      const result = yield* database.query({ operation: 'get', kind: 'spell', id: 122 });
      assert.strictEqual(result.status, 'available');
      assert.deepStrictEqual('data' in result && result.data, spell);
      const search = yield* database.query({
        operation: 'search',
        kind: 'spell',
        query: 'Frost Nova & version=retail',
        page: 2,
        limit: 3,
      });
      assert.isTrue('data' in search && search.data.has_more === true);
      assert.isTrue(
        urls.every(
          (url) =>
            url.origin === 'https://thewowdb.com' && url.pathname.startsWith('/api/v1/forever/'),
        ),
      );
      assert.strictEqual(urls[1]!.searchParams.get('q'), 'Frost Nova & version=retail');
      assert.strictEqual(urls[1]!.searchParams.get('version'), null);
      assert.strictEqual(urls[1]!.searchParams.get('page'), '2');
      // Requests for another version or a path outside the catalog never reach the network.
      for (const input of [
        { operation: 'get', kind: 'spell', id: 122, version: 'retail' },
        { operation: 'get', kind: '../retail/item', id: 122 },
      ]) {
        const refused = yield* Effect.exit(database.query(input as never));
        assert.isTrue(refused._tag === 'Failure');
      }
      assert.strictEqual(urls.length, 2);
    }).pipe(
      withFetch(async (url) => {
        urls.push(url);
        return Response.json(
          url.pathname.endsWith('/122')
            ? spell
            : {
                version: 'forever',
                kind: 'spell',
                results: [spell],
                has_more: true,
                page: 2,
                build: 'beta-build',
                attribution: spell.attribution,
              },
        );
      }),
    );
  });

  it.effect.each([
    { ...spell, version: 'retail' },
    { ...spell, id: 133 },
    { version: 'forever', kind: 'spell', results: [{ ...spell, version: 'classic' }] },
    { kind: 'spell', results: [spell] },
  ])('withholds wrong versions, mixed search rows and wrong entities %#', (data) =>
    Effect.gen(function* () {
      const database = yield* TheWoWDB;
      const result = yield* database.query(
        'results' in data
          ? { operation: 'search', kind: 'spell', query: 'Nova' }
          : { operation: 'get', kind: 'spell', id: 122 },
      );
      assert.strictEqual(result.status, 'unavailable');
      assert.isFalse('data' in result);
    }).pipe(withFetch(async () => Response.json(data))),
  );

  it.effect('shares a time-bounded cache and revalidates with ETags', () => {
    let calls = 0;
    const headers: Headers[] = [];
    return Effect.gen(function* () {
      const database = yield* TheWoWDB;
      yield* database.query({ operation: 'get', kind: 'spell', id: 122 });
      const hit = yield* database.query({ operation: 'get', kind: 'spell', id: 122 });
      assert.isTrue('cacheHit' in hit && hit.cacheHit);
      assert.strictEqual(calls, 1);
      yield* TestClock.adjust('6 seconds');
      const validated = yield* database.query({ operation: 'get', kind: 'spell', id: 122 });
      assert.strictEqual(calls, 2);
      assert.strictEqual(headers[1]!.get('if-none-match'), '"one"');
      assert.deepStrictEqual('data' in validated && validated.data, spell);
    }).pipe(
      withFetch(async (_url, init) => {
        calls++;
        headers.push(new Headers(init?.headers));
        return calls === 1
          ? Response.json(spell, { headers: { etag: '"one"', 'cache-control': 'max-age=5' } })
          : new Response(null, { status: 304 });
      }),
    );
  });

  it.effect.each([404, 429, 503])('keeps HTTP %s distinct from an empty search', (status) =>
    Effect.gen(function* () {
      const database = yield* TheWoWDB;
      const result = yield* database.query({ operation: 'get', kind: 'spell', id: 122 });
      assert.strictEqual(result.status, status === 404 ? 'not_found' : 'unavailable');
      assert.isFalse('data' in result);
    }).pipe(
      withFetch(async () => new Response(null, { status, headers: { 'retry-after': '60' } })),
    ),
  );

  it.effect('reports an empty search as no matches', () =>
    Effect.gen(function* () {
      const database = yield* TheWoWDB;
      const result = yield* database.query({
        operation: 'search',
        kind: 'spell',
        query: 'Missing',
      });
      assert.strictEqual(result.status, 'no_matches');
    }).pipe(
      withFetch(async () =>
        Response.json({ version: 'forever', kind: 'spell', results: [], has_more: false }),
      ),
    ),
  );

  it.effect('retries a dropped connection but not an answered failure', () => {
    let calls = 0;
    let failures = 0;
    return Effect.gen(function* () {
      const database = yield* TheWoWDB;
      const lookup = yield* Effect.forkChild(
        database.query({ operation: 'get', kind: 'spell', id: 122 }),
      );
      // The retry waits on its backoff; move virtual time past it.
      yield* TestClock.adjust('1 second');
      const result = yield* Fiber.join(lookup);
      assert.strictEqual(result.status, 'available');
      assert.strictEqual(calls, 2);

      const unavailable = yield* database.query({ operation: 'get', kind: 'item', id: 1 });
      assert.strictEqual(unavailable.status, 'unavailable');
      assert.strictEqual(failures, 1);
    }).pipe(
      withFetch(async (url) => {
        if (url.pathname.includes('/item/')) {
          failures++;
          return new Response(null, { status: 503 });
        }
        calls++;
        if (calls === 1) {
          throw new TypeError('fetch failed');
        }
        return Response.json(spell);
      }),
    );
  });
});
