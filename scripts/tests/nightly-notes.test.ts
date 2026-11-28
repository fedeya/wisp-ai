import * as NodeServices from '@effect/platform-node/NodeServices';
import { expect, layer } from '@effect/vitest';
import { Effect, FileSystem, Option } from 'effect';
import {
  formatNightlyNotes,
  nightlyNotes,
  previousPublishedNightly,
  publishedNightly,
  validateNotes,
} from '../release-notes.ts';
import { githubReleases, publishedRelease, releasePages } from './github-fixtures.ts';
import { gitIn, temporaryDirectory, writeFiles } from './fixtures.ts';

const sha = 'a'.repeat(40);
const authored = 'kind: Fixed\nbody: Conversations reconnect without restarting Wisp.\n';

layer(NodeServices.layer)((it) => {
  it.effect('nightly release notes contain a technical list and exact comparison link', () =>
    Effect.gen(function* () {
      const notes = yield* formatNightlyNotes(sha, 'v0.0.7', '- test: added regression coverage');
      expect(notes).not.toContain('Nightly preview');
      expect(notes).not.toContain('Experimental build from main');
      expect(notes).not.toContain('## Fixed');
      expect(notes).toContain(
        `[View full diff on GitHub](https://github.com/fedeya/wisp-ai/compare/v0.0.7...${sha})`,
      );
      expect(notes).toMatch(/^# Changes since v0.0.7\n/);
      expect(notes).toContain('- test: added regression coverage');
      expect(yield* validateNotes(notes)).toBe(notes);
    }),
  );

  it.effect('nightly notes link to their source when there is no Stable comparison base', () =>
    Effect.gen(function* () {
      const notes = yield* formatNightlyNotes(sha);
      expect(notes).toContain(`/commit/${sha}`);
      expect(yield* validateNotes(notes)).toBe(notes);
    }),
  );

  it.effect('malformed source identities fail explicitly', () =>
    Effect.gen(function* () {
      expect((yield* Effect.flip(formatNightlyNotes('bad sha'))).message).toContain('identity');
      expect((yield* Effect.flip(formatNightlyNotes(sha, 'nightly'))).message).toContain(
        'identity',
      );
    }),
  );

  it.effect('incremental Nightly notes retain a separate cumulative Stable comparison', () =>
    Effect.gen(function* () {
      const notes = yield* formatNightlyNotes(
        sha,
        'v0.0.8-nightly.1.1',
        '- Fixed reconnects.',
        'v0.0.7',
      );
      expect(notes).toMatch(/^# Changes since v0.0.8-nightly.1.1\n/);
      expect(notes).toContain(`/compare/v0.0.8-nightly.1.1...${sha}`);
      expect(notes).toContain(
        `[All changes since v0.0.7](https://github.com/fedeya/wisp-ai/compare/v0.0.7...${sha})`,
      );
    }),
  );

  it.effect(
    'nightly generation includes technical commits through the exact build without authored notes',
    () =>
      Effect.gen(function* () {
        const root = yield* temporaryDirectory('wisp-nightly-notes-');
        const git = gitIn(root);
        yield* writeFiles(root, { 'releases/unreleased/Fixed-1.yaml': authored });
        yield* git('init');
        yield* git('add', '.');
        const commit = (message: string) => git('commit', '--allow-empty', '-m', message);
        yield* commit('Initial stable');
        const initialSha = yield* git('rev-parse', 'HEAD');
        const withoutStable = yield* nightlyNotes(initialSha, root);
        expect(withoutStable).toContain('- Initial stable');
        expect(withoutStable).toContain(`/commit/${initialSha}`);
        yield* git('tag', 'v0.0.7');
        expect(yield* nightlyNotes(initialSha, root)).toContain('No commits in this comparison.');
        yield* commit('test: added regression coverage');
        yield* git('tag', 'v0.0.8-nightly.1.1');
        yield* commit('fix: retained change from failed build');
        yield* git('tag', 'v0.0.8-nightly.2.1');
        yield* git('tag', 'v0.0.8-nightly.2.2');
        yield* commit('fix: latest change');
        const buildSha = yield* git('rev-parse', 'HEAD');
        yield* git('tag', 'v0.0.8-nightly.3.1');
        yield* commit('docs: update README');
        yield* git('tag', 'v9.0.0');
        yield* git('tag', 'v0.0.8-nightly.2.9');
        const files = yield* FileSystem.FileSystem;
        yield* files.remove(`${root}/releases/unreleased/Fixed-1.yaml`);
        const notes = yield* nightlyNotes(buildSha, root);
        expect(notes).toContain(`/compare/v0.0.7...${buildSha}`);
        expect(notes).not.toContain('v9.0.0');
        expect(notes).toContain('test: added regression coverage');
        expect(notes).toContain(`/commit/${buildSha}`);
        expect(notes).not.toContain('README');
        expect(notes).not.toContain('Conversations reconnect');
        expect(notes).not.toContain('Experimental build from main');

        const successful = publishedRelease('v0.0.8-nightly.1.1');
        const releases = githubReleases(
          releasePages([
            publishedRelease('v0.0.8-nightly.3.1'),
            publishedRelease('v0.0.8-nightly.2.9'), // not an ancestor of this build
            { ...publishedRelease('v0.0.8-nightly.2.2'), assets: [] },
            { ...publishedRelease('v0.0.8-nightly.2.1'), draft: true },
            successful,
          ]),
        );
        const previous = yield* previousPublishedNightly('0.0.8-nightly.3.1', buildSha, root).pipe(
          Effect.provide(releases.layer),
        );
        expect(previous).toEqual(Option.some('v0.0.8-nightly.1.1'));
        // Stable promotes the newest published Nightly that main contains.
        expect(
          yield* publishedNightly(buildSha, root).pipe(Effect.provide(releases.layer)),
        ).toEqual(Option.some('v0.0.8-nightly.3.1'));
        expect(
          yield* publishedNightly(
            buildSha,
            root,
            (candidate) => candidate === '0.0.8-nightly.2.9',
          ).pipe(Effect.provide(releases.layer)),
        ).toEqual(Option.none());
        const incremental = yield* nightlyNotes(buildSha, root, previous);
        expect(incremental).not.toContain('added regression coverage');
        expect(incremental).toContain('retained change from failed build');
        expect(incremental).toContain('latest change');
        expect(incremental).toContain('All changes since v0.0.7');

        const paginated = githubReleases(
          releasePages(
            Array.from({ length: 100 }, () => ({ ...successful, draft: true })),
            [successful],
            [successful],
          ),
        );
        expect(
          yield* previousPublishedNightly('0.0.8-nightly.3.1', buildSha, root).pipe(
            Effect.provide(paginated.layer),
          ),
        ).toEqual(Option.some(successful.tag_name));
        // The third page is never requested once the second one has the answer.
        expect(paginated.sent.map(({ url }) => url.searchParams.get('page'))).toEqual(['1', '2']);

        expect(
          yield* previousPublishedNightly('0.0.8-nightly.1.1', initialSha, root).pipe(
            Effect.provide(githubReleases(releasePages()).layer),
          ),
        ).toEqual(Option.none());
        const unavailable = githubReleases(() => new Response(null, { status: 503 }));
        const failure = yield* Effect.flip(
          previousPublishedNightly('0.0.8-nightly.3.1', buildSha, root).pipe(
            Effect.provide(unavailable.layer),
          ),
        );
        expect(failure.message).toContain('GitHub 503');
      }),
    30_000,
  );

  it.effect('releases are listed through the GitHub API, signed in when a token is set', () =>
    Effect.gen(function* () {
      const anonymous = githubReleases(releasePages());
      yield* publishedNightly(sha, '.').pipe(Effect.provide(anonymous.layer));
      const signed = githubReleases(releasePages(), { GH_TOKEN: 'secret-token' });
      yield* publishedNightly(sha, '.').pipe(Effect.provide(signed.layer));
      const [first] = anonymous.sent;
      const [second] = signed.sent;
      expect(first?.url.href).toBe(
        'https://api.github.com/repos/fedeya/wisp-ai/releases?per_page=100&page=1',
      );
      expect(first?.request.headers.accept).toBe('application/vnd.github+json');
      expect(first?.request.headers).not.toHaveProperty('authorization');
      expect(second?.request.headers.accept).toBe('application/vnd.github+json');
      expect(second?.request.headers.authorization).toBe('Bearer secret-token');
    }),
  );
});
