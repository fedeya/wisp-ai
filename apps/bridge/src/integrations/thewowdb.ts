import { Effect, Schedule } from 'effect';
import { HttpClient } from 'effect/http';
import { withHttpClient } from './http-client.ts';
import { z } from 'zod';
import { bridgeRuntime } from '../logger.ts';

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
    const lookup = Effect.gen({ self: this }, function* () {
      // A dropped connection is retried; an answer (even a failed status) is final.
      const client = (yield* HttpClient.HttpClient).pipe(
        HttpClient.retryTransient({
          retryOn: 'errors-only',
          times: 2,
          schedule: Schedule.exponential('200 millis'),
        }),
        HttpClient.timeout('20 seconds'),
      );
      const response = yield* client.get(url, {
        headers: {
          accept: 'application/json',
          ...(cached?.etag ? { 'if-none-match': cached.etag } : {}),
        },
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
      if (response.status < 200 || response.status >= 300) {
        return {
          status: 'unavailable',
          source,
          httpStatus: response.status,
          retryAfter: response.headers['retry-after'] ?? null,
          note: 'Source unavailable. Use a permitted Forever fallback; do not treat this as no matches.',
        };
      }
      const text = yield* response.text;
      if (text.length > 2 * 1024 * 1024) {
        return yield* Effect.fail(new Error('Database response is too large'));
      }
      const data = yield* Effect.try(() => JSON.parse(text) as unknown);
      const invalid = this.invalid(request, data);
      if (invalid) {
        return yield* Effect.fail(new Error(invalid));
      }
      const ttl = Number(response.headers['cache-control']?.match(/max-age=(\d+)/)?.[1] ?? 3600);
      const entry = {
        data: data as JsonRecord,
        etag: response.headers.etag,
        expiresAt: this.now() + Math.min(ttl, 3600) * 1000,
        fetchedAt: new Date(this.now()).toISOString(),
      };
      if (this.cache.size >= 100) {
        this.cache.delete(this.cache.keys().next().value!);
      }
      this.cache.set(url.href, entry);
      return this.result(source, entry, false);
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed({
          status: 'unavailable',
          source,
          error: error instanceof Error ? error.message : 'Database request failed',
          note: 'No verified data was returned. Use a permitted Forever fallback.',
        }),
      ),
      withHttpClient(this.fetcher),
    );
    return bridgeRuntime.runPromise(lookup, signal ? { signal } : undefined);
  }

  // Why a response cannot be used: another version, kind or entity.
  private invalid(request: z.infer<typeof databaseRequest>, data: unknown) {
    if (!object(data) || data.version !== 'forever' || data.kind !== request.kind) {
      return 'Database response did not confirm the requested Forever version and kind';
    }
    if (request.operation === 'search') {
      if (
        !Array.isArray(data.results) ||
        data.results.some(
          (row) => !object(row) || row.version !== 'forever' || row.kind !== request.kind,
        )
      ) {
        return 'Database search contained unverified or other-version records';
      }
    } else if (data.id !== request.id) {
      return 'Database returned a different entity';
    }
    return undefined;
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
