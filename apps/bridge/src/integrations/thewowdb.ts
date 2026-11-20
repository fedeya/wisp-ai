import { z } from 'zod';

const API = 'https://thewowdb.com/api/v1/forever/';
import { databaseRequest } from '@wisp/protocol/database';
type JsonRecord = Record<string, unknown>;
type CacheEntry = { data: JsonRecord; etag?: string; expiresAt: number; fetchedAt: string };

function object(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class TheWoWDB {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(options: { fetch?: typeof fetch; now?: () => number } = {}) {
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async query(input: z.input<typeof databaseRequest>, signal?: AbortSignal) {
    const request = databaseRequest.parse(input);
    const url = new URL(request.kind + '/', API);
    if (request.operation === 'get') {
      url.pathname += request.id;
    } else {
      url.search = new URLSearchParams({
        q: request.query,
        page: String(request.page),
        per_page: String(request.limit),
      }).toString();
    }
    const source = { name: 'TheWoWDB', version: 'forever' as const, apiUrl: url.href };
    const cached = this.cache.get(url.href);
    if (cached && cached.expiresAt > this.now()) {
      return this.result(source, cached, true);
    }
    try {
      const response = await this.fetcher(url, {
        headers: {
          accept: 'application/json',
          ...(cached?.etag ? { 'if-none-match': cached.etag } : {}),
        },
        redirect: 'error',
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(20000)])
          : AbortSignal.timeout(20000),
      });
      if (response.status === 304 && cached) {
        cached.expiresAt = this.now() + 3600000;
        return this.result(source, cached, true);
      }
      if (response.status === 404) {
        return {
          status: 'not_found',
          source,
          note: 'Not found in this source; this does not prove the entity is absent from Forever.',
        };
      }
      if (!response.ok) {
        return {
          status: 'unavailable',
          source,
          httpStatus: response.status,
          retryAfter: response.headers.get('retry-after'),
          note: 'Source unavailable. Use a permitted Forever fallback; do not treat this as no matches.',
        };
      }
      const text = await response.text();
      if (text.length > 2 * 1024 * 1024) {
        throw new Error('Database response is too large');
      }
      const data: unknown = JSON.parse(text);
      if (!object(data) || data.version !== 'forever' || data.kind !== request.kind) {
        throw new Error('Database response did not confirm the requested Forever version and kind');
      }
      if (request.operation === 'search') {
        if (
          !Array.isArray(data.results) ||
          data.results.some(
            (row) => !object(row) || row.version !== 'forever' || row.kind !== request.kind,
          )
        ) {
          throw new Error('Database search contained unverified or other-version records');
        }
      } else if (data.id !== request.id) {
        throw new Error('Database returned a different entity');
      }
      const ttl = Number(
        response.headers.get('cache-control')?.match(/max-age=(\d+)/)?.[1] ?? 3600,
      );
      const entry = {
        data,
        etag: response.headers.get('etag') ?? undefined,
        expiresAt: this.now() + Math.min(ttl, 3600) * 1000,
        fetchedAt: new Date(this.now()).toISOString(),
      };
      if (this.cache.size >= 100) {
        this.cache.delete(this.cache.keys().next().value!);
      }
      this.cache.set(url.href, entry);
      return this.result(source, entry, false);
    } catch (error) {
      return {
        status: 'unavailable',
        source,
        error: error instanceof Error ? error.message : 'Database request failed',
        note: 'No verified data was returned. Use a permitted Forever fallback.',
      };
    }
  }

  private result(
    source: { name: string; version: 'forever'; apiUrl: string },
    entry: CacheEntry,
    cacheHit: boolean,
  ) {
    return {
      status:
        Array.isArray(entry.data.results) && !entry.data.results.length
          ? 'no_matches'
          : 'available',
      source,
      fetchedAt: entry.fetchedAt,
      cacheHit,
      data: entry.data,
      note: 'Preserve record links, attribution and build. Catalog facts are not live player state; an older build may differ. Zone IDs are not necessarily native UiMap IDs.',
    };
  }
}
