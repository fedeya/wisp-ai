// @effect-migrated
import * as SqliteClient from '@effect/sql-sqlite-node/SqliteClient';
import { DATABASE_NAME } from '@wisp/db/application-file';
import { Effect, FileSystem, Option, Path, Schema } from 'effect';
import { Digest } from 'effect/crypto';
import { HttpClient, HttpClientRequest } from 'effect/http';
import * as Reactivity from 'effect/reactivity/Reactivity';
import { copySnapshot, prepareDatabase } from './desktop-storage.ts';

/** The import stopped; the message says why, and nothing was overwritten. */
export class DesktopMigrationError extends Schema.TaggedError<DesktopMigrationError>()(
  'DesktopMigrationError',
  { message: Schema.String },
) {}

/** Like Node's `readFile(file, 'utf8')`: a byte order mark stays in the text. */
const utf8 = new TextDecoder('utf-8', { ignoreBOM: true });

/** A file's text, or none when it does not exist. */
const readText = Effect.fnUntraced(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFile(file).pipe(
    Effect.map((bytes) => Option.some(utf8.decode(bytes))),
    Effect.catchReason('PlatformError', 'NotFound', () => Effect.succeedNone),
  );
});

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Json));

/** How the previous Desktop reaches its running bridge, from `runtime/desktop.json`. */
const DesktopIdentity = Schema.fromJsonString(
  Schema.Struct({
    port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })),
    token: Schema.RedactedFromValue(Schema.String),
  }),
);

/** The previous installation's settings; `wow` marks a folder as one. */
const PreviousConfig = Schema.Struct({
  wow: Schema.String,
  model: Schema.optionalKey(Schema.Json),
});

/** The settings the import writes, as JSON indented by two spaces. */
const ImportedConfig = Schema.fromJsonString(
  Schema.Struct({ wow: Schema.String, model: Schema.Json }),
  { space: 2 },
);

const LegacyChats = Schema.Array(Schema.Json);
const LegacyChatsJson = Schema.fromJsonString(LegacyChats, { space: 2 });

/** The runtime files that carry over; everything else there belongs to that installation. */
const importedRuntimeFiles = [
  'chats.json',
  'memory',
  'mcp.json',
  'panels.json',
  'routines.json',
  'suggestions.json',
  'capabilities.json',
  'advice-history.json',
  'chatgpt-host.json',
];

const SavedData = Schema.Array(Schema.Struct({ present: Schema.Finite }));

/** Asks a running bridge of the previous installation to stop and waits until it has. */
const stopPreviousBridge = Effect.fn('DesktopMigration.stopPreviousBridge')(function* (
  source: string,
) {
  const path = yield* Path.Path;
  const client = yield* HttpClient.HttpClient;
  const text = yield* readText(path.join(source, 'runtime/desktop.json'));
  if (Option.isNone(text)) {
    return;
  }
  const identity = yield* Schema.decodeEffect(DesktopIdentity)(text.value).pipe(Effect.option);
  if (Option.isNone(identity)) {
    return;
  }
  const { port, token } = identity.value;
  const origin = 'http://127.0.0.1:' + port;
  const stop = HttpClientRequest.post(origin + '/stop').pipe(
    HttpClientRequest.bearerToken(token),
    HttpClientRequest.bodyText('{}', 'application/json'),
  );
  const response = yield* client.execute(stop).pipe(
    Effect.timeoutOrElse({
      duration: '15 seconds',
      // The message fetch gave for its own timeout.
      orElse: () =>
        Effect.fail(
          new DesktopMigrationError({ message: 'The operation was aborted due to timeout' }),
        ),
    }),
    Effect.asSome,
    // Nothing listens on the port: the previous bridge is not running.
    Effect.catchReason('HttpClientError', 'TransportError', (reason, error) =>
      reason.cause instanceof TypeError && /fetch failed/i.test(reason.cause.message)
        ? Effect.succeedNone
        : Effect.fail(error),
    ),
  );
  if (Option.isNone(response)) {
    return;
  }
  if (response.value.status < 200 || response.value.status > 299) {
    return yield* new DesktopMigrationError({
      message:
        'Close the previous Wisp application after its active reply finishes, then import again.',
    });
  }
  const status = HttpClientRequest.get(origin + '/status').pipe(
    HttpClientRequest.bearerToken(token),
  );
  for (let attempt = 0; attempt < 50; attempt++) {
    yield* Effect.sleep('200 millis');
    const answered = yield* client.execute(status).pipe(
      Effect.timeout('1 second'),
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (!answered) {
      return;
    }
  }
  return yield* new DesktopMigrationError({
    message: 'The previous Wisp bridge is still stopping. Try again in a moment.',
  });
});

/** Whether the database has chats, routines, routine runs, panels or memory. */
const hasSavedData = Effect.fnUntraced(function* (file: string) {
  const sql = yield* SqliteClient.make({ filename: file, readonly: true }).pipe(
    Effect.provideService(Reactivity.Reactivity, yield* Reactivity.make),
  );
  const rows = yield* sql`
      SELECT EXISTS (
        SELECT 1 FROM chats
        UNION ALL SELECT 1 FROM routines
        UNION ALL SELECT 1 FROM routine_runs
        UNION ALL SELECT 1 FROM panels
        UNION ALL SELECT 1 FROM memory_entries
      ) AS present
    `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(SavedData)));
  return rows.some(({ present }) => present !== 0);
}, Effect.scoped);

