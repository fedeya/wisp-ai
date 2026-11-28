import { assert, it } from '@effect/vitest';
import { Effect, Fiber, Layer } from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/http';
import type { HttpClientRequest } from 'effect/http';
import { TestClock } from 'effect/testing';
import * as TheWoWDB from '../../src/integrations/thewowdb/index.ts';

const spell = {
  id: 122,
  kind: 'spell',
  version: 'forever',
  name: 'Frost Nova',
  build: 'beta-build',
  links: { html: 'https://thewowdb.com/wow-forever/spell/frost-nova-122/' },
  attribution: { required: true, text: 'Data from TheWoWDB' },
} as const;
const get = { operation: 'get', kind: 'spell', id: 122 } as const;

interface Sent {
  readonly url: URL;
  readonly request: HttpClientRequest.HttpClientRequest;
}

/** TheWoWDB on an HttpClient that answers each request with `respond`; `sent` records them. */
function database(respond: (sent: Sent, count: number) => Response | Effect.Effect<Response>) {
  const sent: Sent[] = [];
  const client = HttpClient.make((request, url) =>
    Effect.suspend(() => {
      sent.push({ url, request });
      const response = respond({ url, request }, sent.length);
      return Effect.isEffect(response) ? response : Effect.succeed(response);
    }).pipe(Effect.map((response) => HttpClientResponse.fromWeb(request, response))),
  );
  const layer = TheWoWDB.layer.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client)));
  return { sent, layer };
}

const query = (input: Parameters<TheWoWDB.TheWoWDB['Service']['query']>[0]) =>
  TheWoWDB.TheWoWDB.use((db) => db.query(input));

it.effect(
  'catalog requests fix Forever in the URL and preserve build, credit and search pagination',
  () => {
    const { sent, layer } = database(({ url }) =>
      Response.json(
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
      ),
    );
    return Effect.gen(function* () {
      const result = yield* query(get);
      assert.strictEqual(result.status, 'available');
      assert.deepStrictEqual('data' in result && result.data, spell);
      const search = yield* query({
        operation: 'search',
        kind: 'spell',
        query: 'Frost Nova & version=retail',
        page: 2,
        limit: 3,
      });
      assert.isTrue('data' in search && search.data.has_more);
      assert.isTrue(
        sent.every(
          ({ url }) =>
            url.origin === 'https://thewowdb.com' && url.pathname.startsWith('/api/v1/forever/'),
        ),
      );
      const searchUrl = sent[1].url;
      assert.strictEqual(searchUrl.searchParams.get('q'), 'Frost Nova & version=retail');
      assert.isNull(searchUrl.searchParams.get('version'));
      assert.strictEqual(searchUrl.searchParams.get('page'), '2');
      for (const invalid of [
        { ...get, version: 'retail' },
        { ...get, kind: '../retail/item' },
      ]) {
        const error = yield* Effect.flip(query(invalid as never));
        assert.strictEqual(error._tag, 'InvalidDatabaseRequest');
      }
      assert.lengthOf(sent, 2);
    }).pipe(Effect.provide(layer));
  },
);

it.effect('wrong versions, mixed-version search rows and wrong entity IDs are withheld', () =>
  Effect.forEach(
    [
      [{ ...spell, version: 'retail' }, 'did not confirm the requested Forever version and kind'],
      [{ ...spell, id: 133 }, 'Database returned a different entity'],
      [
        { version: 'forever', kind: 'spell', results: [{ ...spell, version: 'classic' }] },
        'Database search contained unverified or other-version records',
      ],
      [{ kind: 'spell', results: [spell] }, 'did not confirm'],
    ] as const,
    ([data, error]) =>
      Effect.gen(function* () {
        const result = yield* query(
          'results' in data ? { operation: 'search', kind: 'spell', query: 'Nova' } : get,
        );
        assert.strictEqual(result.status, 'unavailable');
        assert.notProperty(result, 'data');
        assert.include('error' in result ? result.error : '', error);
      }).pipe(Effect.provide(database(() => Response.json(data)).layer)),
    { discard: true },
  ),
);

