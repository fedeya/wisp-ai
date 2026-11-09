import { releaseChannel, type ReleaseChannel } from '@wisp/releases';
import { site } from './site.ts';

export type PublishedRelease = {
  version: string;
  channel: ReleaseChannel;
  title: string;
  notes: string;
  date: string;
  url: string;
  download: string;
  downloads: { label: string; url: string }[];
};
type GitHubRelease = {
  tag_name: string;
  name: string;
  body: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string;
  assets: { name: string; browser_download_url: string }[];
};
export function publishedRelease(value: GitHubRelease): PublishedRelease | null {
  try {
    if (
      value.draft ||
      !value.published_at ||
      Number.isNaN(Date.parse(value.published_at)) ||
      !value.tag_name.startsWith('v')
    ) {
      return null;
    }
    const version = value.tag_name.slice(1);
    const channel = releaseChannel(version);
    if (value.prerelease !== (channel === 'nightly')) {
      return null;
    }
    const filename = `WispAI-${version}-windows-x64-setup.exe`;
    const download = `${site.repository}/releases/download/v${version}/${filename}`;
    if (
      !value.assets.some(
        (asset) => asset.name === filename && asset.browser_download_url === download,
      ) ||
      !value.assets.some((asset) => asset.name === 'latest.json')
    ) {
      return null;
    }
    return {
      version,
      channel,
      title: `v${version}`,
      notes: value.body || '',
      date: value.published_at,
      url: `${site.repository}/releases/tag/v${version}`,
      download,
      downloads: [{ label: 'Windows (x64)', url: download }],
    };
  } catch {
    return null;
  }
}
async function github(path: string) {
  const options = {
    headers: {
      Accept: 'application/vnd.github+json',
      ...(process.env.GITHUB_RELEASES_TOKEN
        ? { Authorization: `Bearer ${process.env.GITHUB_RELEASES_TOKEN}` }
        : {}),
    },
    next: { revalidate: 300 },
    signal: AbortSignal.timeout(8000),
  };
  return fetch(`https://api.github.com/repos/fedeya/wisp-ai/releases${path}`, options);
}
export async function getReleaseHistory(channel: ReleaseChannel, page = 1) {
  try {
    const pageSize = 10;
    const start = (Math.max(1, page) - 1) * pageSize;
    const releases: PublishedRelease[] = [];
    let cursor = 1;
    let raw: GitHubRelease[];
    // Filter before paginating: nightly builds must not crowd stable releases out
    // of a page. Fetch one extra matching release to know whether Older is useful.
    do {
      const response = await github(`?per_page=100&page=${cursor}`);
      if (!response.ok) {
        throw Error(`GitHub returned ${response.status}`);
      }
      raw = await response.json();
      releases.push(
        ...raw
          .map(publishedRelease)
          .filter(
            (release): release is PublishedRelease =>
              release !== null && release.channel === channel,
          ),
      );
      cursor++;
    } while (releases.length <= start + pageSize && raw.length === 100);
    return {
      releases: releases.slice(start, start + pageSize),
      more: releases.length > start + pageSize,
      nextPage: page + 1,
      unavailable: false,
    };
  } catch {
    return { releases: [], more: false, nextPage: page + 1, unavailable: true };
  }
}
export async function getPublishedRelease(version: string) {
  try {
    releaseChannel(version);
  } catch {
    return null;
  }
  const response = await github(`/tags/v${version}`);
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw Error('Release history is temporarily unavailable.');
  }
  return publishedRelease(await response.json());
}
