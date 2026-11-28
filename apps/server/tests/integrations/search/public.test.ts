import { assert, expect, it } from '@effect/vitest';
import { Effect, Fiber } from 'effect';
import { TestClock } from 'effect/testing';
import { resolveWebSearch } from '@wisp/protocol/search';
import { ChatGPTAuthError, ChatGPTRequestError } from '#/auth';
import {
  isPublicSourceUrl,
  searchPublicWeb,
  verifiedWebResult,
} from '../../../src/integrations/search/public.ts';
import { bodyJson, chatgpt, completed } from './fixtures.ts';

const url = 'https://github.com/fusionpit/WhatsTraining';
const response = {
  output: [
    { type: 'web_search_call', action: { sources: [{ url }] } },
    { content: [{ text: 'Catalog evidence', annotations: [{ type: 'url_citation', url }] }] },
  ],
};

it.effect('ChatGPT searches globally with citations and explicit version instructions', () => {
  const account = chatgpt(() => completed(response));
  return Effect.gen(function* () {
    const result = yield* searchPublicWeb(
      resolveWebSearch('Forever mage Invisibility training'),
      'gpt-test',
    );
    const [request] = account.sent;
    assert.strictEqual(request?.url, 'https://api.openai.com/v1/responses');
    assert.strictEqual(request?.method, 'POST');
    const body = request && bodyJson(request);
    expect(body).toMatchObject({
      model: 'gpt-test',
      store: false,
      stream: true,
      tools: [{ type: 'web_search' }],
      tool_choice: 'required',
      include: ['web_search_call.action.sources'],
      input: [{ content: [{ text: 'Forever mage Invisibility training' }] }],
      instructions: expect.stringContaining('game version'),
    });
    expect(body).not.toHaveProperty('reasoning');
    expect(result).toMatchObject({
      status: 'available',
      version: 'unspecified',
      sources: [{ url }],
    });
    expect(result.note).toContain('does not verify game version');
  }).pipe(Effect.provide(account.layer));
});

it('public source validation does not imply Forever and rejects local or credential URLs', () => {
  expect(isPublicSourceUrl(url)).toBe(true);
  expect(isPublicSourceUrl('https://www.wowhead.com/classic/spell=122')).toBe(true);
  for (const value of [
    'http://example.com',
    'https://localhost/a',
    'https://127.0.0.1/a',
    'https://[::1]/a',
    'https://user:secret@example.com/a',
    'not a url',
  ]) {
    expect(isPublicSourceUrl(value)).toBe(false);
  }
  expect(
    verifiedWebResult({ output: [{ content: [{ text: 'Unsourced answer' }] }] }, 'query').status,
  ).toBe('unverified');
});

it('source dossiers retain negative evidence, scope and unresolved acquisition separately', () => {
  const dossier = {
    findings: [
      {
        claim: 'A current class guide explicitly states that the ability is unavailable.',
        url,
        sourceType: 'guide',
        scope: 'Community guide for the current game version, not a publisher statement.',
      },
    ],
    unresolvedQuestions: ['Does the old teaching item have an obtainable source?'],
    suggestedQueries: ['Forever teaching item obtainable source'],
  };
  const result = verifiedWebResult(
    {
      output: [
        { type: 'web_search_call', action: { sources: [{ url }] } },
        { content: [{ text: JSON.stringify(dossier) }] },
      ],
    },
    'Ability acquisition',
  );
  expect(result.status).toBe('available');
  expect(result.summaryKind).toBe('model_generated');
  expect(result.research).toEqual(dossier);
});

it('dossier URLs are trimmed like before and must parse', () => {
  const finding = { claim: 'Claim', sourceType: 'guide', scope: 'Scope' };
  const dossier = (findingUrl: string) =>
    verifiedWebResult(
      {
        output: [
          { type: 'web_search_call', action: { sources: [{ url }] } },
          {
            content: [
              {
                text: JSON.stringify({
                  findings: [{ ...finding, url: findingUrl }],
                  unresolvedQuestions: [],
                  suggestedQueries: [],
                }),
              },
            ],
          },
        ],
      },
      'Question',
    );
  expect(dossier(`  ${url}\n`).research?.findings[0]?.url).toBe(url);
  expect(dossier('not a url')).not.toHaveProperty('research');
});

it('a generated dossier cannot introduce an unconsulted source or turn unsupported prose into evidence', () => {
  const dossier = {
    findings: [
      {
        claim: 'Learn at level 38',
        url: 'https://unconsulted.example/ability',
        sourceType: 'catalog',
        scope: 'Unknown availability',
      },
    ],
    unresolvedQuestions: [],
    suggestedQueries: [],
  };
  const result = verifiedWebResult(
    {
      output: [
        { type: 'web_search_call', action: { sources: [{ url }] } },
        { content: [{ text: JSON.stringify(dossier) }] },
      ],
    },
    'Question',
  );
  expect(result.status).toBe('unverified');
  expect(result).not.toHaveProperty('research');
  expect(result).not.toHaveProperty('summary');
});

