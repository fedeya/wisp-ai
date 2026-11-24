import { Context, Duration, Effect, Layer, Schema, Stream } from 'effect';
import { HttpBody, HttpClient } from 'effect/http';
import type { resolveWebSearch } from '@wisp/protocol/search';

const exaEndpoint = 'https://api.exa.ai/search';
const exaPublicEndpoint = 'https://mcp.exa.ai/mcp?tools=web_search_advanced_exa';
const RESPONSE_LIMIT = 1024 * 1024;
const PUBLIC_UNAVAILABLE =
  'Exa public search is unavailable or rate limited. Try again later or configure an optional API key in Connections.';

type Budget = ReturnType<typeof resolveWebSearch>;
/** One search result as Exa returns it; the caller validates each field. */
export type SearchHit = Record<string, any>;

/** Exa answered with a failure; the message is safe to show and says what to do. */
export class ExaSearchError extends Schema.TaggedError<ExaSearchError>()('ExaSearchError', {
  message: Schema.String,
}) {}

/** Exa could not be reached or sent something Wisp cannot read. */
export class ExaUnavailable extends Schema.TaggedError<ExaUnavailable>()('ExaUnavailable', {
  cause: Schema.Defect(),
}) {}

// Do not propagate upstream bodies, which might echo credentials or queries.
function statusMessage(status: number, keyed: boolean) {
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

/** The search results inside a REST or public MCP response. */
function searchResults(body: string, contentType: string | undefined, keyed: boolean) {
  let data: unknown;
  if (keyed) {
    data = JSON.parse(body);
  } else {
    const messages: unknown[] = contentType?.includes('text/event-stream')
      ? body
          .replace(/\r\n/g, '\n')
          .split('\n\n')
          .flatMap((event) => {
            const text = event
              .split('\n')
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trimStart())
              .join('\n');
            return text ? [JSON.parse(text)] : [];
          })
      : [JSON.parse(body)];
    for (const message of messages) {
      if (!message || typeof message !== 'object' || !('id' in message) || message.id !== 1) {
        continue;
      }
      if ('error' in message) {
        throw new ExaSearchError({ message: PUBLIC_UNAVAILABLE });
      }
      if (!('result' in message) || !message.result || typeof message.result !== 'object') {
        continue;
      }
      const result = message.result;
      if ('isError' in result && result.isError) {
        throw new ExaSearchError({ message: PUBLIC_UNAVAILABLE });
      }
      if ('structuredContent' in result) {
        data = result.structuredContent;
      }
      if (!data && 'content' in result && Array.isArray(result.content)) {
        for (const part of result.content) {
          if (part?.type !== 'text' || typeof part.text !== 'string') {
            continue;
          }
          try {
            const parsed: unknown = JSON.parse(part.text);
            if (parsed && typeof parsed === 'object' && 'results' in parsed) {
              data = parsed;
              break;
            }
          } catch {
            /* Ignore non-JSON text; never use unattributed prose. */
          }
        }
      }
    }
  }
  if (!data || typeof data !== 'object' || !('results' in data) || !Array.isArray(data.results)) {
    throw new Error('Exa returned an invalid search response.');
  }
  return data.results as SearchHit[];
}

/**
 * Exa web search. A saved key uses the account's REST quota; without one, Exa's
 * hosted MCP offers limited public search.
 */
export class Exa extends Context.Service<
  Exa,
  {
    search(
      query: string,
      key: string,
      budget: Budget,
    ): Effect.Effect<SearchHit[], ExaSearchError | ExaUnavailable>;
  }
>()('wisp/bridge/integrations/search/Exa') {
  static readonly layer = Layer.effect(
    Exa,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;

      const search = Effect.fn('Exa.search')(
        function* (query: string, key: string, budget: Budget) {
          // A dropped connection is retried once; an answer (even a failure) is final.
          const client = http.pipe(
            HttpClient.retryTransient({ retryOn: 'errors-only', times: 1 }),
            HttpClient.timeout(Duration.seconds(budget.timeoutSeconds)),
          );
          const request = { query, type: 'auto', numResults: budget.maxResults };
          const response = yield* client.post(key ? exaEndpoint : exaPublicEndpoint, {
            headers: key
              ? { 'content-type': 'application/json', 'x-api-key': key }
              : {
                  'content-type': 'application/json',
                  accept: 'application/json, text/event-stream',
                },
            body: HttpBody.text(
              JSON.stringify(
                key
                  ? { ...request, contents: { text: { maxCharacters: budget.excerptCharacters } } }
                  : {
                      jsonrpc: '2.0',
                      id: 1,
                      method: 'tools/call',
                      params: {
                        name: 'web_search_advanced_exa',
                        arguments: { ...request, textMaxCharacters: budget.excerptCharacters },
                      },
                    },
              ),
              'application/json',
            ),
          });
          if (response.status < 200 || response.status >= 300) {
            return yield* new ExaSearchError({ message: statusMessage(response.status, !!key) });
          }
          // Bound the complete response, including metadata, before JSON parsing.
          const read = yield* response.stream.pipe(
            Stream.runFold(
              () => ({ size: 0, chunks: [] as Uint8Array[] }),
              (state, chunk) => {
                state.size += chunk.byteLength;
                if (state.size > RESPONSE_LIMIT) {
                  throw new Error('Exa search response was too large.');
                }
                state.chunks.push(chunk);
                return state;
              },
            ),
          );
          return yield* Effect.try({
            try: () =>
              searchResults(
                Buffer.concat(read.chunks).toString('utf8'),
                response.headers['content-type'],
                !!key,
              ),
            catch: (error) =>
              error instanceof ExaSearchError ? error : new ExaUnavailable({ cause: error }),
          });
        },
        Effect.catchTags({
          HttpClientError: (cause) => Effect.fail(new ExaUnavailable({ cause })),
        }),
        Effect.catchDefect((cause) => Effect.fail(new ExaUnavailable({ cause }))),
      );

      return Exa.of({ search });
    }),
  );
}
