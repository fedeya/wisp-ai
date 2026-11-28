// @effect-migrated
import { Effect, Option, Predicate, Redacted, Schema, Stream } from 'effect';
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/http';
import type { resolveWebSearch } from '@wisp/protocol/search';
import { publicSourceUrl } from './public.ts';

type Budget = ReturnType<typeof resolveWebSearch>;

const ENDPOINT = 'https://api.exa.ai/search';
const PUBLIC_ENDPOINT = 'https://mcp.exa.ai/mcp?tools=web_search_advanced_exa';
/** The largest response read, in bytes, metadata included. */
const MAX_RESPONSE_BYTES = 1024 * 1024;
const PUBLIC_UNAVAILABLE =
  'Exa public search is unavailable or rate limited. Try again later or configure an optional API key in Connections.';

/** Exa refused the search; `message` says why, without upstream text, and is shown as is. */
export class ExaSearchError extends Schema.TaggedError<ExaSearchError>()('ExaSearchError', {
  message: Schema.String,
}) {}

/**
 * Exa could not be reached or answered with something Wisp cannot read.
 * The model only sees a generic message for it: network, credential and page
 * text stay out of what it is told.
 */
export class ExaUnavailable extends Schema.TaggedError<ExaUnavailable>()('ExaUnavailable', {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

const ExaResults = Schema.Struct({ results: Schema.Array(Schema.Unknown) });
const decodeResults = Schema.decodeUnknownEffect(ExaResults);
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const isJsonText = Schema.is(Schema.Struct({ type: Schema.Literal('text'), text: Schema.String }));
const isList = Schema.is(Schema.Array(Schema.Unknown));
/** A JSON-RPC reply to the request Wisp sent, which always has id 1. */
const McpReply = Schema.Struct({
  id: Schema.Literal(1),
  error: Schema.optionalKey(Schema.Unknown),
  result: Schema.optional(Schema.Unknown),
});
const McpResult = Schema.Struct({
  isError: Schema.optional(Schema.Unknown),
  structuredContent: Schema.optionalKey(Schema.Unknown),
  content: Schema.optional(Schema.Unknown),
});

const unreadable = (message: string) => (cause: unknown) => new ExaUnavailable({ message, cause });

function rejection(status: number, keyed: boolean) {
  if (status === 401 || status === 403) {
    return keyed
      ? 'Exa rejected the API key. Check it in Connections.'
      : 'Exa public access was rejected. Try a direct IPv4 connection or configure an optional API key in Connections.';
  }
  if (status === 402) {
    return 'Exa credits are exhausted. Check your Exa account.';
  }
  if (status === 429) {
    return 'Exa rate limit reached. Try again later or configure an optional API key in Connections.';
  }
  return `Exa search failed (HTTP ${status}). Try again later.`;
}

/** The JSON messages of a server-sent event stream, one per event with data. */
const eventMessages = (body: string) =>
  Effect.forEach(
    body
      .replaceAll('\r\n', '\n')
      .split('\n\n')
      .map((event) =>
        event
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n'),
      )
      .filter((text) => text !== ''),
    (text) => decodeJson(text),
  );

/** The search results in the hosted MCP's replies; errors there are Exa's refusals. */
const mcpResults = Effect.fnUntraced(function* (messages: readonly unknown[]) {
  let data: unknown;
  for (const message of messages) {
    const reply = Option.getOrUndefined(Schema.decodeUnknownOption(McpReply)(message));
    if (reply === undefined) {
      continue;
    }
    if ('error' in reply) {
      return yield* new ExaSearchError({ message: PUBLIC_UNAVAILABLE });
    }
    const result = Option.getOrUndefined(Schema.decodeUnknownOption(McpResult)(reply.result));
    if (result === undefined) {
      continue;
    }
    if (Predicate.isTruthy(result.isError)) {
      return yield* new ExaSearchError({ message: PUBLIC_UNAVAILABLE });
    }
    if ('structuredContent' in result) {
      data = result.structuredContent;
    }
    if (!Predicate.isTruthy(data) && isList(result.content)) {
      // Non-JSON text is ignored; unattributed prose is never used.
      data = result.content
        .filter(isJsonText)
        .map((part) => Option.getOrUndefined(parseJson(part.text)))
        .find((parsed) => Predicate.hasProperty(parsed, 'results'));
    }
  }
  return data;
});

/**
 * Searches Exa once. A saved key uses the account's REST API, its quota and
 * billing; without one, Exa's hosted MCP offers limited public search.
 */
export const searchExa = Effect.fn('WebSearch.exa')(function* (
  query: string,
  key: Redacted.Redacted<string>,
  budget: Budget,
) {
  // A redirect could leave Exa, so it fails like a network error.
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.transformResponse(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: 'error' }),
    ),
    HttpClient.withScope,
  );
  const keyed = Redacted.value(key) !== '';
  const search = { query, type: 'auto', numResults: budget.maxResults };
  const request = keyed
    ? HttpClientRequest.post(ENDPOINT).pipe(
        HttpClientRequest.setHeader('x-api-key', Redacted.value(key)),
        HttpClientRequest.bodyText(
          JSON.stringify({
            ...search,
            contents: { text: { maxCharacters: budget.excerptCharacters } },
          }),
          'application/json',
        ),
      )
    : HttpClientRequest.post(PUBLIC_ENDPOINT).pipe(
        HttpClientRequest.setHeader('accept', 'application/json, text/event-stream'),
        HttpClientRequest.bodyText(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              name: 'web_search_advanced_exa',
              arguments: { ...search, textMaxCharacters: budget.excerptCharacters },
            },
          }),
          'application/json',
        ),
      );
  return yield* Effect.gen(function* () {
    const response = yield* client
      .execute(request)
      .pipe(Effect.mapError(unreadable('Exa could not be reached.')));
    if (response.status < 200 || response.status >= 300) {
      // Upstream bodies are never read: they might echo credentials or queries.
      return yield* new ExaSearchError({ message: rejection(response.status, keyed) });
    }
    // Bound the complete response, including metadata, before parsing it.
    const chunks: Uint8Array[] = [];
    let size = 0;
    yield* response.stream.pipe(
      Stream.mapError(unreadable('Exa returned no search response.')),
      Stream.runForEach((chunk) => {
        size += chunk.byteLength;
        chunks.push(chunk);
        return size > MAX_RESPONSE_BYTES
          ? Effect.fail(new ExaUnavailable({ message: 'Exa search response was too large.' }))
          : Effect.void;
      }),
    );
    // Like Buffer#toString before, a byte order mark is kept, so JSON parsing rejects it.
    const body = new TextDecoder('utf-8', { ignoreBOM: true }).decode(Buffer.concat(chunks));
    const data = keyed
      ? yield* decodeJson(body)
      : yield* mcpResults(
          response.headers['content-type']?.includes('text/event-stream')
            ? yield* eventMessages(body)
            : [yield* decodeJson(body)],
        );
    const { results } = yield* decodeResults(data).pipe(
      Effect.mapError(unreadable('Exa returned an invalid search response.')),
    );
    return results;
  }).pipe(
    Effect.catchTag('SchemaError', (error) =>
      Effect.fail(
        new ExaUnavailable({ message: 'Exa returned an invalid search response.', cause: error }),
      ),
    ),
    Effect.scoped,
    Effect.timeoutOrElse({
      duration: `${budget.timeoutSeconds} seconds`,
      orElse: () => Effect.fail(new ExaUnavailable({ message: 'Exa search timed out.' })),
    }),
  );
});

