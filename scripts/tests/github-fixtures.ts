import { ConfigProvider, Effect, Layer } from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/http';
import type { HttpClientRequest } from 'effect/http';
import * as GitHub from '../github-releases.ts';
import type { GitHubRelease } from '../github-releases.ts';

/** A published Nightly release with the assets a promotion needs. */
export const publishedRelease = (
  tag: string,
  extra: Partial<GitHubRelease> = {},
): GitHubRelease => ({
  tag_name: tag,
  draft: false,
  prerelease: tag.includes('-'),
  published_at: '2026-11-20T00:00:00Z',
  assets: [{ name: 'latest.json' }, { name: `WispAI-${tag.slice(1)}-windows-x64-setup.exe` }],
  ...extra,
});

/**
 * The GitHub releases service over an HTTP client that answers each request
 * with `respond`; `sent` records the requests.
 */
export function githubReleases(
  respond: (url: URL) => Response,
  config: Readonly<Record<string, string>> = {},
) {
  const sent: { readonly url: URL; readonly request: HttpClientRequest.HttpClientRequest }[] = [];
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      sent.push({ url, request });
      return HttpClientResponse.fromWeb(request, respond(url));
    }),
  );
  const layer = GitHub.layer.pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(config))),
  );
  return { sent, layer };
}

/** Serves `pages` of releases by the page number GitHub is asked for. */
export const releasePages =
  (...pages: (readonly GitHubRelease[])[]) =>
  (url: URL) =>
    Response.json(pages[Number(url.searchParams.get('page')) - 1] ?? []);
