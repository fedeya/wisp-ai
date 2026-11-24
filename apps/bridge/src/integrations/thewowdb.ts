import { Clock, Context, Effect, Layer, Schedule, Schema } from 'effect';
import { HttpClient, type HttpClientResponse } from 'effect/http';
import type { z } from 'zod';
import { databaseRequest } from '@wisp/protocol/database';

const API = 'https://thewowdb.com/api/v1/forever/';
const RESPONSE_LIMIT = 2 * 1024 * 1024;
const CACHE_LIMIT = 100;
const MAX_TTL_SECONDS = 3600;

type JsonRecord = Record<string, unknown>;
type CacheEntry = { data: JsonRecord; etag?: string; expiresAt: number; fetchedAt: string };
type DatabaseRequest = z.infer<typeof databaseRequest>;
const source = (apiUrl: string) => ({ name: 'TheWoWDB', version: 'forever' as const, apiUrl });
type Source = ReturnType<typeof source>;

/** What the agent receives for a catalog request; failures are results it can act on. */
export type DatabaseResult =
  | {
      status: 'available' | 'no_matches';
      source: Source;
      fetchedAt: string;
      cacheHit: boolean;
      data: JsonRecord;
      note: string;
    }
  | { status: 'not_found'; source: Source; note: string }
  | {
      status: 'unavailable';
      source: Source;
      httpStatus?: number;
      retryAfter?: string | null;
      error?: string;
      note: string;
    };

/** TheWoWDB answered with data Wisp cannot use, or could not be reached. */
export class TheWoWDBError extends Schema.TaggedError<TheWoWDBError>()('TheWoWDBError', {
  message: Schema.String,
}) {}

function object(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requestUrl(request: DatabaseRequest) {
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
  return url;
}

// Why a response cannot be used: another version, kind or entity.
function invalid(request: DatabaseRequest, data: unknown) {
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

function available(apiUrl: string, entry: CacheEntry, cacheHit: boolean): DatabaseResult {
  return {
    status:
      Array.isArray(entry.data.results) && !entry.data.results.length ? 'no_matches' : 'available',
    source: source(apiUrl),
    fetchedAt: entry.fetchedAt,
    cacheHit,
    data: entry.data,
    note: 'Preserve record links, attribution and build. Catalog facts are not live player state; an older build may differ. Zone IDs are not necessarily native UiMap IDs.',
  };
}

/**
 * TheWoWDB, the primary Forever catalog. Responses are verified to be Forever
 * records of the requested kind and cached by URL for up to an hour, then
 * revalidated with their ETag.
 */
export class TheWoWDB extends Context.Service<
  TheWoWDB,
  { query(input: z.input<typeof databaseRequest>): Effect.Effect<DatabaseResult> }
>()('wisp/bridge/integrations/TheWoWDB') {
  static readonly layer = Layer.effect(
    TheWoWDB,
    Effect.gen(function* () {
      // A dropped connection is retried; an answer (even a failed status) is final.
      const client = (yield* HttpClient.HttpClient).pipe(
        HttpClient.retryTransient({
          retryOn: 'errors-only',
          times: 2,
          schedule: Schedule.exponential('200 millis'),
        }),
        HttpClient.timeout('20 seconds'),
      );
      const cache = new Map<string, CacheEntry>();

      const remember = (
        href: string,
        response: HttpClientResponse.HttpClientResponse,
        data: JsonRecord,
        now: number,
      ) => {
        const ttl = Number(
          response.headers['cache-control']?.match(/max-age=(\d+)/)?.[1] ?? MAX_TTL_SECONDS,
        );
        const entry: CacheEntry = {
          data,
          etag: response.headers.etag,
          expiresAt: now + Math.min(ttl, MAX_TTL_SECONDS) * 1000,
          fetchedAt: new Date(now).toISOString(),
        };
        if (cache.size >= CACHE_LIMIT) {
          cache.delete(cache.keys().next().value!);
        }
        cache.set(href, entry);
        return entry;
      };

      const fetchRecord = Effect.fn('TheWoWDB.fetch')(function* (
        request: DatabaseRequest,
        href: string,
        cached: CacheEntry | undefined,
      ) {
        const response = yield* client.get(href, {
          headers: {
            accept: 'application/json',
            ...(cached?.etag ? { 'if-none-match': cached.etag } : {}),
          },
        });
        const now = yield* Clock.currentTimeMillis;
        if (response.status === 304 && cached) {
          cached.expiresAt = now + MAX_TTL_SECONDS * 1000;
          return available(href, cached, true);
        }
        if (response.status === 404) {
          return {
            status: 'not_found',
            source: source(href),
            note: 'Not found in this source; this does not prove the entity is absent from Forever.',
          } satisfies DatabaseResult;
        }
        if (response.status < 200 || response.status >= 300) {
          return {
            status: 'unavailable',
            source: source(href),
            httpStatus: response.status,
            retryAfter: response.headers['retry-after'] ?? null,
            note: 'Source unavailable. Use a permitted Forever fallback; do not treat this as no matches.',
          } satisfies DatabaseResult;
        }
        const text = yield* response.text;
        if (text.length > RESPONSE_LIMIT) {
          return yield* new TheWoWDBError({ message: 'Database response is too large' });
        }
        const data = yield* Effect.try({
          try: () => JSON.parse(text) as unknown,
          catch: () => new TheWoWDBError({ message: 'Database returned invalid JSON' }),
        });
        const problem = invalid(request, data);
        if (problem) {
          return yield* new TheWoWDBError({ message: problem });
        }
        return available(href, remember(href, response, data as JsonRecord, now), false);
      });

      const query = Effect.fn('TheWoWDB.query')(function* (input: z.input<typeof databaseRequest>) {
        const request = databaseRequest.parse(input);
        const href = requestUrl(request).href;
        const cached = cache.get(href);
        if (cached && cached.expiresAt > (yield* Clock.currentTimeMillis)) {
          return available(href, cached, true);
        }
        return yield* fetchRecord(request, href, cached).pipe(
          Effect.catch((error) =>
            Effect.succeed<DatabaseResult>({
              status: 'unavailable',
              source: source(href),
              error: error instanceof Error ? error.message : 'Database request failed',
              note: 'No verified data was returned. Use a permitted Forever fallback.',
            }),
          ),
        );
      });

      return TheWoWDB.of({ query });
    }),
  );
}
