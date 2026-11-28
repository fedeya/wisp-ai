// @effect-migrated
import { Effect, Predicate } from 'effect';
import { HttpClientRequest, HttpClientResponse } from 'effect/http';

export function safeErrorMessage(message: string): string {
  return message
    .replace(/Bearer\s+[^\s"',}]+/gi, 'Bearer [redacted]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted token]')
    .replace(/\s+/g, ' ')
    .slice(0, 500);
}

/**
 * A failed model response in the form the AI SDK reads, `{error: {message}}`:
 * subscription errors can send `{detail}` instead. The message is redacted and
 * the status and `retry-after` are kept. Any other response comes back as is,
 * its body unread.
 */
export const normalizeModelError = Effect.fnUntraced(function* (response: Response) {
  if (response.ok) {
    return response;
  }
  const body = yield* HttpClientResponse.fromWeb(
    HttpClientRequest.get(response.url),
    response.clone(),
  ).json.pipe(Effect.orElseSucceed(() => null));
  const error = Predicate.hasProperty(body, 'error') ? body.error : undefined;
  const message =
    (Predicate.hasProperty(error, 'message') ? error.message : undefined) ??
    (Predicate.hasProperty(body, 'detail') ? body.detail : undefined);
  if (!Predicate.isString(message)) {
    return response;
  }
  const retryAfter = response.headers.get('retry-after');
  return Response.json(
    { error: { message: safeErrorMessage(message) } },
    {
      status: response.status,
      headers: retryAfter === null ? undefined : { 'retry-after': retryAfter },
    },
  );
});
