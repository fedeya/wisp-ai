// @effect-migrated
// The updater manifest (dist/latest.json) of a signed Windows installer.
import type { ReleaseChannel } from '@wisp/releases';
import { DateTime, Effect, FileSystem, Path, Schema } from 'effect';
import { releaseChannelOf } from './release-version.ts';
import type { ReleaseVersionError } from './release-version.ts';

export class UpdateManifestError extends Schema.TaggedError<UpdateManifestError>()(
  'UpdateManifestError',
  { message: Schema.String },
) {}

export interface UpdateManifest {
  readonly version: string;
  readonly notes: string;
  readonly pub_date: string;
  readonly platforms: {
    readonly 'windows-x86_64': { readonly signature: string; readonly url: string };
  };
}

/** The manifest of `version`'s installer, published now. */
export const updateManifest = Effect.fnUntraced(function* (
  version: string,
  signature: string,
  notes: string = '',
  channel: ReleaseChannel = 'stable',
): Effect.fn.Return<UpdateManifest, UpdateManifestError | ReleaseVersionError> {
  if ((yield* releaseChannelOf(version)) !== channel) {
    return yield* new UpdateManifestError({
      message: 'Stable and nightly versions must match their release channel.',
    });
  }
  if (!signature.trim()) {
    return yield* new UpdateManifestError({ message: 'The update signature is missing.' });
  }
  return {
    version,
    notes: notes || `Release notes: https://github.com/fedeya/wisp-ai/releases/tag/v${version}`,
    pub_date: DateTime.formatIso(yield* DateTime.now),
    platforms: {
      'windows-x86_64': {
        signature: signature.trim(),
        url: `https://github.com/fedeya/wisp-ai/releases/download/v${version}/WispAI-${version}-windows-x64-setup.exe`,
      },
    },
  };
});

/** Writes dist/latest.json for `installer`, with the shared release notes when they exist. */
export const writeUpdateManifest = Effect.fnUntraced(function* (
  version: string,
  installer: string,
  root: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const signature = yield* fs.readFileString(path.resolve(root, installer + '.sig'));
  const notes = yield* fs
    .readFileString(path.resolve(root, 'dist/release-notes.md'))
    .pipe(
      Effect.catchTag('PlatformError', (error) =>
        error.reason._tag === 'NotFound' ? Effect.succeed('') : Effect.fail(error),
      ),
    );
  const channel = yield* releaseChannelOf(version);
  const manifest = yield* updateManifest(version, signature, notes, channel);
  yield* fs.writeFileString(
    path.resolve(root, 'dist/latest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  );
});
