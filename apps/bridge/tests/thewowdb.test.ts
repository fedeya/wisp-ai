import { test } from 'vitest';
import assert from 'node:assert/strict';
import { TheWoWDB } from '../src/thewowdb.ts';

const spell = {
  id: 122,
  kind: 'spell',
  version: 'forever',
  name: 'Frost Nova',
  build: 'beta-build',
  links: { html: 'https://thewowdb.com/wow-forever/spell/frost-nova-122/' },
  attribution: { required: true, text: 'Data from TheWoWDB' },
};

test('catalog requests fix Forever in the URL and preserve build, credit and search pagination', async () => {
  const urls: URL[] = [];
  const database = new TheWoWDB({
    fetch: (async (input) => {
      const url = new URL(String(input));
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
    }) as typeof fetch,
  });
  const result = await database.query({ operation: 'get', kind: 'spell', id: 122 });
  assert.equal(result.status, 'available');
  assert.ok('data' in result);
  assert.deepEqual(result.data, spell);
  const search = await database.query({
    operation: 'search',
    kind: 'spell',
    query: 'Frost Nova & version=retail',
    page: 2,
    limit: 3,
  });
  assert.ok('data' in search);
  assert.equal(search.data.has_more, true);
  assert.ok(
    urls.every(
      (url) => url.origin === 'https://thewowdb.com' && url.pathname.startsWith('/api/v1/forever/'),
    ),
  );
  assert.equal(urls[1].searchParams.get('q'), 'Frost Nova & version=retail');
  assert.equal(urls[1].searchParams.get('version'), null);
  assert.equal(urls[1].searchParams.get('page'), '2');
  await assert.rejects(() =>
    database.query({ operation: 'get', kind: 'spell', id: 122, version: 'retail' } as never),
  );
  await assert.rejects(() =>
    database.query({ operation: 'get', kind: '../retail/item', id: 122 } as never),
  );
  assert.equal(urls.length, 2);
});

test('wrong versions, mixed-version search rows and wrong entity IDs are withheld', async () => {
  for (const data of [
    { ...spell, version: 'retail' },
    { ...spell, id: 133 },
    { version: 'forever', kind: 'spell', results: [{ ...spell, version: 'classic' }] },
    { kind: 'spell', results: [spell] },
  ]) {
    const database = new TheWoWDB({ fetch: (async () => Response.json(data)) as typeof fetch });
    const result = await database.query(
      'results' in data
        ? { operation: 'search', kind: 'spell', query: 'Nova' }
        : { operation: 'get', kind: 'spell', id: 122 },
    );
    assert.equal(result.status, 'unavailable');
    assert.ok(!('data' in result));
  }
});

test('catalog cache is shared, bounded in time and revalidates with ETags', async () => {
  let now = 1000,
    calls = 0;
  const headers: Headers[] = [];
  const database = new TheWoWDB({
    now: () => now,
    fetch: (async (_url, init) => {
      calls++;
      headers.push(new Headers(init?.headers));
      return calls === 1
        ? Response.json(spell, { headers: { etag: '"one"', 'cache-control': 'max-age=5' } })
        : new Response(null, { status: 304 });
    }) as typeof fetch,
  });
  await database.query({ operation: 'get', kind: 'spell', id: 122 });
  const hit = await database.query({ operation: 'get', kind: 'spell', id: 122 });
  assert.ok('cacheHit' in hit && hit.cacheHit);
  assert.equal(calls, 1);
  now += 6000;
  const validated = await database.query({ operation: 'get', kind: 'spell', id: 122 });
  assert.equal(calls, 2);
  assert.equal(headers[1].get('if-none-match'), '"one"');
  assert.ok('data' in validated);
  assert.deepEqual(validated.data, spell);
});

test('source errors and rate limits stay distinct from empty searches', async () => {
  for (const status of [404, 429, 503]) {
    const database = new TheWoWDB({
      fetch: (async () =>
        new Response(null, { status, headers: { 'retry-after': '60' } })) as typeof fetch,
    });
    const result = await database.query({ operation: 'get', kind: 'spell', id: 122 });
    assert.equal(result.status, status === 404 ? 'not_found' : 'unavailable');
    assert.ok(!('data' in result));
  }
  const database = new TheWoWDB({
    fetch: (async () =>
      Response.json({
        version: 'forever',
        kind: 'spell',
        results: [],
        has_more: false,
      })) as typeof fetch,
  });
  assert.equal(
    (await database.query({ operation: 'search', kind: 'spell', query: 'Missing' })).status,
    'no_matches',
  );
});
