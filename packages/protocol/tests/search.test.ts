import { expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { resolveWebSearch, searchBudget } from '../src/search.ts';

it.effect('a query resolves to its depth budget, with explicit limits overriding it', () =>
  Effect.gen(function* () {
    expect(yield* resolveWebSearch('Frost Nova')).toMatchObject({
      query: 'Frost Nova',
      depth: 'standard',
      maxResults: 5,
      timeoutSeconds: 85,
    });
    expect(yield* resolveWebSearch({ query: 'Frost Nova', depth: 'quick', maxResults: 2 })).toEqual(
      searchBudget({ query: 'Frost Nova', depth: 'quick', maxResults: 2, queries: [] }),
    );
  }),
);

it.effect.each([
  { name: 'an empty query', input: '   ' },
  { name: 'an unknown key', input: { query: 'Frost Nova', extra: true } },
  { name: 'a budget out of range', input: { query: 'Frost Nova', maxResults: 99 } },
])('$name fails with a typed InvalidWebSearchQuery', ({ input }) =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(resolveWebSearch(input));
    expect(error._tag).toBe('InvalidWebSearchQuery');
    expect(error.message).not.toBe('');
  }),
);
