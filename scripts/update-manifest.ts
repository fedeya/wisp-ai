import { readFile, writeFile } from 'node:fs/promises';
import { releaseChannel, type ReleaseChannel } from '@wisp/releases';

export function updateManifest(
  version: string,
  signature: string,
  notes = '',
  channel: ReleaseChannel = 'stable',
) {
  if (releaseChannel(version) !== channel) {
    throw Error('Stable and nightly versions must match their release channel.');
  }
  if (!signature.trim()) {
    throw Error('The update signature is missing.');
  }
  return {
    version,
    notes: notes || `Release notes: https://github.com/fedeya/wisp-ai/releases/tag/v${version}`,
    pub_date: new Date().toISOString(),
    platforms: {
      'windows-x86_64': {
        signature: signature.trim(),
        url: `https://github.com/fedeya/wisp-ai/releases/download/v${version}/WispAI-${version}-windows-x64-setup.exe`,
      },
    },
  };
}

export async function writeUpdateManifest(version: string, installer: string) {
  const signature = await readFile(installer + '.sig', 'utf8');
  const notes = await readFile('dist/release-notes.md', 'utf8').catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      return '';
    },
  );
  await writeFile(
    'dist/latest.json',
    JSON.stringify(updateManifest(version, signature, notes, releaseChannel(version)), null, 2) +
      '\n',
  );
}