/**
 * Starting the desktop creates a database and a ChatGPT host file even before
 * the first setup. Removes them when nothing was saved yet, so the legacy JSON
 * can be imported on a clean schema; refuses when something was.
 */
const clearEmptyWorkspace = Effect.fn('DesktopMigration.clearEmptyWorkspace')(function* (
  destination: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runtime = path.join(destination, 'runtime');
  const existing = path.join(runtime, DATABASE_NAME);
  if (!(yield* fs.exists(existing))) {
    return;
  }
  const secretFiles = yield* fs
    .readDirectory(path.join(destination, 'secrets'))
    .pipe(Effect.catchReason('PlatformError', 'NotFound', () => Effect.succeed([])));
  if ((yield* hasSavedData(existing)) || secretFiles.length > 0) {
    return yield* new DesktopMigrationError({
      message: 'This installation already has saved data; no data was overwritten.',
    });
  }
  yield* fs.remove(existing);
  yield* fs.remove(path.join(runtime, 'chatgpt-host.json'), { force: true });
});

/** Copies a file or folder that is not at `to` yet; one already there fails the import. */
const copyNew = Effect.fnUntraced(function* (from: string, to: string) {
  const fs = yield* FileSystem.FileSystem;
  if (yield* fs.exists(to)) {
    return yield* new DesktopMigrationError({ message: `Target already exists: ${to}` });
  }
  yield* fs.copy(from, to);
});

const isJsonArray = Schema.is(Schema.Array(Schema.Json));

/** Detaches a legacy conversation from its model history; other entries stay as they are. */
const detachChat = (chat: Schema.Json): Schema.Json => {
  if (typeof chat !== 'object' || chat === null || isJsonArray(chat)) {
    return chat;
  }
  const { eveId: _eveId, agentSession: _agentSession, ...detached } = chat;
  return detached.status === 'working' ? { ...detached, status: 'interrupted' } : detached;
};

/** Model histories start over; the visible conversations in `chats.json` carry over. */
const detachLegacyChats = Effect.fn('DesktopMigration.detachLegacyChats')(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* readText(file);
  if (Option.isNone(text)) {
    return;
  }
  const chats = yield* decodeJson(text.value).pipe(
    Effect.flatMap((json) =>
      Schema.decodeUnknownEffect(LegacyChats)(json).pipe(
        Effect.mapError(
          () => new DesktopMigrationError({ message: 'Invalid conversation history.' }),
        ),
      ),
    ),
  );
  yield* fs.writeFileString(
    file,
    yield* Schema.encodeEffect(LegacyChatsJson)(chats.map(detachChat)),
  );
});

