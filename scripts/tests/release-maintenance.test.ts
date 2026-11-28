import { expect, it } from '@effect/vitest';
import { Effect, Layer, Result } from 'effect';
import { installerBuildVersion } from '../installer-version.ts';
import {
  ReleaseStore,
  ReleaseStoreError,
  syncReleaseNotes,
  type Manifest,
  type Release,
} from '../sync-release-notes.ts';
import { updateManifest } from '../update-manifest.ts';

it.effect.each(['0.0.7', '0.0.8-nightly.123.2'])(
  'installer verification uses the artifact version %s independently of the source checkout',
  (version) =>
    Effect.gen(function* () {
      const manifest = yield* updateManifest(
        version,
        'signature',
        'Old notes',
        version.includes('-') ? 'nightly' : 'stable',
      );
      expect(installerBuildVersion(`WispAI-${version}-windows-x64-setup.exe`, manifest)).toEqual(
        Result.succeed(version),
      );
      const other = installerBuildVersion('WispAI-0.0.6-windows-x64-setup.exe', manifest);
      expect(Result.isFailure(other) && other.failure.message).toContain('same signed build');
      const moved = {
        ...manifest,
        platforms: {
          'windows-x86_64': {
            ...manifest.platforms['windows-x86_64'],
            url: 'https://example.com/wrong.exe',
          },
        },
      };
      expect(
        Result.isFailure(installerBuildVersion(`WispAI-${version}-windows-x64-setup.exe`, moved)),
      ).toBe(true);
      const unsupported = installerBuildVersion('WispAI-1.0-windows-x64-setup.exe', {
        ...manifest,
        version: '1.0',
      });
      expect(Result.isFailure(unsupported) && unsupported.failure.message).toBe(
        'Unsupported release version: 1.0',
      );
    }),
);

const notes = '# Wisp updates\n\n## Fixed\n\n- Fixed connections.\n';

const manifestOf = (version: string, signature: string, manifestNotes: string): Manifest => ({
  version,
  notes: manifestNotes,
  pub_date: '2026-11-20T00:00:00.000Z',
  platforms: {
    'windows-x86_64': {
      signature,
      url: `https://github.com/fedeya/wisp-ai/releases/download/v${version}/WispAI-${version}-windows-x64-setup.exe`,
    },
  },
});

/** How the next store calls behave in a test. */
interface Control {
  /** Answers the next reads of the release before its stored state. */
  readBack: Release[];
  /** Makes the next body write fail after doing what `before` does. */
  failBody: { readonly before: (body: string) => void } | undefined;
  /** Makes every manifest write fail. */
  failManifests: boolean;
}

const failure = (message: string) => Effect.fail(new ReleaseStoreError({ message }));

/** A release and its manifests kept in memory. */
function fixture(version = '0.0.7', feedVersion = version) {
  const tag = `v${version}`;
  const release = {
    body: 'Original body',
    isDraft: false,
    isPrerelease: version.includes('-'),
  };
  const manifests = new Map<string, Manifest>([
    [
      tag,
      {
        ...manifestOf(version, 'original-signature', 'Original notes'),
        custom: { preserve: true },
      },
    ],
    ['nightly', manifestOf(feedVersion, 'feed-signature', 'Feed notes')],
  ]);
  const original = structuredClone(manifests);
  const writes: string[] = [];
  const control: Control = { readBack: [], failBody: undefined, failManifests: false };
  const store = ReleaseStore.of({
    release: () => Effect.sync(() => control.readBack.shift() ?? { ...release }),
    manifest: (target) => {
      const manifest = manifests.get(target);
      return manifest ? Effect.succeed(structuredClone(manifest)) : failure(`No ${target}`);
    },
    writeBody: (_target, body) =>
      Effect.suspend(() => {
        writes.push('body');
        const failing = control.failBody;
        control.failBody = undefined;
        if (failing) {
          failing.before(body);
          return failure('Connection lost after write');
        }
        release.body = body;
        return Effect.void;
      }),
    writeManifest: (target, manifest) =>
      Effect.suspend(() => {
        writes.push(`manifest ${target}`);
        if (control.failManifests) {
          return failure('Server unavailable');
        }
        manifests.set(target, structuredClone(manifest));
        return Effect.void;
      }),
  });
  return {
    tag,
    release,
    manifests,
    original,
    writes,
    control,
    layer: Layer.succeed(ReleaseStore, store),
  };
}

