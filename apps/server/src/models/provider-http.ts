// @effect-migrated
import { Cause, Effect, Option, Redacted, Schema } from 'effect';
import type { Duration } from 'effect';
import type { HttpClientError, HttpClientResponse } from 'effect/http';
import { providerDefinitions } from '@wisp/protocol/providers';
import type { ProviderId } from '@wisp/protocol/providers';
import { safeErrorMessage } from '@wisp/agent/contract/model-errors';
import { ModelConnectionError, ModelRequestError, TIMED_OUT } from './errors.ts';

/** Where a provider's API lives when the connection names no base URL; empty for a local server. */
export const defaultBaseURL = (provider: ProviderId): string =>
  providerDefinitions.find((definition) => definition.id === provider)?.baseURL ?? '';

/** The provider's short name ("Anthropic / Claude" → "Claude"). */
export const providerShortName = (provider: ProviderId): string => {
  if (provider === 'openai') {
    return 'OpenAI';
  }
  const name = providerDefinitions.find((definition) => definition.id === provider)?.name;
  return name?.split(' / ').at(-1) ?? provider;
};

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The connection's API base URL without a trailing slash: HTTPS, or HTTP to
 * this computer, without credentials or URL parameters.
 */
export const providerBaseURL = (connection: {
  readonly baseURL?: string | undefined;
  readonly provider: ProviderId;
}): Effect.Effect<string, ModelConnectionError> => {
  const url = URL.parse(connection.baseURL || defaultBaseURL(connection.provider));
  if (url === null) {
    // What `new URL` threw before, which the desktop showed.
    return Effect.fail(new ModelConnectionError({ message: 'Invalid URL' }));
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname)))
  ) {
    return Effect.fail(
      new ModelConnectionError({
        message: 'Use HTTPS, or HTTP for a local server, without credentials or URL parameters.',
      }),
    );
  }
  return Effect.succeed(url.toString().replace(/\/$/, ''));
};

/** The headers that carry the connection's key, in the form its provider expects. */
export const providerHeaders = (
  provider: ProviderId,
  secret: Redacted.Redacted<string>,
): Record<string, string> => {
  const key = Redacted.value(secret);
  return provider === 'anthropic' || provider === 'minimax'
    ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
    : provider === 'google'
      ? { 'x-goog-api-key': key }
      : key
        ? { authorization: 'Bearer ' + key }
        : {};
};

/** The credential headers a provider SDK may set, which Wisp replaces with its own. */
export const credentialHeaders = ['authorization', 'x-api-key', 'x-goog-api-key'] as const;

/** Removes every occurrence of the key from a provider's text. */
export const redactSecret = (text: string, secret: Redacted.Redacted<string>) => {
  const key = Redacted.value(secret);
  return key ? text.split(key).join('[redacted]') : text;
};

const lenientText = Schema.optional(
  Schema.String.pipe(Schema.catchDecoding(() => Effect.succeedNone)),
);
/** The reason a provider gives with a failed status: OpenAI's `{ error: { message } }` or a plain `{ message }`. */
const ProviderRefusal = Schema.Struct({
  error: Schema.optional(
    Schema.Struct({ message: lenientText }).pipe(Schema.catchDecoding(() => Effect.succeedNone)),
  ),
  message: lenientText,
});
const decodeRefusal = Schema.decodeUnknownOption(Schema.fromJsonString(ProviderRefusal));

/**
 * The error for a provider's failed status: the reason it gave, with the key
 * removed, or its HTTP status when it gave none.
 */
export const providerRefusal = (
  response: HttpClientResponse.HttpClientResponse,
  secret: Redacted.Redacted<string>,
) =>
  response.text.pipe(
    Effect.option,
    Effect.map((text) => {
      const body = Option.getOrUndefined(Option.flatMap(text, decodeRefusal));
      const reason =
        body?.error?.message || body?.message || `Provider returned HTTP ${response.status}.`;
      return new ModelConnectionError({ message: safeErrorMessage(redactSecret(reason, secret)) });
    }),
  );

/** Keeps what the transport failed with, so the player sees the same message as before. */
export const requestFailed = (error: HttpClientError.HttpClientError) =>
  new ModelRequestError({ cause: error.cause ?? error });

/** Fails like a `fetch` whose deadline passed when `effect` takes longer than `duration`. */
export const withDeadline =
  (duration: Duration.Input) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.timeoutOrElse(effect, {
      duration,
      orElse: () =>
        Effect.fail(new ModelRequestError({ cause: new Cause.TimeoutError(TIMED_OUT) })),
    });

/** Whether a status is a success, as `Response.ok` says. */
export const isOk = (response: HttpClientResponse.HttpClientResponse) =>
  response.status >= 200 && response.status < 300;