it('irrelevant unsafe search hits do not suppress attributed findings from public pages', () => {
  const source = 'https://www.wowhead.com/forever/spell%3D885/invisibility?utm_source=search';
  const dossier = {
    findings: [
      {
        claim: 'This is an item effect record.',
        url: 'https://www.wowhead.com/forever/spell=885/invisibility',
        sourceType: 'catalog',
        scope: 'Not an obtainable trainer unlock.',
      },
    ],
    unresolvedQuestions: ['Is the teaching item obtainable?'],
    suggestedQueries: [],
  };
  const result = verifiedWebResult(
    {
      output: [
        {
          type: 'web_search_call',
          action: {
            sources: [
              { url: source },
              { url: 'http://unrelated.example/search-hit' },
              { url: 'https://localhost/private' },
            ],
          },
        },
        { content: [{ text: '```json\n' + JSON.stringify(dossier) + '\n```' }] },
      ],
    },
    'Question',
  );
  expect(result.status).toBe('available');
  expect(result.research).toEqual(dossier);
  expect(result.sources).toEqual([{ url: source, title: undefined }]);
});

it.effect('ChatGPT receives the chosen research depth and bounds returned findings', () => {
  const findings = Array.from({ length: 6 }, (_, i) => ({
    claim: 'Claim ' + i,
    url,
    sourceType: 'guide',
    scope: 'Current community source',
  }));
  const account = chatgpt(() =>
    completed({
      output: [
        { type: 'web_search_call', action: { sources: [{ url }] } },
        {
          content: [
            { text: JSON.stringify({ findings, unresolvedQuestions: [], suggestedQueries: [] }) },
          ],
        },
      ],
    }),
  );
  return Effect.gen(function* () {
    const result = yield* searchPublicWeb(
      resolveWebSearch({
        query: 'Compare acquisition routes',
        depth: 'deep',
        maxResults: 2,
        maxQueries: 3,
        timeoutSeconds: 120,
        queries: ['Check availability'],
      }),
      'gpt-6.1-sol',
    );
    const [request] = account.sent;
    const body = request && bodyJson(request);
    expect(body).toMatchObject({ model: 'gpt-6.1-sol', reasoning: { effort: 'medium' } });
    expect(body).toMatchObject({
      instructions: expect.stringContaining('at most 3 targeted search queries'),
    });
    expect(body).toMatchObject({
      instructions: expect.stringContaining('up to 2 useful findings within 120 seconds'),
    });
    expect(body).toMatchObject({
      input: [
        {
          content: [
            {
              text: JSON.stringify({
                question: 'Compare acquisition routes',
                queryVariants: ['Check availability'],
              }),
            },
          ],
        },
      ],
    });
    expect('research' in result && result.research?.findings).toHaveLength(2);
    expect(result.budget).toMatchObject({
      depth: 'deep',
      maxResults: 2,
      maxQueries: 3,
      timeoutSeconds: 120,
    });
  }).pipe(Effect.provide(account.layer));
});

it.effect('a refusal, an interrupted stream and a missed deadline are unavailable', () =>
  Effect.gen(function* () {
    const refused = chatgpt(() =>
      Response.json({ detail: 'Bearer secret-token is over quota' }, { status: 429 }),
    );
    const quota = yield* searchPublicWeb(resolveWebSearch('Frost Nova'), 'gpt-test').pipe(
      Effect.provide(refused.layer),
    );
    expect(quota).toMatchObject({
      status: 'unavailable',
      error: 'Bearer [redacted] is over quota',
    });

    const silent = chatgpt(() => new Response('{}', { status: 503 }));
    const unavailable = yield* searchPublicWeb(resolveWebSearch('Frost Nova'), 'gpt-test').pipe(
      Effect.provide(silent.layer),
    );
    expect(unavailable).toMatchObject({ error: 'Web search provider unavailable' });

    const partial = chatgpt(
      () =>
        new Response(
          'data: ' + JSON.stringify({ type: 'response.output_text.delta', delta: 'x' }) + '\n\n',
        ),
    );
    const interrupted = yield* searchPublicWeb(resolveWebSearch('Frost Nova'), 'gpt-test').pipe(
      Effect.provide(partial.layer),
    );
    expect(interrupted).toMatchObject({ error: 'ChatGPT response was interrupted.' });

    // The agent sees what the request failed with, as before.
    const offline = chatgpt(() =>
      Effect.fail(new ChatGPTRequestError({ cause: new TypeError('fetch failed') })),
    );
    expect(
      yield* searchPublicWeb(resolveWebSearch('Frost Nova'), 'gpt-test').pipe(
        Effect.provide(offline.layer),
      ),
    ).toMatchObject({ error: 'fetch failed' });
    const signedOut = chatgpt(() =>
      Effect.fail(new ChatGPTAuthError({ message: 'Sign in to ChatGPT first.' })),
    );
    expect(
      yield* searchPublicWeb(resolveWebSearch('Frost Nova'), 'gpt-test').pipe(
        Effect.provide(signedOut.layer),
      ),
    ).toMatchObject({ error: 'Sign in to ChatGPT first.' });

    const stalled = chatgpt(() => Effect.never);
    const fiber = yield* searchPublicWeb(
      resolveWebSearch({ query: 'Frost Nova', depth: 'quick' }),
      'gpt-test',
    ).pipe(Effect.provide(stalled.layer), Effect.forkChild({ startImmediately: true }));
    yield* TestClock.adjust('35 seconds');
    expect(yield* Fiber.join(fiber)).toMatchObject({
      status: 'unavailable',
      error: 'The operation was aborted due to timeout',
    });
  }),
);