/** Copies the previous installation's protected credentials, kept by a hash of its folder. */
const importSecrets = Effect.fn('DesktopMigration.importSecrets')(function* (
  source: string,
  destination: string,
  localAppData: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const digest = yield* Digest.Digest;
  const hash = yield* digest.digestHex(Digest.sha256, new TextEncoder().encode(source));
  const secrets = path.join(localAppData, 'WispAI', 'Secrets', hash);
  const entries = yield* fs
    .readDirectory(secrets)
    .pipe(Effect.catchReason('PlatformError', 'NotFound', () => Effect.succeed([])));
  yield* fs.makeDirectory(path.join(destination, 'secrets'), { recursive: true });
  for (const name of entries.filter((name) => /^[a-f0-9]{64}\.bin$/.test(name))) {
    yield* copyNew(path.join(secrets, name), path.join(destination, 'secrets', name));
  }
});

export interface DesktopImport {
  /** The previous installation's folder. */
  readonly source: string;
  /** This installation's data folder. */
  readonly destination: string;
  /** Where Windows keeps the previous installation's protected credentials; none skips them. */
  readonly localAppData?: string | undefined;
}

/**
 * Imports a previous Wisp installation into an unconfigured data folder: its
 * conversations, memory, routines, panels, settings and protected credentials.
 * The previous installation is left as it was, and existing data is never
 * overwritten.
 */
export const migrateDesktop = Effect.fn('DesktopMigration.migrate')(function* ({
  source: sourceInput,
  destination: destinationInput,
  localAppData,
}: DesktopImport) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const source = path.resolve(sourceInput);
  const destination = path.resolve(destinationInput);
  if (source === destination) {
    return yield* new DesktopMigrationError({
      message: 'Choose the previous Wisp installation folder.',
    });
  }
  if (yield* fs.exists(path.join(destination, 'config.local.json'))) {
    return yield* new DesktopMigrationError({
      message: 'This installation is already configured; no data was overwritten.',
    });
  }
  const configText = utf8.decode(yield* fs.readFile(path.join(source, 'config.local.json')));
  const config = yield* decodeJson(configText).pipe(
    Effect.flatMap((json) =>
      Schema.decodeUnknownEffect(PreviousConfig)(json).pipe(
        Effect.mapError(
          () =>
            new DesktopMigrationError({
              message: 'This folder does not contain a Wisp installation.',
            }),
        ),
      ),
    ),
  );
  yield* stopPreviousBridge(source);
  yield* fs.makeDirectory(path.join(destination, 'runtime'), { recursive: true });
  const databaseFile = path.join(destination, 'runtime', DATABASE_NAME);
  const sourceDatabase = path.join(source, 'runtime', DATABASE_NAME);
  const copyDatabase = yield* fs.exists(sourceDatabase);
  yield* clearEmptyWorkspace(destination);
  if (copyDatabase) {
    yield* copySnapshot(sourceDatabase, databaseFile);
  }
  for (const name of importedRuntimeFiles) {
    const from = path.join(source, 'runtime', name);
    if (yield* fs.exists(from)) {
      yield* copyNew(from, path.join(destination, 'runtime', name));
    }
  }
  if (!copyDatabase) {
    yield* detachLegacyChats(path.join(destination, 'runtime/chats.json'));
  }
  // The copied database is authoritative when both formats are present.
  yield* prepareDatabase({
    file: databaseFile,
    copiedFrom: copyDatabase ? path.join(source, 'runtime') : undefined,
  });
  if (localAppData) {
    yield* importSecrets(source, destination, localAppData);
  }
  // Commit configuration last: a failed import never starts a partially migrated account.
  yield* fs.writeFileString(
    path.join(destination, 'config.local.json'),
    yield* Schema.encodeEffect(ImportedConfig)({ wow: config.wow, model: config.model || '' }),
    { flag: 'wx' },
  );
});
