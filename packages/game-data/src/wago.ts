// @effect-migrated
import { Context, Effect, FileSystem, Layer, Option, Path, Schedule, Schema } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/http';
import type { HttpClientResponse } from 'effect/http';
import { parseCsv, type Row } from './csv.ts';

// Client languages wago.tools serves; enUS is the default.
export type Locale =
  | 'enUS'
  | 'esMX'
  | 'esES'
  | 'deDE'
  | 'frFR'
  | 'itIT'
  | 'ptBR'
  | 'ruRU'
  | 'koKR'
  | 'zhCN'
  | 'zhTW';

/** A game table could not be read. */
export class TableReadError extends Schema.TaggedError<TableReadError>()('TableReadError', {
  message: Schema.String,
}) {}

/** wago.tools' build list could not be read. */
export class BuildListError extends Schema.TaggedError<BuildListError>()('BuildListError', {
  message: Schema.String,
}) {}

/** Where datasets read the DB2 tables of one game build. */
export class GameTables extends Context.Service<
  GameTables,
  { readonly read: (name: string, locale?: Locale) => Effect.Effect<Row[], TableReadError> }
>()('@wisp/game-data/GameTables') {}

const BASE = 'https://wago.tools';
const USER_AGENT = 'wisp-game-data';

// Every request is a GET, so a transient failure is safe to repeat.
const wagoClient = Effect.map(HttpClient.HttpClient, (client) =>
  client.pipe(
    HttpClient.mapRequest(HttpClientRequest.setHeader('user-agent', USER_AGENT)),
    HttpClient.retryTransient({ schedule: Schedule.exponential('500 millis'), times: 3 }),
  ),
);

const isOk = (response: HttpClientResponse.HttpClientResponse) =>
  response.status >= 200 && response.status < 300;

// Reads DB2 tables for one game build from wago.tools, keeping each CSV in
// cacheDir/<build>/<locale>/ so a regeneration can be repeated offline.
export const layer = (options: { build: string; cacheDir: string; refresh: boolean }) =>
  Layer.effect(
    GameTables,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const client = yield* wagoClient;
      const { build, cacheDir, refresh } = options;

      const download = Effect.fn('GameTables.download')(function* (
        name: string,
        locale: Locale,
        file: string,
      ) {
        const what = `wago.tools ${name} (${locale}) for build ${build}`;
        const failed = (cause: { readonly message: string }) =>
          new TableReadError({ message: `${what}: ${cause.message}` });
        const query = new URLSearchParams({ build });
        if (locale !== 'enUS') {
          query.set('locale', locale);
        }
        const response = yield* client
          .get(`${BASE}/db2/${encodeURIComponent(name)}/csv?${query}`)
          .pipe(Effect.mapError(failed));
        if (!isOk(response)) {
          return yield* new TableReadError({ message: `${what}: HTTP ${response.status}` });
        }
        const text = yield* response.text.pipe(Effect.mapError(failed));
        yield* fs
          .makeDirectory(path.dirname(file), { recursive: true })
          .pipe(Effect.mapError(failed));
        yield* fs.writeFileString(file, text).pipe(Effect.mapError(failed));
        return text;
      });

      const read = Effect.fn('GameTables.read')(function* (name: string, locale: Locale = 'enUS') {
        const file = path.join(cacheDir, build, locale, `${name}.csv`);
        if (!refresh) {
          // A missing or unreadable cache entry is downloaded again.
          const cached = yield* fs.readFileString(file).pipe(Effect.option);
          if (Option.isSome(cached)) {
            return parseCsv(cached.value);
          }
        }
        return parseCsv(yield* download(name, locale, file));
      });

      return GameTables.of({ read });
    }),
  );

// Tables given inline, for tests; a locale other than enUS reads "<name>:<locale>".
export const layerMemory = (tables: Record<string, Row[]>) =>
  Layer.succeed(
    GameTables,
    GameTables.of({
      read: Effect.fn('GameTables.read')(function* (name: string, locale: Locale = 'enUS') {
        const key = locale === 'enUS' ? name : `${name}:${locale}`;
        const rows = tables[key];
        if (!rows) {
          return yield* new TableReadError({ message: `Missing table ${key}` });
        }
        return rows;
      }),
    }),
  );

const Build = Schema.Struct({ version: Schema.String, created_at: Schema.String });
// Only the requested product's list is decoded, so another product's entries
// cannot fail the check.
const BuildLists = Schema.Record(Schema.String, Schema.Unknown);
const decodeBuildLists = Schema.decodeUnknownEffect(Schema.fromJsonString(BuildLists));
const decodeBuilds = Schema.decodeUnknownEffect(Schema.Array(Build));
const buildListFailed = (cause: { readonly message: string }) =>
  new BuildListError({ message: `wago.tools builds: ${cause.message}` });

// The newest build wago.tools lists for a product, e.g. "wowf" for Forever.
export const latestBuild = Effect.fn('latestBuild')(function* (product: string) {
  const client = yield* wagoClient;
  const response = yield* client.get(`${BASE}/api/builds`).pipe(Effect.mapError(buildListFailed));
  if (!isOk(response)) {
    return yield* new BuildListError({ message: `wago.tools builds: HTTP ${response.status}` });
  }
  const lists = yield* response.text.pipe(
    Effect.flatMap(decodeBuildLists),
    Effect.mapError(buildListFailed),
  );
  const builds = yield* decodeBuilds(lists[product] ?? []).pipe(Effect.mapError(buildListFailed));
  const latest = builds[0];
  if (!latest) {
    return yield* new BuildListError({ message: `wago.tools lists no builds for ${product}` });
  }
  return { version: latest.version, created: latest.created_at };
});
