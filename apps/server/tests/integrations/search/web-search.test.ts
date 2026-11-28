import { assert, expect, layer } from '@effect/vitest';
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { Context, Effect, Fiber, FileSystem, Layer, Path, Redacted } from 'effect';
import { TestClock } from 'effect/testing';
import * as WebSearch from '#/integrations/search';
import { SecretVault } from '#/platform/secret-vault';
import { bodyJson, bodyText, chatgpt, completed, httpClient, unreachable } from './fixtures.ts';

const apiModel = 'connection:35302f8c-128a-48fb-98a1-9eb03bb71f72:claude-test';
const url = 'https://www.wowhead.com/forever/spell=122/frost-nova';

type Respond = Parameters<typeof httpClient>[0];

/** Web search in a temporary folder, on a vault backed by `secrets` and fake Exa and ChatGPT. */
const fixture = (respond: Respond = () => new Response(null, { status: 503 })) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'wisp-search-' });
    const secrets = new Map<string, string>();
    const vault = Layer.succeed(
      SecretVault,
      SecretVault.of({
        read: (key) => Effect.sync(() => Redacted.make(secrets.get(key) ?? '')),
        write: (key, value) =>
          Effect.sync(() => {
            secrets.set(key, Redacted.value(value));
          }),
      }),
    );
    const account = chatgpt(() =>
      completed({
        output: [
          { type: 'web_search_call', action: { sources: [{ url }] } },
          {
            type: 'message',
            content: [{ text: 'ChatGPT summary', annotations: [{ type: 'url_citation', url }] }],
          },
        ],
      }),
    );
    const exa = httpClient(respond);
    // Each call loads the saved settings again, as a restart would.
    const open = Layer.build(
      WebSearch.layerAt(directory).pipe(
        Layer.provide([vault, account.layer, exa.layer, NodeCrypto.layerSecureRandom]),
      ),
    ).pipe(Effect.map(Context.get(WebSearch.WebSearch)));
    const search = yield* open;
    return { search, open, file: path.join(directory, 'search.json'), secrets, account, exa };
  });

const exaResults = (results: unknown[]) => () => Response.json({ results });

