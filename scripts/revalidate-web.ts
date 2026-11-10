import { setTimeout } from 'node:timers/promises';

export async function revalidateWeb(
  url: string,
  secret: string,
  tag?: string,
  fetcher: typeof fetch = fetch,
) {
  if (!secret) {
    throw Error('Configure WEB_REVALIDATION_SECRET in GitHub Actions and Vercel.');
  }
  if (tag && !/^v\d+\.\d+\.\d+(-nightly\.\d+\.\d+)?$/.test(tag)) {
    throw Error('Expected a stable or nightly release tag.');
  }
  const response = await fetcher(new URL('/api/revalidate', url), {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(30_000),
    redirect: 'error',
  });
  if (!response.ok || (await response.json()).revalidated !== true) {
    throw Error(`Web revalidation failed (${response.status}).`);
  }

  // Invalidation alone is lazy. CI makes the first requests so visitors get warm pages.
  for (const locale of ['en', 'es']) {
    const paths = [
      `/${locale}`,
      `/${locale}/changelog`,
      `/${locale}/changelog?channel=nightly`,
      `/${locale}/opengraph-image`,
      ...(tag ? [`/${locale}/changelog/${tag.slice(1)}`] : []),
    ];
    for (const path of paths) {
      const page = await fetcher(new URL(path, url), {
        signal: AbortSignal.timeout(30_000),
        redirect: 'error',
      });
      if (!page.ok) {
        throw Error(`Warming ${path} failed (${page.status}).`);
      }
      const body = await page.text();
      if (tag && path.endsWith(`/changelog/${tag.slice(1)}`) && !body.includes(tag)) {
        throw Error(`Published release ${tag} is not visible at ${path}.`);
      }
    }
  }
}

if (import.meta.main) {
  // GitHub's public API and asset redirects can take a moment to expose a release.
  for (let attempt = 1; ; attempt++) {
    try {
      await revalidateWeb(
        process.env.WEB_URL || 'https://wisp.fedeya.sh',
        process.env.WEB_REVALIDATION_SECRET || '',
        process.env.RELEASE_TAG,
      );
      console.log('Release cache expired and English/Spanish pages warmed.');
      break;
    } catch (error) {
      if (attempt === 5 || !process.env.WEB_REVALIDATION_SECRET) {
        throw error;
      }
      console.error(`Web refresh attempt ${attempt} failed; retrying.`, error);
      await setTimeout(5000);
    }
  }
}
