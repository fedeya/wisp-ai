// Public GitHub asset counters, including downloads outside the website.
const releases: { tag_name: string; assets: { name: string; download_count: number }[] }[] = [];
for (let page = 1; ; page++) {
  const response = await fetch(
    `https://api.github.com/repos/fedeya/wisp-ai/releases?per_page=100&page=${page}`,
    {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(10000),
    },
  );
  if (!response.ok) {
    throw Error(`GitHub releases: HTTP ${response.status}`);
  }
  const batch = (await response.json()) as typeof releases;
  releases.push(...batch);
  if (batch.length < 100) {
    break;
  }
}
const installers = releases.flatMap((release) =>
  release.assets
    .filter((asset) => /^WispAI-.*-windows-x64-setup\.exe$/.test(asset.name))
    .map((asset) => ({ version: release.tag_name, downloads: asset.download_count })),
);
console.log(
  JSON.stringify(
    {
      measuredAt: new Date().toISOString(),
      total: installers.reduce((sum, asset) => sum + asset.downloads, 0),
      installers,
    },
    null,
    2,
  ),
);