it.effect(
  'notes preview performs no writes; applying changes only notes and preserves all manifest fields',
  () =>
    Effect.gen(function* () {
      const f = fixture();
      expect((yield* syncReleaseNotes(f.tag, notes).pipe(Effect.provide(f.layer))).applied).toBe(
        false,
      );
      expect(f.writes).toEqual([]);
      yield* syncReleaseNotes(f.tag, notes, true).pipe(Effect.provide(f.layer));
      expect(f.release.body).toBe(notes);
      expect(f.manifests.get(f.tag)).toEqual({ ...f.original.get(f.tag), notes });
      expect(f.manifests.get('nightly')).toEqual(f.original.get('nightly'));
    }),
);

it.effect.each([true, false])(
  'nightly notes update the moving feed only if it targets this build: %s',
  (current) =>
    Effect.gen(function* () {
      const f = fixture(
        '0.0.8-nightly.123.2',
        current ? '0.0.8-nightly.123.2' : '0.0.8-nightly.124.1',
      );
      const result = yield* syncReleaseNotes(f.tag, notes, true).pipe(Effect.provide(f.layer));
      expect(result.targets).toEqual(current ? [f.tag, 'nightly'] : [f.tag]);
      expect(f.manifests.get('nightly')).toEqual(
        current ? { ...f.original.get('nightly'), notes } : f.original.get('nightly'),
      );
    }),
);

it.effect('failed writes restore original release and both nightly manifests', () =>
  Effect.gen(function* () {
    const f = fixture('0.0.8-nightly.123.2');
    f.control.failBody = {
      before: (body) => {
        f.release.body = body;
      },
    };
    const error = yield* Effect.flip(
      syncReleaseNotes(f.tag, notes, true).pipe(Effect.provide(f.layer)),
    );
    expect(error.message).toContain('previous notes were restored');
    expect(f.release.body).toBe('Original body');
    expect(f.manifests).toEqual(f.original);
  }),
);

it.effect('mismatched release manifests and invalid notes fail before any writes', () =>
  Effect.gen(function* () {
    const f = fixture();
    f.manifests.set(f.tag, manifestOf('0.0.6', 'signature', 'Notes'));
    const mismatch = yield* Effect.flip(
      syncReleaseNotes(f.tag, notes, true).pipe(Effect.provide(f.layer)),
    );
    expect(mismatch.message).toContain('does not match');
    const unfinished = yield* Effect.flip(
      syncReleaseNotes(f.tag, '# unfinished', true).pipe(Effect.provide(f.layer)),
    );
    expect(unfinished.message).toContain('user-facing');
    expect(f.writes).toEqual([]);
  }),
);

it.effect('a failed read-back also restores notes, and incomplete rollback is reported', () =>
  Effect.gen(function* () {
    const f = fixture();
    f.control.readBack.push({ ...f.release }, { ...f.release, body: 'Unexpected server response' });
    const unverified = yield* Effect.flip(
      syncReleaseNotes(f.tag, notes, true).pipe(Effect.provide(f.layer)),
    );
    expect(unverified.message).toContain('previous notes were restored');
    expect(f.manifests).toEqual(f.original);
    expect(f.release.body).toBe('Original body');

    f.control.failManifests = true;
    const incomplete = yield* Effect.flip(
      syncReleaseNotes(f.tag, notes, true).pipe(Effect.provide(f.layer)),
    );
    expect(incomplete.message).toContain('rollback was incomplete');
  }),
);