it.effect('catalog cache is shared, bounded in time and revalidates with ETags', () => {
  const { sent, layer } = database((_, count) =>
    count === 1
      ? Response.json(spell, { headers: { etag: '"one"', 'cache-control': 'max-age=5' } })
      : new Response(null, { status: 304 }),
  );
  return Effect.gen(function* () {
    yield* query(get);
    const hit = yield* query(get);
    assert.isTrue('cacheHit' in hit && hit.cacheHit);
    assert.lengthOf(sent, 1);
    assert.isUndefined(sent[0].request.headers['if-none-match']);
    yield* TestClock.adjust('6 seconds');
    const validated = yield* query(get);
    assert.lengthOf(sent, 2);
    assert.strictEqual(sent[1].request.headers['if-none-match'], '"one"');
    assert.deepStrictEqual('data' in validated && validated.data, spell);
    assert.isTrue('cacheHit' in validated && validated.cacheHit);
  }).pipe(Effect.provide(layer));
});

it.effect('source errors and rate limits stay distinct from empty searches', () =>
  Effect.gen(function* () {
    for (const status of [404, 429, 503]) {
      const result = yield* query(get).pipe(
        Effect.provide(
          database(() => new Response(null, { status, headers: { 'retry-after': '60' } })).layer,
        ),
      );
      assert.strictEqual(result.status, status === 404 ? 'not_found' : 'unavailable');
      assert.notProperty(result, 'data');
      if (status !== 404) assert.deepInclude(result, { httpStatus: status, retryAfter: '60' });
    }
    const empty = yield* query({ operation: 'search', kind: 'spell', query: 'Missing' }).pipe(
      Effect.provide(
        database(() =>
          Response.json({ version: 'forever', kind: 'spell', results: [], has_more: false }),
        ).layer,
      ),
    );
    assert.strictEqual(empty.status, 'no_matches');
  }),
);

it.effect('records list the checked fields first, then the rest in the order TheWoWDB sent', () => {
  // TheWoWDB sorts its keys, as in these shortened real answers.
  const entity = {
    attribution: spell.attribution,
    build: 'beta-build',
    id: 122,
    kind: 'spell',
    name: 'Frost Nova',
    version: 'forever',
  };
  const page = {
    attribution: spell.attribution,
    has_more: false,
    kind: 'spell',
    page: 1,
    results: [
      { id: 122, kind: 'spell', links: spell.links, name: 'Frost Nova', version: 'forever' },
    ],
    version: 'forever',
  };
  const { layer } = database(({ url }) => Response.json(url.search ? page : entity));
  return Effect.gen(function* () {
    const got = yield* query(get);
    assert.deepStrictEqual(Object.keys('data' in got ? got.data : {}), [
      'id',
      'kind',
      'version',
      'attribution',
      'build',
      'name',
    ]);
    const search = yield* query({ operation: 'search', kind: 'spell', query: 'Nova' });
    const data = 'data' in search ? search.data : {};
    assert.deepStrictEqual(Object.keys(data), [
      'kind',
      'version',
      'results',
      'attribution',
      'has_more',
      'page',
    ]);
    assert.deepStrictEqual(
      Object.keys('results' in data && Array.isArray(data.results) ? data.results[0] : {}),
      ['kind', 'version', 'id', 'links', 'name'],
    );
  }).pipe(Effect.provide(layer));
});

it.effect(
  'a search without a list of rows is withheld, and an entity is never an empty search',
  () =>
    Effect.gen(function* () {
      const search = yield* query({ operation: 'search', kind: 'spell', query: 'Nova' }).pipe(
        Effect.provide(
          database(() => Response.json({ version: 'forever', kind: 'spell', results: 'none' }))
            .layer,
        ),
      );
      assert.deepInclude(search, {
        status: 'unavailable',
        error: 'Database search contained unverified or other-version records',
      });
      const entity = yield* query(get).pipe(
        Effect.provide(database(() => Response.json({ ...spell, results: [] })).layer),
      );
      assert.strictEqual(entity.status, 'available');
    }),
);

it.effect('a source that does not answer within 20 seconds is reported unavailable', () =>
  Effect.gen(function* () {
    const pending = yield* Effect.forkChild(query(get));
    yield* TestClock.adjust('20 seconds');
    assert.deepInclude(yield* Fiber.join(pending), {
      status: 'unavailable',
      error: 'The operation was aborted due to timeout',
    });
  }).pipe(Effect.provide(database(() => Effect.never).layer)),
);
