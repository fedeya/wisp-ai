import path from 'node:path';
import { releaseChannel } from '@wisp/releases';

// A downloaded installer can have a checkout-only Nightly version. Its adjacent
// updater manifest, rather than the source package.json, identifies that build.
export function installerBuildVersion(
  installer: string,
  manifest: {
    version: string;
    platforms: Record<string, { url: string; signature: string }>;
  },
) {
  releaseChannel(manifest.version);
  const platform = manifest.platforms['windows-x86_64'];
  const expected = `WispAI-${manifest.version}-windows-x64-setup.exe`;
  if (
    path.basename(installer) !== expected ||
    !platform?.signature?.trim() ||
    new URL(platform.url).pathname.split('/').pop() !== expected
  ) {
    throw Error('Installer and update manifest must identify the same signed build.');
  }
  return manifest.version;
}
