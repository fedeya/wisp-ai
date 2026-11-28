// @effect-migrated
import { Context, DateTime, Effect, Layer, Predicate, Ref, Schema } from 'effect';
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/http';
import type { HttpClientError } from 'effect/http';
import { databaseRequest } from '@wisp/agent/contract/database';
import type { DatabaseRequest, DatabaseRequestInput } from '@wisp/agent/contract/database';

const API = 'https://thewowdb.com/api/v1/forever/';
const REQUEST_TIMEOUT = '20 seconds';
const MAX_TTL_SECONDS = 3600;
const MAX_RESPONSE_LENGTH = 2 * 1024 * 1024;
const CACHE_CAPACITY = 100;

type DatabaseKind = DatabaseRequest['kind'];

// The fields Wisp does not read, passed to the agent as TheWoWDB sent them.
const otherFields = [Schema.Record(Schema.String, Schema.Json)] as const;
// Decoding rebuilds each record with the fields Wisp checks first, in the
// order below, then the rest in the API's order (TheWoWDB sorts its keys).
const foreverFields = (kind: DatabaseKind) => ({
  kind: Schema.Literal(kind),
  version: Schema.Literal('forever'),
});
// A record TheWoWDB marks as the requested Forever kind.
const foreverRecord = (kind: DatabaseKind) =>
  Schema.StructWithRest(Schema.Struct(foreverFields(kind)), otherFields);
// The requested entity, by its ID.
const foreverEntity = (kind: DatabaseKind, id: number) =>
  Schema.StructWithRest(
    Schema.Struct({ id: Schema.Literal(id), ...foreverFields(kind) }),
    otherFields,
  );
// A search page whose every row is a record of the requested kind.
const foreverSearch = (kind: DatabaseKind) =>
  Schema.StructWithRest(
    Schema.Struct({ ...foreverFields(kind), results: Schema.Array(foreverRecord(kind)) }),
    otherFields,
  );

type ForeverEntity = ReturnType<typeof foreverEntity>['Type'];
type ForeverSearch = ReturnType<typeof foreverSearch>['Type'];
/** What TheWoWDB answered, decoded for the request it answers. */
type ForeverData =
  | { readonly operation: 'get'; readonly entity: ForeverEntity }
  | { readonly operation: 'search'; readonly page: ForeverSearch };
interface CacheEntry {
  readonly data: ForeverData;
  readonly etag: string | undefined;
  readonly expiresAt: number;
  readonly fetchedAt: string;
}
interface Source {
  readonly name: 'TheWoWDB';
  readonly version: 'forever';
  readonly apiUrl: string;
}

export type DatabaseResult =
  | {
      readonly status: 'available' | 'no_matches';
      readonly source: Source;
      readonly fetchedAt: string;
      readonly cacheHit: boolean;
      readonly data: ForeverEntity | ForeverSearch;
      readonly note: string;
    }
  | { readonly status: 'not_found'; readonly source: Source; readonly note: string }
  | {
      readonly status: 'unavailable';
      readonly source: Source;
      readonly httpStatus: number;
      readonly retryAfter: string | null;
      readonly note: string;
    }
  | {
      readonly status: 'unavailable';
      readonly source: Source;
      readonly error: string;
      readonly note: string;
    };

/** The request did not match the database contract, so nothing was sent. */
export class InvalidDatabaseRequest extends Schema.TaggedError<InvalidDatabaseRequest>()(
  'InvalidDatabaseRequest',
  { message: Schema.String },
) {}

/** TheWoWDB could not be reached or returned data Wisp cannot verify. */
class DatabaseUnavailable extends Schema.TaggedError<DatabaseUnavailable>()('DatabaseUnavailable', {
  message: Schema.String,
}) {}

export class TheWoWDB extends Context.Service<
  TheWoWDB,
  {
    /** Reads TheWoWDB's Forever catalog; source failures are results the agent can act on. */
    readonly query: (
      input: DatabaseRequestInput,
    ) => Effect.Effect<DatabaseResult, InvalidDatabaseRequest>;
  }
>()('@wisp/server/integrations/TheWoWDB') {}

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

function cachedResult(source: Source, entry: CacheEntry, cacheHit: boolean): DatabaseResult {
  const { data } = entry;
  return {
    status: data.operation === 'search' && !data.page.results.length ? 'no_matches' : 'available',
    source,
    fetchedAt: entry.fetchedAt,
    cacheHit,
    data: data.operation === 'get' ? data.entity : data.page,
    note: 'Preserve record links, attribution and build. Catalog facts are not live player state; an older build may differ. Zone IDs are not necessarily native UiMap IDs.',
  };
}

// Keeps the fetch error's own message ("fetch failed"), as the model saw before.
const transportFailure = (error: HttpClientError.HttpClientError) =>
  new DatabaseUnavailable({
    message:
      error.reason._tag === 'TransportError' && Predicate.isError(error.reason.cause)
        ? error.reason.cause.message
        : error.message,
  });

const unavailable = (message: string) => () => new DatabaseUnavailable({ message });

