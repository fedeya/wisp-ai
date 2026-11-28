// @effect-migrated
import { Cause, Effect, Schema } from 'effect';
import type { Duration } from 'effect';
import type { HttpClientError } from 'effect/http';

/** A ChatGPT account operation failed; `message` is shown to the player as is. */
export class ChatGPTAuthError extends Schema.TaggedError<ChatGPTAuthError>()('ChatGPTAuthError', {
  message: Schema.String,
}) {}

/**
 * A request to ChatGPT failed before Wisp could read its answer: it did not
 * reach ChatGPT, timed out, or its body was unreadable. `cause` is what the
 * request failed with, as `fetch` reported it.
 */
export class ChatGPTRequestError extends Schema.TaggedError<ChatGPTRequestError>()(
  'ChatGPTRequestError',
  { cause: Schema.Defect() },
) {}

/** The message `fetch` gives a request whose deadline passed. */
const TIMED_OUT = 'The operation was aborted due to timeout';

/** Keeps what the transport failed with, so the player sees the same message as before. */
export const requestFailed = (error: HttpClientError.HttpClientError) =>
  new ChatGPTRequestError({ cause: error.cause ?? error });

/** Fails with a `ChatGPTRequestError` when `effect` takes longer than `duration`. */
export const withDeadline =
  (duration: Duration.Input) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.timeoutOrElse(effect, {
      duration,
      orElse: () =>
        Effect.fail(new ChatGPTRequestError({ cause: new Cause.TimeoutError(TIMED_OUT) })),
    });
