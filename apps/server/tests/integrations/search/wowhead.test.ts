import { assert, expect, it } from '@effect/vitest';
import { Effect, Fiber } from 'effect';
import { TestClock } from 'effect/testing';
import {
  isForeverWowheadUrl,
  searchWowhead,
  verifiedWowheadResult,
} from '../../../src/integrations/search/wowhead.ts';
import type { SearchResponse } from '../../../src/integrations/search/responses.ts';
import { bodyJson, chatgpt, completed } from './fixtures.ts';

const url = 'https://www.wowhead.com/forever/spell=122/frost-nova';
const message = (citation = url) => ({
  type: 'message',
  content: [
    {
      text: 'Forever summary',
      annotations: [{ type: 'url_citation', url: citation, title: 'Frost Nova' }],
    },
  ],
});
function response(citation = url, source = url): SearchResponse {
  return {
    output: [
      { type: 'web_search_call', action: { sources: [{ url: source }] } },
      message(citation),
    ],
  };
}

it('Wowhead sources must be HTTPS Forever pages, including localized pages', () => {
  assert.isTrue(isForeverWowheadUrl(url));
  assert.isTrue(isForeverWowheadUrl('https://www.wowhead.com/es/forever/guide/mage'));
  for (const value of [
    'https://www.wowhead.com/classic/spell=122',
    'https://www.wowhead.com/spell=122',
    'https://www.wowhead.com/forever-other/item=1',
    'https://wowhead.com.evil.test/forever/item=1',
    'https://user:secret@www.wowhead.com/forever/item=1',
    'http://www.wowhead.com/forever/item=1',
    'https://www.wowhead.com/forever/%2e%2e%2fclassic/spell=122',
    'https://www.wowhead.com/forever/%invalid',
    'not a url',
  ]) {
    assert.isFalse(isForeverWowheadUrl(value), value);
  }
});

it('mixed-version summaries, missing citations and non-search responses are not exposed', () => {
  const valid = verifiedWowheadResult(response(), 'Query');
  assert.strictEqual(valid.status, 'available');
  assert.strictEqual(valid.summary, 'Forever summary');
  assert.lengthOf(valid.sources, 1);
  for (const result of [
    response('https://www.wowhead.com/classic/spell=122'),
    response(url, 'https://www.wowhead.com/spell=122'),
    { output: [{ type: 'message', content: [{ text: 'Unsourced answer' }] }] },
  ]) {
    const rejected = verifiedWowheadResult(result, 'Query');
    assert.strictEqual(rejected.status, 'unverified');
    assert.notProperty(rejected, 'summary');
    assert.isTrue(rejected.sources.every((source) => isForeverWowheadUrl(source.url)));
  }
});

it.effect(
  'fallback search fixes the site scope and domain filter before invoking the provider',
  () => {
    const account = chatgpt(() => completed(response()));
    return Effect.gen(function* () {
      const result = yield* searchWowhead('Frost Nova', 'gpt-test');
      assert.strictEqual(result.status, 'available');
      const [request] = account.sent;
      assert.strictEqual(request?.url, 'https://api.openai.com/v1/responses');
      expect(request && bodyJson(request)).toMatchObject({
        store: false,
        stream: true,
        tool_choice: 'required',
        input: [
          { content: [{ text: expect.stringMatching(/^site:www\.wowhead\.com\/forever\//) }] },
        ],
        tools: [{ filters: { allowed_domains: ['www.wowhead.com'] } }],
      });
    }).pipe(Effect.provide(account.layer));
  },
);

it.effect('mixed search results are reread in isolation using only Forever URLs', () => {
  const account = chatgpt((_, count) =>
    completed(
      count === 1
        ? response(url, 'https://www.wowhead.com/guide/retail')
        : { output: [{ type: 'web_search_call', action: { type: 'open_page', url } }, message()] },
    ),
  );
  return Effect.gen(function* () {
    const result = yield* searchWowhead('Frost Nova', 'gpt-test');
    assert.strictEqual(result.status, 'available');
    assert.lengthOf(account.sent, 2);
    const reread = account.sent[1];
    const body = reread && bodyJson(reread);
    expect(body).toMatchObject({
      input: [{ content: [{ text: JSON.stringify({ question: 'Frost Nova', urls: [url] }) }] }],
      instructions: expect.stringMatching(/Do not run a new search/),
    });
    assert.notInclude(JSON.stringify(body), 'Forever summary');
  }).pipe(Effect.provide(account.layer));
});

it('opening another version invalidates a summary even when its citations claim Forever', () => {
  const data = response();
  assert.strictEqual(
    verifiedWowheadResult(
      {
        output: [
          ...(data.output ?? []),
          { type: 'web_search_call', action: { url: 'https://www.wowhead.com/guide/retail' } },
        ],
      },
      'Query',
    ).status,
    'unverified',
  );
});

it.effect('provider failure stays unavailable instead of falling back to another version', () => {
  const account = chatgpt(() => Response.json({ detail: 'Search unavailable' }, { status: 503 }));
  return Effect.gen(function* () {
    const result = yield* searchWowhead('Missing', 'gpt-test');
    assert.strictEqual(result.status, 'unavailable');
    assert.strictEqual(result.version, 'forever');
    assert.notProperty(result, 'summary');
    expect(result).toMatchObject({ error: 'Search unavailable' });
  }).pipe(Effect.provide(account.layer));
});

it.effect('the search and its reread share one 55 second deadline', () => {
  const account = chatgpt(() => Effect.never);
  return Effect.gen(function* () {
    const fiber = yield* searchWowhead('Frost Nova', 'gpt-test').pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    yield* TestClock.adjust('55 seconds');
    expect(yield* Fiber.join(fiber)).toMatchObject({
      status: 'unavailable',
      error: 'The operation was aborted due to timeout',
    });
  }).pipe(Effect.provide(account.layer));
});

it.effect('an empty query is rejected before anything is sent', () => {
  const account = chatgpt();
  return Effect.gen(function* () {
    const error = yield* Effect.flip(searchWowhead('   ', 'gpt-test'));
    assert.strictEqual(error._tag, 'InvalidWowheadQuery');
    assert.lengthOf(account.sent, 0);
  }).pipe(Effect.provide(account.layer));
});
