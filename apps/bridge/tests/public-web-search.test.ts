import { test, expect } from 'vitest';
import {
  isPublicSourceUrl,
  searchPublicWeb,
  verifiedWebResult,
} from '@wisp/bridge/public-web-search';
import type { ChatGPTAuth } from '@wisp/bridge/chatgpt-auth';
const url = 'https://github.com/fusionpit/WhatsTraining';
const response = {
  output: [
    { type: 'web_search_call', action: { sources: [{ url }] } },
    { content: [{ text: 'Catalog evidence', annotations: [{ type: 'url_citation', url }] }] },
  ],
};
test('ChatGPT searches globally with citations and explicit version instructions', async () => {
  let body: any;
  const auth = {
    authorized: async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(
        'data: ' + JSON.stringify({ type: 'response.completed', response }) + '\n\n',
      );
    },
  } as unknown as ChatGPTAuth;
  const result = await searchPublicWeb('Forever mage Invisibility training', auth, 'gpt-test');
  expect(body.tools).toEqual([{ type: 'web_search' }]);
  expect(body.input[0].content[0].text).toBe('Forever mage Invisibility training');
  expect(body.instructions).toContain('game version');
  expect(result).toMatchObject({ status: 'available', version: 'unspecified', sources: [{ url }] });
  expect(result.note).toContain('does not verify game version');
});
test('public source validation does not imply Forever and rejects local or credential URLs', () => {
  expect(isPublicSourceUrl(url)).toBe(true);
  expect(isPublicSourceUrl('https://www.wowhead.com/classic/spell=122')).toBe(true);
  for (const value of [
    'http://example.com',
    'https://localhost/a',
    'https://127.0.0.1/a',
    'https://[::1]/a',
    'https://user:secret@example.com/a',
  ]) {
    expect(isPublicSourceUrl(value)).toBe(false);
  }
  expect(
    verifiedWebResult({ output: [{ content: [{ text: 'Unsourced answer' }] }] }, 'query').status,
  ).toBe('unverified');
});

test('source dossiers retain negative evidence, scope and unresolved acquisition separately', () => {
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
test('a generated dossier cannot introduce an unconsulted source or turn unsupported prose into evidence', () => {
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

test('irrelevant unsafe search hits do not suppress attributed findings from public pages', () => {
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

test('ChatGPT receives the chosen research depth and bounds returned findings', async () => {
  let body: any;
  const findings = Array.from({ length: 6 }, (_, i) => ({
    claim: 'Claim ' + i,
    url,
    sourceType: 'guide',
    scope: 'Current community source',
  }));
  const auth = {
    authorized: async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(
        'data: ' +
          JSON.stringify({
            type: 'response.completed',
            response: {
              output: [
                { type: 'web_search_call', action: { sources: [{ url }] } },
                {
                  content: [
                    {
                      text: JSON.stringify({
                        findings,
                        unresolvedQuestions: [],
                        suggestedQueries: [],
                      }),
                    },
                  ],
                },
              ],
            },
          }) +
          '\n\n',
      );
    },
  } as unknown as ChatGPTAuth;
  const result = await searchPublicWeb(
    {
      query: 'Compare acquisition routes',
      depth: 'deep',
      maxResults: 2,
      maxQueries: 3,
      timeoutSeconds: 120,
      queries: ['Check availability'],
    },
    auth,
    'gpt-6.1-sol',
  );
  expect(body.reasoning.effort).toBe('medium');
  expect(body.instructions).toContain('at most 3 targeted search queries');
  expect(body.instructions).toContain('up to 2 useful findings within 120 seconds');
  expect(JSON.parse(body.input[0].content[0].text).queryVariants).toEqual(['Check availability']);
  expect('research' in result && result.research?.findings).toHaveLength(2);
  expect(result.budget).toMatchObject({
    depth: 'deep',
    maxResults: 2,
    maxQueries: 3,
    timeoutSeconds: 120,
  });
});