interface ExaSource {
  readonly url: string;
  readonly title: string;
  readonly excerpt: string;
}

/**
 * The fields of a result Wisp reads. Exa sends `null` for a page without a
 * title or text, which reads as absent; a field of any other type makes the
 * whole result unreadable, and `exaSources` leaves that result out.
 */
const ExaItem = Schema.Struct({
  url: Schema.String,
  title: Schema.optional(Schema.NullOr(Schema.String)),
  text: Schema.optional(Schema.NullOr(Schema.String)),
  highlights: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
});
const decodeItem = Schema.decodeUnknownOption(ExaItem);

/**
 * Exa's results as attributable excerpts: public URLs only, without fragments
 * or tracking parameters, each URL once, cut to the budget's excerpt length,
 * and at most `maxResults` of them.
 */
export function exaSources(results: readonly unknown[], budget: Budget): ExaSource[] {
  const sources = new Map<string, ExaSource>();
  for (const result of results) {
    const item = Option.getOrUndefined(decodeItem(result));
    const url = item && publicSourceUrl(item.url);
    if (!item || !url) {
      continue;
    }
    url.hash = '';
    for (const name of Array.from(url.searchParams.keys())) {
      if (name.startsWith('utm_')) {
        url.searchParams.delete(name);
      }
    }
    const text = item.text ?? item.highlights?.join('\n') ?? '';
    const excerpt = text.trim().slice(0, budget.excerptCharacters);
    if (!excerpt) {
      continue;
    }
    const normalized = url.href;
    if (!sources.has(normalized)) {
      sources.set(normalized, {
        url: normalized,
        title: item.title?.slice(0, 200) ?? normalized,
        excerpt,
      });
    }
    if (sources.size === budget.maxResults) {
      break;
    }
  }
  return [...sources.values()];
}
