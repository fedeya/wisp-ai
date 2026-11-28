// @effect-migrated
import { Predicate, Schema } from 'effect';
import type { PlatformError } from 'effect/PlatformError';

/**
 * Wisp refused a connection operation, or the provider refused a request.
 * `message` is shown to the player as is.
 */
export class ModelConnectionError extends Schema.TaggedError<ModelConnectionError>()(
  'ModelConnectionError',
  { message: Schema.String },
) {}

/**
 * A request to a model provider failed before Wisp could read its answer: it
 * did not reach the provider, timed out, its body was unreadable, or the AI
 * SDK failed while sending it. `cause` is what it failed with, as `fetch` or
 * the AI SDK reported it.
 */
export class ModelRequestError extends Schema.TaggedError<ModelRequestError>()(
  'ModelRequestError',
  { cause: Schema.Defect() },
) {}

/**
 * `connections.json` could not be read, decoded or written; a file that does
 * not decode is left as it was. The message is the one the file system gave.
 */
export class ConnectionsFileError extends Schema.TaggedError<ConnectionsFileError>()(
  'ConnectionsFileError',
  { message: Schema.String, cause: Schema.Defect() },
) {}

/** Like Node's own message for the failed call, which is what the player saw before. */
export const connectionsFileError = (error: PlatformError | Schema.SchemaError) =>
  new ConnectionsFileError({
    message:
      error._tag === 'PlatformError' && Predicate.isError(error.cause)
        ? error.cause.message
        : error.message,
    cause: error,
  });

/** The message `fetch` gives a request whose deadline passed. */
export const TIMED_OUT = 'The operation was aborted due to timeout';
