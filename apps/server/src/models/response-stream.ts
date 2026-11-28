// @effect-migrated allow=effectRuns: readCompletedResponse runs completedResponse for the model proxy and web search, which are not migrated and take a Promise
import { Effect, Option, Predicate, Schema, Stream } from 'effect';

/** The longest streamed answer read, in decoded characters. */
const MAX_RESPONSE_LENGTH = 32 * 1024 * 1024;
const FAILED_EVENTS = new Set(['response.failed', 'response.incomplete', 'error']);

/** A streamed Responses answer did not complete; `message` says how. */
export class ResponseStreamError extends Schema.TaggedError<ResponseStreamError>()(
  'ResponseStreamError',
  { message: Schema.String },
) {}

const failed = (message: string) => new ResponseStreamError({ message });

/**
 * The fields of a stream event that collecting reads; a field of another type
 * is ignored, as it was when events were read field by field.
 */
const StreamEvent = Schema.Struct({
  type: Schema.optional(Schema.Unknown),
  response: Schema.optional(Schema.Unknown),
  output_index: Schema.optional(Schema.Unknown),
  item: Schema.optional(Schema.Unknown),
});
const decodeEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeFields = Schema.decodeUnknownOption(StreamEvent);
const isOutputIndex = (value: unknown): value is number =>
  Number.isInteger(value) && Predicate.isNumber(value) && value >= 0 && value < 1000;

/**
 * The completed answer of a streamed Responses request. Non-streaming SDK
 * calls still use a streamed request upstream, so only a completed event is a
 * usable response; partial output must never look like success. Items that
 * subscription streams finish in separate events fill an empty `output`.
 */
export const completedResponse = <E>(body: Stream.Stream<Uint8Array, E>) =>
  Effect.gen(function* () {
    const items = new Map<number, unknown>();
    let pending = '';
    let length = 0;
    let completed: unknown;
    yield* body.pipe(
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
            const event = Option.getOrUndefined(decodeFields(json));
            if (
              event?.type === 'response.output_item.done' &&
              isOutputIndex(event.output_index) &&
              Predicate.isTruthy(event.item)
            ) {
              items.set(event.output_index, event.item);
            }
            if (Predicate.isString(event?.type) && FAILED_EVENTS.has(event.type)) {
              return yield* failed('ChatGPT did not complete this response.');
            }
            if (event?.type === 'response.completed') {
              completed = event.response;
            }
          }
        }),
      ),
    );
    if (!Predicate.isTruthy(completed)) {
      return yield* failed('ChatGPT response was interrupted.');
    }
    if (Predicate.isObject(completed) && !Array.isArray(completed) && items.size > 0) {
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
 * `completedResponse` for a fetch `Response`, for the callers that are not
 * migrated. It rejects with a `ResponseStreamError`, or with what reading the
 * body failed with.
 */
export const readCompletedResponse = (response: Response): Promise<unknown> => {
  const { body } = response;
  return Effect.runPromise(
    body === null
      ? Effect.fail(failed('ChatGPT returned no response.'))
      : completedResponse(
          Stream.fromReadableStream({ evaluate: () => body, onError: (error) => error }),
        ),
  );
};