layer(NodeServices.layer)('WebSearch', (it) => {
  it.effect(
    'Exa credentials are separate from language models, protected, persistent, and removable',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const fs = yield* FileSystem.FileSystem;
        assert.strictEqual(yield* f.search.provider(apiModel), 'Exa');
        yield* f.search.save({ provider: 'auto', apiKey: 'exa-secret' });
        assert.strictEqual(
          yield* fs.readFileString(f.file),
          JSON.stringify({ provider: 'auto' }, null, 2),
        );
        assert.notInclude(JSON.stringify(yield* f.search.state), 'exa-secret');
        const restored = yield* f.open;
        assert.deepStrictEqual(yield* restored.state, { provider: 'auto', hasExaKey: true });
        yield* restored.save({ provider: 'exa' });
        assert.strictEqual(f.secrets.get('search:exa'), 'exa-secret');
        assert.deepStrictEqual(yield* restored.removeExa, { provider: 'exa', hasExaKey: false });
        assert.strictEqual(yield* restored.provider(apiModel), 'Exa');
        assert.strictEqual(f.secrets.get('search:exa'), '');
      }),
  );

  it.effect('failed settings writes roll back a replacement credential', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const fs = yield* FileSystem.FileSystem;
      f.secrets.set('search:exa', 'old-key');
      yield* fs.makeDirectory(f.file);
      // In real time: the rename is retried briefly before the save gives up.
      const error = yield* Effect.flip(
        f.search.save({ provider: 'exa', apiKey: 'replacement' }),
      ).pipe(TestClock.withLive);
      assert.strictEqual(error._tag, 'SearchSettingsError');
      assert.strictEqual(f.secrets.get('search:exa'), 'old-key');
      assert.deepStrictEqual(yield* f.search.state, { provider: 'auto', hasExaKey: false });
    }),
  );

  it.effect('a failed settings write reports what Node reported', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(f.file);
      const error = yield* Effect.flip(f.search.save({ provider: 'exa' })).pipe(TestClock.withLive);
      assert.strictEqual(error._tag, 'SearchSettingsError');
      // Node's own text, such as "EPERM: operation not permitted, rename '…' -> '…'".
      assert.match(error.message, /^E[A-Z]+: .*rename '/);
      assert.notMatch(error.message, /FileSystem\.rename/);
    }),
  );

  it.effect('a search.json that starts with a byte order mark fails to load, as before', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(f.file, '﻿{"provider":"exa"}');
      const error = yield* Effect.flip(f.open);
      assert.strictEqual(error._tag, 'SearchSettingsError');
      assert.strictEqual(
        error.message,
        'Cannot load search.json; the original file was preserved.',
      );
    }),
  );

  it.effect('damaged settings stop the service from loading, and the file is kept', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(f.file, '{"provider":"unknown"}');
      const error = yield* Effect.flip(f.open);
      assert.strictEqual(error._tag, 'SearchSettingsError');
      assert.strictEqual(
        error.message,
        'Cannot load search.json; the original file was preserved.',
      );
      assert.strictEqual(yield* fs.readFileString(f.file), '{"provider":"unknown"}');
    }),
  );

  for (const format of ['json', 'sse'] as const) {
    it.effect(
      `public Exa works without a key with ${format} responses and the same source restrictions`,
      () =>
        Effect.gen(function* () {
          const envelope = {
            jsonrpc: '2.0',
            id: 1,
            result: {
              content: [
                { type: 'text', text: 'Not JSON' },
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
          const f = yield* fixture(() =>
            format === 'sse'
              ? new Response(
                  ': keepalive\r\n\r\nevent: message\r\ndata: ' +
                    JSON.stringify(envelope) +
                    '\r\n\r\n',
                  { headers: { 'content-type': 'text/event-stream' } },
                )
              : Response.json(envelope),
          );
          expect(yield* f.search.search('Frost Nova', apiModel)).toMatchObject({
            status: 'available',
            provider: 'Exa',
            sources: [
              { url, excerpt: 'Public Forever excerpt' },
              { url: 'https://www.wowhead.com/classic/spell=122', excerpt: 'Wrong version' },
            ],
          });
          const [sent] = f.exa.sent;
          assert.strictEqual(
            sent?.url.href,
            'https://mcp.exa.ai/mcp?tools=web_search_advanced_exa',
          );
          assert.strictEqual(sent?.request.method, 'POST');
          assert.isUndefined(sent?.request.headers['x-api-key']);
          assert.strictEqual(sent?.request.headers.accept, 'application/json, text/event-stream');
          assert.strictEqual(sent?.init?.redirect, 'error');
          expect(sent && bodyJson(sent.request)).toEqual({
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
          assert.lengthOf(f.account.sent, 0);
          yield* f.search.save({ provider: 'exa' });
          assert.deepStrictEqual(yield* f.search.test({ provider: 'exa' }), { ok: true });
          assert.strictEqual(f.secrets.size, 0);
        }),
    );
  }

  for (const envelope of [
    { jsonrpc: '2.0', id: 1, error: { code: -32_603, message: 'secret upstream detail' } },
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
  ]) {
    it.effect(
      `public MCP errors and mismatched responses never become facts: ${JSON.stringify(envelope)}`,
      () =>
        Effect.gen(function* () {
          const f = yield* fixture(() => Response.json(envelope));
          const result = yield* f.search.search('Frost Nova', apiModel);
          assert.strictEqual(result.status, 'unavailable');
          assert.deepStrictEqual(result.sources, []);
          assert.notMatch(JSON.stringify(result), /secret upstream|Wrong response/);
        }),
    );
  }

  it.effect('structured MCP content is read as the results', () =>
    Effect.gen(function* () {
      const f = yield* fixture(() =>
        Response.json({
          jsonrpc: '2.0',
          id: 1,
          result: { structuredContent: { results: [{ url, text: 'Structured excerpt' }] } },
        }),
      );
      expect(yield* f.search.search('Frost Nova', apiModel)).toMatchObject({
        status: 'available',
        sources: [{ url, excerpt: 'Structured excerpt' }],
      });
    }),
  );

  it.effect(
    'Exa searches globally, retains version comparisons and bounds attributable excerpts',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(
          exaResults([
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
          ]),
        );
        yield* f.search.save({ provider: 'auto', apiKey: 'exa-secret' });
        const result = yield* f.search.search('Frost Nova', apiModel);
        const [sent] = f.exa.sent;
        assert.strictEqual(sent?.url.href, 'https://api.exa.ai/search');
        assert.strictEqual(sent?.request.headers['x-api-key'], 'exa-secret');
        assert.strictEqual(sent?.request.headers['content-type'], 'application/json');
        assert.strictEqual(sent?.init?.redirect, 'error');
        const request = sent && bodyJson(sent.request);
        expect(request).toEqual({
          query: 'Frost Nova',
          type: 'auto',
          numResults: 5,
          contents: { text: { maxCharacters: 4000 } },
        });
        expect(result).toMatchObject({
          status: 'available',
          provider: 'Exa',
          version: 'unspecified',
        });
        assert.lengthOf(result.sources, 4);
        expect(result.sources[1]).toMatchObject({ url, title: 'Frost Nova' });
        expect(result.sources[1]).toHaveProperty('excerpt.length', 4000);
        expect(result.sources[2]).toMatchObject({ excerpt: 'Verified page excerpt' });
        assert.notMatch(JSON.stringify(result), /Generated summary|Mixed unverified|exa-secret/);
        assert.lengthOf(f.account.sent, 0);
      }),
  );

  it.effect('a result with a field of the wrong type is left out and the others are kept', () =>
    Effect.gen(function* () {
      const f = yield* fixture(
        exaResults([
          { url: 'https://www.wowhead.com/forever/guide/a', title: 7, text: 'Wrong title type' },
          { url: 'https://www.wowhead.com/forever/guide/b', highlights: ['ok', 7] },
          { url: 'https://www.wowhead.com/forever/guide/c', text: ['not', 'a', 'string'] },
          { url: 42, text: 'No URL' },
          { url: 'https://www.wowhead.com/forever/guide/d', title: null, text: 'Kept text' },
        ]),
      );
      yield* f.search.save({ provider: 'auto', apiKey: 'exa-secret' });
      const result = yield* f.search.search('Frost Nova', apiModel);
      expect(result).toMatchObject({
        status: 'available',
        sources: [
          {
            url: 'https://www.wowhead.com/forever/guide/d',
            title: 'https://www.wowhead.com/forever/guide/d',
            excerpt: 'Kept text',
          },
        ],
      });
      assert.lengthOf(result.sources, 1);
    }),
  );

  it.effect(
    'Auto preserves ChatGPT search, explicit Exa works for ChatGPT, and disabled mode makes no requests',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(exaResults([{ url, text: 'Exa reference text' }]));
        f.account.connect();
        yield* f.search.save({ provider: 'auto', apiKey: 'key' });
        assert.strictEqual(yield* f.search.provider('gpt-test'), 'ChatGPT');
        expect(yield* f.search.search('Frost Nova', 'gpt-test')).toMatchObject({
          status: 'available',
          provider: 'ChatGPT',
          summary: 'ChatGPT summary',
        });
        assert.lengthOf(f.account.sent, 1);
        assert.lengthOf(f.exa.sent, 0);
        yield* f.search.save({ provider: 'exa' });
        assert.strictEqual((yield* f.search.search('Frost Nova', 'gpt-test')).provider, 'Exa');
        yield* f.search.save({ provider: 'disabled' });
        assert.isUndefined(yield* f.search.provider('gpt-test'));
        expect(yield* f.search.search('Frost Nova', apiModel)).toMatchObject({
          status: 'unavailable',
          note: 'Web search is disabled in Connections.',
        });
        assert.lengthOf(f.exa.sent, 1);
        yield* f.search.save({ provider: 'chatgpt' });
        assert.isUndefined(yield* f.search.provider(apiModel));
        expect(yield* f.search.search('Frost Nova', apiModel)).toMatchObject({
          status: 'unavailable',
          note: 'Select Auto or Exa in Connections to use web search with this model.',
        });
      }),
  );

  for (const results of [
    [],
    [{ url: 'http://localhost/private', text: 'Private source' }],
    [{ url, text: '' }],
  ]) {
    it.effect(
      `empty, out-of-scope or unreadable results never become a factual answer: ${JSON.stringify(results)}`,
      () =>
        Effect.gen(function* () {
          const f = yield* fixture(exaResults(results));
          yield* f.search.save({ provider: 'exa', apiKey: 'key' });
          expect(yield* f.search.search('Frost Nova', apiModel)).toMatchObject({
            status: 'unavailable',
            provider: 'Exa',
            sources: [],
          });
        }),
    );
  }

  for (const status of [401, 402, 429, 503]) {
    it.effect(
      `Exa HTTP ${status} is actionable without exposing the key or silently falling back`,
      () =>
        Effect.gen(function* () {
          const f = yield* fixture(() =>
            Response.json({ error: 'exa-secret must never be exposed' }, { status }),
          );
          f.account.connect();
          yield* f.search.save({ provider: 'exa', apiKey: 'exa-secret' });
          const result = yield* f.search.search('Query', 'gpt-test');
          assert.strictEqual(result.status, 'unavailable');
          assert.match(
            result.note,
            status === 402
              ? /credits/
              : status === 429
                ? /rate limit/
                : status === 401
                  ? /API key/
                  : /HTTP 503/,
          );
          assert.notInclude(JSON.stringify(result), 'exa-secret');
          assert.lengthOf(f.account.sent, 0);
          const error = yield* Effect.flip(f.search.test({ provider: 'exa' }));
          assert.strictEqual(error.message, result.note);
        }),
    );
  }

  it.effect(
    'test search does not save credentials, interruption cancels the request, and arbitrary errors are hidden',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(({ request }) =>
          unreachable(request, Error('exa-secret network detail')),
        );
        const error = yield* Effect.flip(f.search.test({ provider: 'auto', apiKey: 'exa-secret' }));
        assert.strictEqual(
          error.message,
          'Could not reach Exa. Check your connection and try again.',
        );
        assert.strictEqual(f.secrets.size, 0);
        yield* f.search.save({ provider: 'exa', apiKey: 'exa-secret' });
        const hidden = yield* f.search.search('Query', apiModel);
        assert.match(hidden.note, /^Exa search is unavailable/);
        assert.notInclude(JSON.stringify(hidden), 'exa-secret');
      }),
  );

  it.effect('interrupting a search aborts its request', () =>
    Effect.gen(function* () {
      const f = yield* fixture(() => Effect.never);
      yield* f.search.save({ provider: 'exa', apiKey: 'key' });
      const fiber = yield* f.search
        .search('Query', apiModel)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.yieldNow;
      const [sent] = f.exa.sent;
      assert.isFalse(sent?.signal.aborted);
      yield* Fiber.interrupt(fiber);
      assert.isTrue(sent?.signal.aborted);
    }),
  );

  it.effect('a search that outlasts its budget is unavailable', () =>
    Effect.gen(function* () {
      const f = yield* fixture(() => Effect.never);
      yield* f.search.save({ provider: 'exa', apiKey: 'key' });
      const fiber = yield* f.search
        .search({ query: 'Query', depth: 'quick' }, apiModel)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust('35 seconds');
      const result = yield* Fiber.join(fiber);
      assert.strictEqual(result.status, 'unavailable');
      assert.match(result.note, /^Exa search is unavailable/);
    }),
  );

  for (const response of [
    () => new Response('x'.repeat(1024 * 1024 + 1)),
    () => Response.json({ results: 'unexpected' }),
    () => new Response('﻿' + JSON.stringify({ results: [{ url, text: 'BOM' }] })),
  ]) {
    it.effect('oversized and malformed responses are not exposed to the model', () =>
      Effect.gen(function* () {
        const f = yield* fixture(response);
        yield* f.search.save({ provider: 'exa', apiKey: 'key' });
        assert.strictEqual((yield* f.search.search('Query', apiModel)).status, 'unavailable');
      }),
    );
  }

  for (const { depth, count, characters, seconds } of [
    { depth: 'quick' as const, count: 3, characters: 2000, seconds: 35 },
    { depth: 'standard' as const, count: 5, characters: 4000, seconds: 85 },
    { depth: 'deep' as const, count: 12, characters: 8000, seconds: 160 },
  ]) {
    it.effect(`Exa honors the ${depth} result, excerpt and deadline budget`, () =>
      Effect.gen(function* () {
        const f = yield* fixture(
          exaResults(
            Array.from({ length: 15 }, (_, i) => ({
              url: `https://example.com/source-${i}`,
              text: 'x'.repeat(13_000),
            })),
          ),
        );
        yield* f.search.save({ provider: 'exa', apiKey: 'key' });
        const result = yield* f.search.search({ query: 'Ability acquisition', depth }, apiModel);
        const [sent] = f.exa.sent;
        expect(sent && bodyJson(sent.request)).toMatchObject({
          numResults: count,
          contents: { text: { maxCharacters: characters } },
        });
        expect(result).toHaveProperty('budget.timeoutSeconds', seconds);
        expect(result.sources).toEqual(
          Array.from({ length: count }, () =>
            expect.objectContaining({ excerpt: 'x'.repeat(characters) }),
          ),
        );
      }),
    );
  }

  it.effect(
    'Exa executes explicit query variants concurrently and retains successful results',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(({ request }) =>
          bodyText(request).includes('"Unavailable variant"')
            ? new Response('', { status: 503 })
            : Response.json({
                results: [{ url: 'https://example.com/fact', text: 'Supported evidence' }],
              }),
        );
        yield* f.search.save({ provider: 'exa', apiKey: 'key' });
        const result = yield* f.search.search(
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
        expect(f.exa.sent.map(({ request }) => bodyJson(request))).toMatchObject([
          { query: 'First query', numResults: 2 },
          { query: 'Unavailable variant', numResults: 2 },
        ]);
        assert.strictEqual(result.status, 'available');
        assert.lengthOf(result.sources, 1);
        expect(result).toMatchObject({
          budget: { maxQueries: 2, maxResults: 4, timeoutSeconds: 20, excerptCharacters: 1500 },
        });
      }),
  );

  it.effect('when every variant fails, the first failure is reported', () =>
    Effect.gen(function* () {
      const f = yield* fixture(({ request }) =>
        bodyText(request).includes('"First query"')
          ? new Response('', { status: 402 })
          : new Response('', { status: 429 }),
      );
      yield* f.search.save({ provider: 'exa', apiKey: 'key' });
      const result = yield* f.search.search(
        { query: 'First query', queries: ['Second query'], depth: 'deep' },
        apiModel,
      );
      assert.match(result.note, /credits/);
    }),
  );
});
