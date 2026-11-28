// @effect-migrated
// Expires the website's cached release data, so its pages regenerate on their
// next visit, without requesting any public page.
//   WEB_REVALIDATION_SECRET=<secret> node scripts/revalidate-web.ts
// WEB_URL overrides the site, and VERCEL_AUTOMATION_BYPASS_SECRET passes
// Vercel's deployment protection.
import { Config, Console, Effect, Layer, Option, Redacted, Schema } from 'effect';
import { Command } from 'effect/cli';
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http';
import { runScript } from './run-script.ts';

export class RevalidationSecretMissing extends Schema.TaggedError<RevalidationSecretMissing>()(
  'RevalidationSecretMissing',
  { message: Schema.String },
) {}

export class WebRevalidationFailed extends Schema.TaggedError<WebRevalidationFailed>()(
  'WebRevalidationFailed',
  { message: Schema.String },
) {}

const Revalidated = Schema.Struct({ revalidated: Schema.Literal(true) });

const failed = (status?: number) =>
  new WebRevalidationFailed({
    message: `Web revalidation failed${status === undefined ? '' : ` (${status})`}.`,
  });

/** Asks the site at `url` to expire its release data, signed with `secret`. */
export const revalidateWeb = Effect.fnUntraced(function* (
  url: string,
  secret: Option.Option<Redacted.Redacted<string>>,
  automationBypassSecret: Option.Option<Redacted.Redacted<string>> = Option.none(),
) {
  if (Option.isNone(secret)) {
    return yield* new RevalidationSecretMissing({
      message: 'Configure WEB_REVALIDATION_SECRET in GitHub Actions and Vercel.',
    });
  }
  const client = yield* HttpClient.HttpClient;
  let request = HttpClientRequest.post(new URL('/api/revalidate', url)).pipe(
    HttpClientRequest.bearerToken(secret.value),
  );
  if (Option.isSome(automationBypassSecret)) {
    request = request.pipe(
      HttpClientRequest.setHeader(
        'x-vercel-protection-bypass',
        Redacted.value(automationBypassSecret.value),
      ),
    );
  }
  yield* Effect.gen(function* () {
    const response = yield* client.execute(request);
    if (response.status < 200 || response.status > 299) {
      return yield* failed(response.status);
    }
    yield* HttpClientResponse.schemaBodyJson(Revalidated)(response).pipe(
      Effect.mapError(() => failed(response.status)),
    );
  }).pipe(
    Effect.catchTag('HttpClientError', () => Effect.fail(failed())),
    Effect.timeoutOrElse({ duration: '30 seconds', orElse: () => Effect.fail(failed()) }),
  );
});

/**
 * Node's fetch, without trace headers, failing on a redirect instead of
 * following it, so the secret is only ever sent to `url`.
 */
export const httpClientLayer: Layer.Layer<HttpClient.HttpClient> = Layer.effect(
  HttpClient.HttpClient,
  Effect.map(
    HttpClient.HttpClient,
    HttpClient.transform((response) =>
      Effect.provideService(response, FetchHttpClient.RequestInit, { redirect: 'error' }),
    ),
  ),
).pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(Layer.succeed(HttpClient.TracerPropagationEnabled, false)),
);

const attempts = 5;

/** Revalidates the configured site, retrying failures without crawling public pages from CI. */
export const refresh = Effect.gen(function* () {
  const url = yield* Config.String('WEB_URL').pipe(Config.withDefault('https://wisp.fedeya.sh'));
  const secret = yield* Config.option(Config.Redacted('WEB_REVALIDATION_SECRET'));
  const bypass = yield* Config.option(Config.Redacted('VERCEL_AUTOMATION_BYPASS_SECRET'));
  const attempt = (
    number: number,
  ): Effect.Effect<
    void,
    RevalidationSecretMissing | WebRevalidationFailed,
    HttpClient.HttpClient
  > =>
    revalidateWeb(url, secret, bypass).pipe(
      Effect.catchTag('WebRevalidationFailed', (error) =>
        number === attempts
          ? Effect.fail(error)
          : Console.error(`Web refresh attempt ${number} failed; retrying.`, error).pipe(
              Effect.andThen(Effect.sleep('5 seconds')),
              Effect.andThen(attempt(number + 1)),
            ),
      ),
    );
  yield* attempt(1);
  yield* Console.log('Release cache expired; pages regenerate on their next visit.');
});

if (import.meta.main) {
  Command.make('revalidate-web', {}, () => refresh).pipe(
    Command.withDescription("Expire the website's cached release data"),
    Command.run({ version: '1.0.0' }),
    Effect.provide(httpClientLayer),
    runScript,
  );
}
