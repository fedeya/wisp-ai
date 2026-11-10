import { setTimeout } from 'node:timers/promises';

export async function revalidateWeb(
  url: string,
  secret: string,
  automationBypassSecret?: string,
  fetcher: typeof fetch = fetch,
) {
  if (!secret) {
    throw Error('Configure WEB_REVALIDATION_SECRET in GitHub Actions and Vercel.');
  }
  const response = await fetcher(new URL('/api/revalidate', url), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      ...(automationBypassSecret ? { 'x-vercel-protection-bypass': automationBypassSecret } : {}),
    },
    signal: AbortSignal.timeout(30_000),
    redirect: 'error',
  });
  if (!response.ok || (await response.json()).revalidated !== true) {
    throw Error(`Web revalidation failed (${response.status}).`);
  }
}

if (import.meta.main) {
  // Retry transient failures without crawling public pages from CI.
  for (let attempt = 1; ; attempt++) {
    try {
      await revalidateWeb(
        process.env.WEB_URL || 'https://wisp.fedeya.sh',
        process.env.WEB_REVALIDATION_SECRET || '',
        process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
      );
      console.log('Release cache expired; pages regenerate on their next visit.');
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
