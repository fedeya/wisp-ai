// @effect-migrated
import { Effect, Option, Predicate, Schema, Stream } from 'effect';
import type { Duration } from 'effect';
import { HttpClientRequest } from 'effect/http';
import type { HttpClientError, HttpClientResponse } from 'effect/http';
import { safeErrorMessage } from '@wisp/agent/contract/model-errors';
import { ChatGPTAuth } from '#/auth';

const RESPONSES = 'https://api.openai.com/v1/responses';
/** The longest streamed answer read, in decoded characters. */
const MAX_RESPONSE_LENGTH = 32 * 1024 * 1024;
const FAILED_EVENTS = new Set(['response.failed', 'response.incomplete', 'error']);
/** The message `fetch` gives a request whose deadline passed. */
const TIMED_OUT = 'The operation was aborted due to timeout';

/**
 * A web search through ChatGPT returned no answer. `message` is the reason
 * the agent is shown, after `safeErrorMessage`.
 */
export class ResponsesSearchError extends Schema.TaggedError<ResponsesSearchError>()(
  'ResponsesSearchError',
  { message: Schema.String },
) {}

/**
 * An optional field that is dropped, rather than rejected, when it is not a
 * `schema`. ChatGPT's answers were read field by field before, ignoring a field
 * of an unexpected type.
 */
const lenient = <S extends Schema.Top>(schema: S) =>
  Schema.optional(schema.pipe(Schema.catchDecoding(() => Effect.succeedNone)));

const Source = Schema.Struct({ url: lenient(Schema.String), title: lenient(Schema.String) });
const Annotation = Schema.Struct({
  type: lenient(Schema.String),
  url: lenient(Schema.String),
  title: lenient(Schema.String),
});
const OutputItem = Schema.Struct({
  type: lenient(Schema.String),
  action: lenient(
    Schema.Struct({ url: lenient(Schema.String), sources: lenient(Schema.Array(Source)) }),
  ),
  content: lenient(
    Schema.Array(
      Schema.Struct({
        text: lenient(Schema.String),
        annotations: lenient(Schema.Array(Annotation)),
      }),
    ),
  ),
});
/** The parts of a completed Responses API answer that web search reads. */
export const SearchResponse = Schema.Struct({ output: lenient(Schema.Array(OutputItem)) });
export type SearchResponse = typeof SearchResponse.Type;
const decodeSearchResponse = Schema.decodeUnknownOption(SearchResponse);

const StreamEvent = Schema.Struct({
  type: lenient(Schema.String),
  response: Schema.optional(Schema.Unknown),
  output_index: lenient(Schema.Int),
  item: Schema.optional(Schema.Unknown),
});
const decodeEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const failed = (message: string) => new ResponsesSearchError({ message });
const errorText = (error: unknown) => (Predicate.isError(error) ? error.message : 'Search failed');
// Keeps what the transport failed with, as the agent saw before.
const readFailed = (error: HttpClientError.HttpClientError) =>
  failed(
    error.reason._tag === 'EmptyBodyError'
      ? 'ChatGPT returned no response.'
      : errorText(error.cause ?? error),
  );

/**
 * The completed answer of a streamed response. Partial output never counts:
 * a failed event or a stream that ends first is an error. Items finished in
 * separate events fill an empty `output`.
 */
const completedResponse = (response: HttpClientResponse.HttpClientResponse) =>
  Effect.gen(function* () {
    const items = new Map<number, unknown>();
    let pending = '';
    let length = 0;
    let completed: unknown;
    yield* response.stream.pipe(
      Stream.mapError(readFailed),
      Stream.decodeText(),
      Stream.runForEach((chunk) =>
        Effect.gen(function* () {
          length += chunk.length;
          if (length > MAX_RESPONSE_LENGTH) {
            return yield* failed('Model response is too large');
          }
          pending += chunk;
          for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
            const line = pending.slice(0, end).trim();
            pending = pending.slice(end + 1);
            if (!line.startsWith('data:')) {
              continue;
            }
            const data = line.slice(5).trim();
            if (data === '[DONE]') {
              continue;
            }
            const json = yield* decodeEvent(data).pipe(
              Effect.mapError((error) => failed(error.message)),
            );
            const event = Option.getOrElse(Schema.decodeUnknownOption(StreamEvent)(json), () => ({
              type: undefined,
              response: undefined,
              output_index: undefined,
              item: undefined,
            }));
            const index = event.output_index;
            if (
              event.type === 'response.output_item.done' &&
              index !== undefined &&
              index >= 0 &&
              index < 1000 &&
              Predicate.isTruthy(event.item)
            ) {
              items.set(index, event.item);
            }
            if (event.type !== undefined && FAILED_EVENTS.has(event.type)) {
              return yield* failed('ChatGPT did not complete this response.');
            }
            if (event.type === 'response.completed') {
              completed = event.response;
            }
          }
        }),
      ),
    );
    if (!Predicate.isTruthy(completed)) {
      return yield* failed('ChatGPT response was interrupted.');
    }
    if (Predicate.isObject(completed) && items.size > 0) {
      const { output } = completed;
      if (!Array.isArray(output) || output.length === 0) {
        return {
          ...completed,
          output: [...items].sort(([left], [right]) => left - right).map(([, item]) => item),
        };
      }
    }
    return completed;
  });

/**
 * The reason ChatGPT gave for refusing a request: its `{error: {message}}`
 * or a subscription's `{detail}`, sanitized, else `fallback`.
 */
const refusal = (response: HttpClientResponse.HttpClientResponse, fallback: string) =>
  response.text.pipe(
    Effect.map((text) => {
      const body = Option.getOrUndefined(decodeJson(text));
      const error = Predicate.hasProperty(body, 'error') ? body.error : undefined;
      const message = Predicate.hasProperty(error, 'message') ? error.message : undefined;
      const detail = Predicate.hasProperty(body, 'detail') ? body.detail : undefined;
      const reason = message ?? detail;
      return Predicate.isString(reason) ? safeErrorMessage(reason) : fallback;
    }),
    Effect.orElseSucceed(() => fallback),
  );

/**
 * Sends a streamed web search request to ChatGPT's Responses API with the
 * active account and returns its completed answer. Fails with `fallback`
 * when ChatGPT refuses without a reason.
 */
export const searchResponses = Effect.fnUntraced(function* (
  body: Readonly<Record<string, unknown>>,
  fallback: string,
) {
  const auth = yield* ChatGPTAuth;
  const request = HttpClientRequest.post(RESPONSES).pipe(
    HttpClientRequest.bodyText(JSON.stringify(body), 'application/json'),
  );
  const response = yield* auth.authorized(request).pipe(
    Effect.catchTags({
      ChatGPTRequestError: (error) => Effect.fail(failed(errorText(error.cause))),
      ChatGPTAuthError: (error) => Effect.fail(failed(error.message)),
      SecretVaultError: (error) => Effect.fail(failed(error.message)),
    }),
  );
  if (response.status < 200 || response.status >= 300) {
    return yield* failed(yield* refusal(response, fallback));
  }
  const completed = yield* completedResponse(response);
  return Option.getOrElse(decodeSearchResponse(completed), (): SearchResponse => ({}));
}, Effect.scoped);

/** Fails like a `fetch` whose deadline passed when `effect` takes longer than `duration`. */
export const withDeadline =
  (duration: Duration.Input) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.timeoutOrElse(effect, {
      duration,
      orElse: () => Effect.fail(failed(TIMED_OUT)),
    });
