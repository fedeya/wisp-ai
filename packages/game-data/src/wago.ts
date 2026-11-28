// @effect-migrated
import { Context, Effect, FileSystem, Layer, Option, Path, Schedule, Schema, Stream } from 'effect';
import { Csv } from 'effect/encoding';
import { HttpClient, HttpClientRequest } from 'effect/http';
import type { HttpClientResponse } from 'effect/http';

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

// The columns a dataset reads from a table, as a struct decoded from the CSV's
// string cells (Schema.Int or Schema.Finite for numbers, Schema.String for
// text). It names only those columns, so the others may change freely.
export type RowSchema = Schema.ConstraintDecoder<unknown>;

/** Where datasets read the DB2 tables of one game build. */
export class GameTables extends Context.Service<
  GameTables,
  {
    readonly read: <S extends RowSchema>(
      name: string,
      row: S,
      locale?: Locale,
    ) => Effect.Effect<readonly S['Type'][], TableReadError>;
  }
>()('@wisp/game-data/GameTables') {}

// Decodes a wago.tools DB2 CSV export: a header row naming the columns, then
// one record per line, cells quoted when they hold commas, quotes or line
// breaks. A leading byte order mark is stripped and blank lines are skipped; a
// stray quote, an unterminated one or a record wider or narrower than the
// header fails, and so does a cell row cannot decode, such as an empty or
// non-numeric cell in a number column.
export const decodeTable = <S extends RowSchema>(text: string, row: S) =>
  Stream.make(text).pipe(
    Stream.pipeThroughChannel(
      Csv.decodeSchemaString(row)({ headers: true, ignoreEmptyLines: true }),
    ),
    Stream.runCollect,
  );

const tableFailed = (what: string) => (cause: Csv.CsvError | Schema.SchemaError) =>
  new TableReadError({
    message:
      cause._tag === 'CsvError'
        ? `${what}: line ${cause.line}: ${cause.message}`
        : `${what}: ${cause.message}`,
  });

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

      const what = (name: string, locale: Locale) =>
        `wago.tools ${name} (${locale}) for build ${build}`;

      const download = Effect.fn('GameTables.download')(function* (
        name: string,
        locale: Locale,
        file: string,
      ) {
        const failed = (cause: { readonly message: string }) =>
          new TableReadError({ message: `${what(name, locale)}: ${cause.message}` });
        const query = new URLSearchParams({ build });
        if (locale !== 'enUS') {
          query.set('locale', locale);
        }
        const response = yield* client
          .get(`${BASE}/db2/${encodeURIComponent(name)}/csv?${query}`)
          .pipe(Effect.mapError(failed));
        if (!isOk(response)) {
          return yield* new TableReadError({
            message: `${what(name, locale)}: HTTP ${response.status}`,
          });
        }
        const text = yield* response.text.pipe(Effect.mapError(failed));
        yield* fs
          .makeDirectory(path.dirname(file), { recursive: true })
          .pipe(Effect.mapError(failed));
        yield* fs.writeFileString(file, text).pipe(Effect.mapError(failed));
        return text;
      });

      const read = Effect.fn('GameTables.read')(function* <S extends RowSchema>(
        name: string,
        row: S,
        locale: Locale = 'enUS',
      ) {
        const file = path.join(cacheDir, build, locale, `${name}.csv`);
        // A missing or unreadable cache entry is downloaded again; one that
        // does not decode fails, and --refresh replaces it.
        const cached = refresh
          ? Option.none<string>()
          : yield* fs.readFileString(file).pipe(Effect.option);
        const text = Option.isSome(cached) ? cached.value : yield* download(name, locale, file);
        return yield* decodeTable(text, row).pipe(Effect.mapError(tableFailed(what(name, locale))));
      });

      return GameTables.of({ read });
    }),
  );

// Tables given inline as CSV text, for tests; a locale other than enUS reads
// "<name>:<locale>".
export const layerMemory = (tables: Record<string, string>) =>
  Layer.succeed(
    GameTables,
    GameTables.of({
      read: Effect.fn('GameTables.read')(function* <S extends RowSchema>(
        name: string,
        row: S,
        locale: Locale = 'enUS',
      ) {
        const key = locale === 'enUS' ? name : `${name}:${locale}`;
        const text = tables[key];
        if (text === undefined) {
          return yield* new TableReadError({ message: `Missing table ${key}` });
        }
        return yield* decodeTable(text, row).pipe(Effect.mapError(tableFailed(`Table ${key}`)));
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