// Decodes an answer for the request it answers. The response must first be a
// record of the requested Forever kind; then a search's rows must all be, and
// an entity must be the one requested.
const decodeAnswer = Effect.fnUntraced(function* (
  request: DatabaseRequest,
  json: unknown,
): Effect.fn.Return<ForeverData, DatabaseUnavailable> {
  yield* Schema.decodeUnknownEffect(foreverRecord(request.kind))(json).pipe(
    Effect.mapError(
      unavailable('Database response did not confirm the requested Forever version and kind'),
    ),
  );
  if (request.operation === 'search') {
    const page = yield* Schema.decodeUnknownEffect(foreverSearch(request.kind))(json).pipe(
      Effect.mapError(unavailable('Database search contained unverified or other-version records')),
    );
    return { operation: 'search', page };
  }
  const entity = yield* Schema.decodeUnknownEffect(foreverEntity(request.kind, request.id))(
    json,
  ).pipe(Effect.mapError(unavailable('Database returned a different entity')));
  return { operation: 'get', entity };
});

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

export const layer = Layer.effect(
  TheWoWDB,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    // Insertion-ordered so the oldest entry is evicted first. A stale entry is
    // kept past its expiry so its ETag can revalidate it, which `Cache` cannot
    // express: it drops expired entries and does not report hits.
    const cache = yield* Ref.make<ReadonlyMap<string, CacheEntry>>(new Map());
    const store = (key: string, entry: CacheEntry) =>
      Ref.update(cache, (entries) => {
        const next = new Map(entries);
        const oldest = next.keys().next();
        if (next.size >= CACHE_CAPACITY && !oldest.done) next.delete(oldest.value);
        return next.set(key, entry);
      });
    // A revalidated entry keeps its place in the eviction order.
    const replace = (key: string, entry: CacheEntry) =>
      Ref.update(cache, (entries) => new Map(entries).set(key, entry));

    const fetchEntry = Effect.fn('TheWoWDB.fetch')(function* (
      request: DatabaseRequest,
      url: URL,
      source: Source,
      cached: CacheEntry | undefined,
    ) {
      const get = HttpClientRequest.get(url).pipe(HttpClientRequest.acceptJson);
      const response = yield* client
        .execute(
          cached?.etag ? HttpClientRequest.setHeader(get, 'if-none-match', cached.etag) : get,
        )
        .pipe(
          // A redirect could leave the Forever API, so it fails like a network error.
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: 'error' }),
          Effect.mapError(transportFailure),
        );
      const now = yield* DateTime.now;
      if (response.status === 304 && cached) {
        const revalidated = {
          ...cached,
          expiresAt: DateTime.toEpochMillis(now) + MAX_TTL_SECONDS * 1000,
        };
        yield* replace(url.href, revalidated);
        return cachedResult(source, revalidated, true);
      }
      if (response.status === 404) {
        return {
          status: 'not_found',
          source,
          note: 'Not found in this source; this does not prove the entity is absent from Forever.',
        } satisfies DatabaseResult;
      }
      if (response.status < 200 || response.status >= 300) {
        return {
          status: 'unavailable',
          source,
          httpStatus: response.status,
          retryAfter: response.headers['retry-after'] ?? null,
          note: 'Source unavailable. Use a permitted Forever fallback; do not treat this as no matches.',
        } satisfies DatabaseResult;
      }
      const text = yield* response.text.pipe(Effect.mapError(transportFailure));
      if (text.length > MAX_RESPONSE_LENGTH) {
        return yield* new DatabaseUnavailable({ message: 'Database response is too large' });
      }
      const json = yield* decodeJson(text).pipe(
        Effect.mapError((error) => new DatabaseUnavailable({ message: error.message })),
      );
      const data = yield* decodeAnswer(request, json);
      const ttl = Number(response.headers['cache-control']?.match(/max-age=(\d+)/)?.[1] ?? 3600);
      const entry: CacheEntry = {
        data,
        etag: response.headers.etag,
        expiresAt: DateTime.toEpochMillis(now) + Math.min(ttl, MAX_TTL_SECONDS) * 1000,
        fetchedAt: DateTime.formatIso(now),
      };
      yield* store(url.href, entry);
      return cachedResult(source, entry, false);
    });

    const query = Effect.fn('TheWoWDB.query')(function* (input: DatabaseRequestInput) {
      const parsed = databaseRequest.safeParse(input);
      if (!parsed.success) {
        return yield* new InvalidDatabaseRequest({ message: parsed.error.message });
      }
      const request = parsed.data;
      const url = requestUrl(request);
      const source: Source = { name: 'TheWoWDB', version: 'forever', apiUrl: url.href };
      const cached = (yield* Ref.get(cache)).get(url.href);
      const now = yield* DateTime.now;
      if (cached && cached.expiresAt > DateTime.toEpochMillis(now)) {
        return cachedResult(source, cached, true);
      }
      return yield* fetchEntry(request, url, source, cached).pipe(
        Effect.timeoutOrElse({
          duration: REQUEST_TIMEOUT,
          orElse: () =>
            Effect.fail(
              new DatabaseUnavailable({ message: 'The operation was aborted due to timeout' }),
            ),
        }),
        Effect.catchTag('DatabaseUnavailable', (error) =>
          Effect.succeed<DatabaseResult>({
            status: 'unavailable',
            source,
            error: error.message,
            note: 'No verified data was returned. Use a permitted Forever fallback.',
          }),
        ),
      );
    });

    return TheWoWDB.of({ query });
  }),
);
