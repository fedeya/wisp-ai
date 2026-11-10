import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  isForeverWowheadUrl,
  verifiedWowheadResult,
  searchWowhead,
} from '../src/wowhead-search.ts';
import type { ChatGPTAuth } from '../src/chatgpt-auth.ts';

const url = 'https://www.wowhead.com/forever/spell=122/frost-nova';
function response(citation = url, source = url) {
  return {
    output: [
      { type: 'web_search_call', action: { sources: [{ url: source }] } },
      {
        type: 'message',
        content: [
          {
            text: 'Forever summary',
            annotations: [{ type: 'url_citation', url: citation, title: 'Frost Nova' }],
          },
        ],
      },
    ],
  };
}

test('Wowhead sources must be HTTPS Forever pages, including localized pages', () => {
  assert.ok(isForeverWowheadUrl(url));
  assert.ok(isForeverWowheadUrl('https://www.wowhead.com/es/forever/guide/mage'));
  for (const value of [
    'https://www.wowhead.com/classic/spell=122',
    'https://www.wowhead.com/spell=122',
    'https://www.wowhead.com/forever-other/item=1',
    'https://wowhead.com.evil.test/forever/item=1',
    'https://user:secret@www.wowhead.com/forever/item=1',
    'http://www.wowhead.com/forever/item=1',
    'https://www.wowhead.com/forever/%2e%2e%2fclassic/spell=122',
    'https://www.wowhead.com/forever/%invalid',
  ]) {
    assert.equal(isForeverWowheadUrl(value), false, value);
  }
});

test('mixed-version summaries, missing citations and non-search responses are not exposed', () => {
  const valid = verifiedWowheadResult(response(), 'Query');
  assert.equal(valid.status, 'available');
  assert.equal(valid.summary, 'Forever summary');
  assert.equal(valid.sources.length, 1);
  for (const result of [
    response('https://www.wowhead.com/classic/spell=122'),
    response(url, 'https://www.wowhead.com/spell=122'),
    { output: [{ type: 'message', content: [{ text: 'Unsourced answer' }] }] },
  ]) {
    const rejected = verifiedWowheadResult(result, 'Query');
    assert.equal(rejected.status, 'unverified');
    assert.ok(!('summary' in rejected));
    assert.ok(rejected.sources.every((source) => isForeverWowheadUrl(source.url)));
  }
});

test('fallback search fixes the site scope and domain filter before invoking the provider', async () => {
  let body: Record<string, any> = {};
  const auth = {
    authorized: async (endpoint: string, init: RequestInit) => {
      assert.equal(endpoint, 'https://api.openai.com/v1/responses');
      body = JSON.parse(String(init.body));
      return new Response(
        'data: ' + JSON.stringify({ type: 'response.completed', response: response() }) + '\n\n',
      );
    },
  } as unknown as ChatGPTAuth;
  const result = await searchWowhead('Frost Nova', auth, 'gpt-test');
  assert.equal(result.status, 'available');
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.equal(body.tool_choice, 'required');
  assert.ok(Array.isArray(body.input));
  assert.match(body.input[0].content[0].text, /^site:www\.wowhead\.com\/forever\//);
  assert.deepEqual(body.tools[0].filters.allowed_domains, ['www.wowhead.com']);
});

test('mixed search results are reread in isolation using only Forever URLs', async () => {
  const bodies: any[] = [];
  const auth = {
    authorized: async (_endpoint: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      const data =
        bodies.length === 1
          ? response(url, 'https://www.wowhead.com/guide/retail')
          : {
              output: [
                { type: 'web_search_call', action: { type: 'open_page', url } },
                response().output[1],
              ],
            };
      return new Response(
        'data: ' + JSON.stringify({ type: 'response.completed', response: data }) + '\n\n',
      );
    },
  } as unknown as ChatGPTAuth;
  const result = await searchWowhead('Frost Nova', auth, 'gpt-test');
  assert.equal(result.status, 'available');
  assert.equal(bodies.length, 2);
  const reading = JSON.parse(bodies[1].input[0].content[0].text);
  assert.deepEqual(reading.urls, [url]);
  assert.equal(reading.question, 'Frost Nova');
  assert.ok(!JSON.stringify(bodies[1]).includes('Forever summary'));
  assert.match(bodies[1].instructions, /Do not run a new search/);
});

test('opening another version invalidates a summary even when its citations claim Forever', () => {
  const data = response();
  data.output.push({
    type: 'web_search_call',
    action: { url: 'https://www.wowhead.com/guide/retail' },
  } as any);
  assert.equal(verifiedWowheadResult(data, 'Query').status, 'unverified');
});

test('provider failure stays unavailable instead of falling back to another version', async () => {
  const auth = {
    authorized: async () => Response.json({ detail: 'Search unavailable' }, { status: 503 }),
  } as unknown as ChatGPTAuth;
  const result = await searchWowhead('Missing', auth, 'gpt-test');
  assert.equal(result.status, 'unavailable');
  assert.equal(result.version, 'forever');
  assert.ok(!('summary' in result));
});
