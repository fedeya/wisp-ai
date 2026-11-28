// @effect-migrated
import { Config, Context, Effect, Layer, Option, Schedule, Schema, Stream } from 'effect';
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http';

/** The part of a GitHub release the release scripts read. */
export const GitHubRelease = Schema.Struct({
  tag_name: Schema.String,
  draft: Schema.Boolean,
  prerelease: Schema.Boolean,
  published_at: Schema.NullOr(Schema.String),
  assets: Schema.Array(Schema.Struct({ name: Schema.String })),
});
export type GitHubRelease = typeof GitHubRelease.Type;

export class GitHubReleasesError extends Schema.TaggedError<GitHubReleasesError>()(
  'GitHubReleasesError',
  { message: Schema.String },
) {}

/** The releases of fedeya/wisp-ai on GitHub. */
export class GitHubReleases extends Context.Service<
  GitHubReleases,
  {
    /** Every release, drafts included, newest first, one page at a time. */
    readonly pages: Stream.Stream<readonly GitHubRelease[], GitHubReleasesError>;
  }
>()('@wisp/scripts/GitHubReleases') {}

const pageSize = 100;
const decodePage = HttpClientResponse.schemaBodyJson(Schema.Array(GitHubRelease));
const failed = (cause: { readonly message: string }) =>
  new GitHubReleasesError({ message: `Cannot list GitHub releases: ${cause.message}` });

/**
 * Lists releases through the GitHub API, signed in with `GH_TOKEN` when it is
 * set, trying each page up to three times when GitHub fails transiently. A
 * page is requested only when the one before it was read.
 */
export const layer = Layer.effect(
  GitHubReleases,
  Effect.gen(function* () {
    const token = yield* Config.option(Config.Redacted('GH_TOKEN'));
    const client = (yield* HttpClient.HttpClient).pipe(
      // Network errors, 408, 429 and 5xx get two more tries, 500 ms then 1 s
      // apart (a `Retry-After` header lengthens the wait); anything else fails at once.
      HttpClient.retryTransient({ schedule: Schedule.exponential('500 millis'), times: 2 }),
      HttpClient.mapRequest((request) => {
        const accepting = request.pipe(
          HttpClientRequest.setHeader('Accept', 'application/vnd.github+json'),
        );
        return Option.isSome(token)
          ? accepting.pipe(HttpClientRequest.bearerToken(token.value))
          : accepting;
      }),
    );
    const page = Effect.fnUntraced(function* (number: number) {
      const response = yield* client
        .get(
          `https://api.github.com/repos/fedeya/wisp-ai/releases?per_page=${pageSize}&page=${number}`,
        )
        .pipe(Effect.mapError(failed));
      if (response.status < 200 || response.status > 299) {
        return yield* new GitHubReleasesError({
          message: `Cannot list GitHub releases: GitHub ${response.status}.`,
        });
      }
      return yield* decodePage(response).pipe(Effect.mapError(failed));
    });
    const pages = Stream.paginate(1, (number: number) =>
      page(number).pipe(
        Effect.timeoutOrElse({
          duration: '15 seconds',
          orElse: () => Effect.fail(failed({ message: 'GitHub did not answer in time.' })),
        }),
        Effect.map(
          (releases) =>
            [
              [releases],
              releases.length < pageSize ? Option.none() : Option.some(number + 1),
            ] as const,
        ),
      ),
    );
    return GitHubReleases.of({ pages });
  }),
);

/** The client the scripts call GitHub with: Node's fetch, without trace headers. */
export const httpClientLayer: Layer.Layer<HttpClient.HttpClient> = FetchHttpClient.layer.pipe(
  Layer.provide(Layer.succeed(HttpClient.TracerPropagationEnabled, false)),
);
