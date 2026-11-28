// @effect-migrated allow=effectPromises: hostCall and modelCall adapt the host's fetch and the AI SDK's model calls
import { APICallError, RetryError } from 'ai';
import { Effect, Option, Schema } from 'effect';
import { HistoryError } from '../session/session-history.ts';

/**
 * A call to the engine's host failed: Wisp's content, the session's model
 * settings or the turn's tools. `cause` is the original error.
 */
export class HostError extends Schema.TaggedError<HostError>()('HostError', {
  cause: Schema.Defect(),
}) {}

/**
 * The model call failed. `reason` says how, from the provider's HTTP status:
 *
 * - `rejected`: the provider refused the request itself (400, 413, 422), such
 *   as a history it will not take or one past its context window.
 * - `auth`: the credentials were refused (401, 403).
 * - `rate-limited`: 429, a rate or usage limit.
 * - `unavailable`: the provider failed (5xx).
 * - `other`: anything else, such as the network or a timeout.
 *
 * `cause` is the original error, which keeps its own code for the host.
 */
export class ModelError extends Schema.TaggedError<ModelError>()('ModelError', {
  reason: Schema.Literals(['rejected', 'auth', 'rate-limited', 'unavailable', 'other']),
  status: Schema.optionalKey(Schema.Number),
  cause: Schema.Defect(),
}) {}

/** Compacting a history on request did not produce a summary. */
export class CompactionFailed extends Schema.TaggedError<CompactionFailed>()(
  'CompactionFailed',
  {},
) {}

/** Why a turn failed: a host call, the model, or the session's log. */
export type TurnError = HostError | ModelError | HistoryError;

/** The error behind a turn's failure, as the bridge classifies it. */
export const turnCause = (failure: unknown) =>
  failure instanceof HostError || failure instanceof ModelError || failure instanceof HistoryError
    ? failure.cause
    : failure instanceof CompactionFailed
      ? new Error('Compaction failed.')
      : failure;

/** Any value as JSON, or none when it has no JSON form (a cycle, a BigInt, a function). */
const asJson = Schema.encodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

export function errorText(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error === null || error === undefined) return 'The response failed.';
  return Option.getOrElse(asJson(error), () => 'The response failed.');
}

function reasonFor(status: number | undefined): ModelError['reason'] {
  if (status === 400 || status === 413 || status === 422) return 'rejected';
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate-limited';
  if (status !== undefined && status >= 500) return 'unavailable';
  return 'other';
}

/** A model call's error as a `ModelError`; retried calls report their last attempt. */
export function modelError(cause: unknown) {
  const last = RetryError.isInstance(cause) ? cause.lastError : cause;
  const status = APICallError.isInstance(last) ? last.statusCode : undefined;
  return status === undefined
    ? new ModelError({ reason: 'other', cause: last })
    : new ModelError({ reason: reasonFor(status), status, cause: last });
}

/** A host call: interrupting the fiber aborts `signal`. */
export const hostCall = <A>(run: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new HostError({ cause }) });

/** A model call: interrupting the fiber aborts `signal`. */
export const modelCall = <A>(run: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: modelError });
