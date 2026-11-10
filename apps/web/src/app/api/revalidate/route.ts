import { timingSafeEqual } from 'node:crypto';
import { revalidatePath, revalidateTag } from 'next/cache';
import { RELEASE_CACHE_TAG } from '../../../release-cache.ts';

export async function POST(request: Request) {
  const secret = process.env.WEB_REVALIDATION_SECRET;
  const headers = { 'Cache-Control': 'no-store' };
  if (!secret) {
    return Response.json({ error: 'Revalidation is not configured.' }, { status: 503, headers });
  }
  const expected = Buffer.from(`Bearer ${secret}`);
  const supplied = Buffer.from(request.headers.get('authorization') || '');
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    return Response.json({ error: 'Unauthorized.' }, { status: 401, headers });
  }

  // Expire immediately: "max" would still serve stale data to the first visitor.
  revalidateTag(RELEASE_CACHE_TAG, { expire: 0 });
  // Include rendered pages and metadata, even if an earlier GitHub request failed.
  revalidatePath('/', 'layout');
  return Response.json({ revalidated: true }, { headers });
}
