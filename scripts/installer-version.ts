// @effect-migrated
import path from 'node:path';
import { releaseChannel } from '@wisp/releases';
import { Predicate, Result, Schema } from 'effect';

export class InstallerMismatch extends Schema.TaggedError<InstallerMismatch>()(
  'InstallerMismatch',
  { message: Schema.String },
) {}

/** The part of an updater manifest that identifies the installer it was signed for. */
export interface SignedBuild {
  readonly version: string;
  readonly platforms: Readonly<
    Record<string, { readonly url: string; readonly signature?: string | undefined } | undefined>
  >;
}

// A downloaded installer can have a checkout-only Nightly version. Its adjacent
// updater manifest, rather than the source package.json, identifies that build.
export function installerBuildVersion(
  installer: string,
  manifest: SignedBuild,
): Result.Result<string, InstallerMismatch> {
  const channel = Result.try({
    try: () => releaseChannel(manifest.version),
    catch: (cause) =>
      new InstallerMismatch({ message: Predicate.isError(cause) ? cause.message : String(cause) }),
  });
  if (Result.isFailure(channel)) {
    return Result.fail(channel.failure);
  }
  const platform = manifest.platforms['windows-x86_64'];
  const expected = `WispAI-${manifest.version}-windows-x64-setup.exe`;
  const url = platform ? URL.parse(platform.url) : null;
  if (
    path.basename(installer) !== expected ||
    !platform?.signature?.trim() ||
    url?.pathname.split('/').pop() !== expected
  ) {
    return Result.fail(
      new InstallerMismatch({
        message: 'Installer and update manifest must identify the same signed build.',
      }),
    );
  }
  return Result.succeed(manifest.version);
}
