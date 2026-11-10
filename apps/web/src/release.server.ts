import { site } from './site.ts';
import { RELEASE_CACHE_TAG } from './release-cache.ts';

export async function getLatestRelease(): Promise<{ version: string; download: string } | null> {
  try {
    const options = {
      next: { revalidate: 300, tags: [RELEASE_CACHE_TAG] },
      signal: AbortSignal.timeout(5000),
    };
    const response = await fetch(
      `${site.repository}/releases/latest/download/latest.json`,
      options,
    );
    if (!response.ok) {
      throw new Error(`Release manifest returned ${response.status}`);
    }
    const manifest = await response.json();
    const version = manifest?.version;
    const download = manifest?.platforms?.['windows-x86_64']?.url;
    if (
      typeof version !== 'string' ||
      !/^\d+\.\d+\.\d+$/.test(version) ||
      typeof download !== 'string' ||
      download !==
        `${site.repository}/releases/download/v${version}/WispAI-${version}-windows-x64-setup.exe`
    ) {
      throw new Error('Release manifest is missing a valid Windows installer');
    }
    return { version, download };
  } catch (error) {
    console.error('Unable to load the latest Wisp release:', error);
    return null;
  }
}
