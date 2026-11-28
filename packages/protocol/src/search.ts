// @effect-migrated
import { Effect, Schema, Struct } from 'effect';
import { rejectUnknownKeys, TrimmedString } from './checks.js';

const budget = (minimum: number, maximum: number, description: string) =>
  Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum, maximum })).annotate({ description }),
  );
const query = TrimmedString({ minLength: 1, maxLength: 1000 });
// A tool's input: defaults apply to a missing key only, so the model's JSON
// Schema shows no `null`. Strict: decode it with `rejectUnknownKeys`.
export const wowheadQuery = Schema.Struct({
  query,
  depth: Schema.Literals(['quick', 'standard', 'deep'])
    .annotate({
      description:
        'Choose quick for a simple fact, standard for normal research, deep for conflicting evidence, missing acquisition routes or broad comparisons.',
      default: 'standard',
    })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed('standard' as const))),
  maxResults: budget(1, 12, 'Maximum returned findings/sources. Overrides the depth default.'),
  maxQueries: budget(
    1,
    6,
    'Query budget including the primary query. Guidance for ChatGPT; bounds explicit query variants on Exa.',
  ),
  timeoutSeconds: budget(10, 180, 'Total time budget for this tool call, not per query.'),
  excerptCharacters: budget(1000, 12_000, 'Maximum Exa excerpt length per source.'),
  queries: Schema.Array(query)
    .check(Schema.isMaxLength(5))
    .annotate({
      description:
        'Optional additional focused query variants. Exa executes these within maxQueries; ChatGPT can use them as research directions.',
      default: [],
    })
    .pipe(Schema.withDecodingDefaultKey(Effect.sync(() => []))),
});
export type WebSearchQuery = typeof wowheadQuery.Type;
export type WebSearchInput = string | typeof wowheadQuery.Encoded;
const decodeQuery = Schema.decodeSync(wowheadQuery);
const searchProfiles = {
  quick: {
    maxResults: 3,
    maxQueries: 1,
    timeoutSeconds: 35,
    excerptCharacters: 2000,
    reasoning: 'low',
  },
  standard: {
    maxResults: 5,
    maxQueries: 2,
    timeoutSeconds: 85,
    excerptCharacters: 4000,
    reasoning: 'low',
  },
  deep: {
    maxResults: 12,
    maxQueries: 4,
    timeoutSeconds: 160,
    excerptCharacters: 8000,
    reasoning: 'medium',
  },
} as const;
/** The query with its depth's budget; throws when `raw` breaks the query's constraints. */
export function resolveWebSearch(raw: WebSearchInput) {
  const input = decodeQuery(typeof raw === 'string' ? { query: raw } : raw, rejectUnknownKeys);
  const profile = searchProfiles[input.depth];
  return {
    query: input.query,
    queries: input.queries,
    depth: input.depth,
    maxResults: input.maxResults ?? profile.maxResults,
    maxQueries: input.maxQueries ?? profile.maxQueries,
    timeoutSeconds: input.timeoutSeconds ?? profile.timeoutSeconds,
    excerptCharacters: input.excerptCharacters ?? profile.excerptCharacters,
    reasoning: profile.reasoning,
  };
}
export const searchConfig = Schema.Struct({
  provider: Schema.Literals(['auto', 'exa', 'chatgpt', 'disabled']).pipe(
    Schema.withDecodingDefault(Effect.succeed('auto' as const)),
  ),
});
export const searchSetup = searchConfig.mapFields(
  Struct.assign({ apiKey: Schema.optional(TrimmedString({ maxLength: 4096 })) }),
);
export const searchState = searchConfig.mapFields(Struct.assign({ hasExaKey: Schema.Boolean }));
