import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { and, count, eq, sql } from 'drizzle-orm';
import { Context, Effect, FiberHandle, Layer, Schema, Semaphore } from 'effect';
import { z } from 'zod';
import { chatSchema, type Chat } from './chat.ts';
import { isEmptyDraft } from './sessions.ts';
import { cancelRunningCalls } from './chat-lifecycle.ts';
import { planSave } from './chat-diff.ts';
import { writeMigrationBackup } from '@wisp/db/private-file';
import { CorruptRecord, DatabaseFailure, sqlFailures, type SqlFailure } from '@wisp/db/repository';
import { SqlDatabase, type SqlExecutor } from '@wisp/db/sql-database';
import {
  agentSessions,
  chats as chatTable,
  messages as messageTable,
  metadata,
  chatInstanceState,
} from '@wisp/db/schema';
import {
  encodeChat,
  decodeChat,
  sameRow,
  type StoredChat,
  type MessageRow,
  type MessageIdentities,
} from './chat-record.ts';

/** Another process saved a chat since this one read it; saving would overwrite that. */
export class ChatConflict extends Schema.TaggedError<ChatConflict>()('ChatConflict', {
  message: Schema.String,
}) {}

/** The pre-SQLite `chats.json` cannot be imported as it is; it stays untouched. */
export class LegacyHistoryRejected extends Schema.TaggedError<LegacyHistoryRejected>()(
  'LegacyHistoryRejected',
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

/** The store was used out of order, such as saving before a successful load. */
export class ChatStoreMisuse extends Schema.TaggedError<ChatStoreMisuse>()('ChatStoreMisuse', {
  message: Schema.String,
}) {}

type LoadReason = LegacyHistoryRejected | ChatStoreMisuse | DatabaseFailure | CorruptRecord;

/** Loading failed without changing anything; `cause` says why. */
export class ChatLoadFailed extends Schema.TaggedError<ChatLoadFailed>()('ChatLoadFailed', {
  cause: Schema.Union([LegacyHistoryRejected, ChatStoreMisuse, DatabaseFailure, CorruptRecord]),
}) {
  override get message() {
    return 'Cannot load conversations; the original history was preserved. ' + this.cause.message;
  }
}

export class ChatStoreError extends Schema.TaggedError<ChatStoreError>()('ChatStoreError', {
  reason: Schema.Union([ChatLoadFailed, ChatConflict, ChatStoreMisuse, DatabaseFailure]),
}) {
  override get message() {
    return this.reason.message;
  }
}

export interface ChatStoreOptions {
  /** Called when a scheduled save fails; nobody awaits those. */
  onError: (error: ChatStoreError) => void;
  legacyFile?: string;
  instanceId?: string;
  /** An installation import copies this instance's private engine state. */
  inheritInstanceId?: string;
}

/**
 * The conversations of one bridge instance, saved as normalized rows. Saves
 * write only what changed since the last save, and a revision on each chat
 * stops a save from overwriting a copy another process changed.
 */
export class ChatStore extends Context.Service<
  ChatStore,
  {
    readonly instanceId: string;
    readonly load: () => Effect.Effect<Chat[], ChatStoreError>;
    readonly flush: (chats: Chat[]) => Effect.Effect<void, ChatStoreError>;
    /** Saves a second after the first change since the last save. */
    readonly schedule: (snapshot: () => Chat[]) => void;
  }
>()('@wisp/server/ChatStore') {}

export function conversationInstanceId(runtime: string) {
  const resolved = path.resolve(runtime);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

const SAVE_DELAY = '1 second';

const conflict = (what = 'Conversation') =>
  new ChatConflict({ message: what + ' changed in another process. Restart Wisp before saving.' });

const countRows = (db: SqlExecutor, table: typeof chatTable | typeof messageTable) =>
  db
    .select({ n: count() })
    .from(table)
    .get()
    .pipe(Effect.map((row) => Number(row?.n ?? 0)));

const isInitialized = (db: SqlExecutor) =>
  db.select().from(metadata).where(eq(metadata.key, 'initialized')).get().pipe(Effect.map(Boolean));

const insertChat = Effect.fnUntraced(function* (db: SqlExecutor, chat: StoredChat) {
  yield* db.insert(chatTable).values(chat.row).run();
  for (const message of chat.messages) {
    yield* db.insert(messageTable).values(message).run();
  }
  if (chat.state) {
    yield* db.insert(chatInstanceState).values(chat.state).run();
  }
});

const saveMessages = Effect.fnUntraced(function* (
  db: SqlExecutor,
  chat: StoredChat,
  old: StoredChat,
) {
  const retained = new Set(chat.messages.map((message) => message.id));
  for (const message of old.messages) {
    if (!retained.has(message.id)) {
      yield* db.delete(messageTable).where(eq(messageTable.id, message.id)).run();
    }
  }
  const previous = new Map(old.messages.map((message) => [message.id, message]));
  const moved = chat.messages.some((message) => {
    const before = previous.get(message.id);
    return before !== undefined && before.position !== message.position;
  });
  if (moved) {
    // Positions are unique per chat: park every row past both lengths first.
    yield* db
      .update(messageTable)
      .set({
        position: sql`${messageTable.position} + ${Math.max(old.messages.length, chat.messages.length) + 1}`,
      })
      .where(eq(messageTable.chatId, chat.row.id))
      .run();
  }
  for (const message of chat.messages) {
    const before = previous.get(message.id);
    if (!before) {
      yield* db.insert(messageTable).values(message).run();
    } else if (moved || !sameRow(message, before)) {
      yield* db
        .update(messageTable)
        .set(message)
        .where(and(eq(messageTable.id, message.id), eq(messageTable.chatId, chat.row.id)))
        .run();
    }
  }
});

/** A chat restored after the previous bridge stopped: its turn and running calls ended with it. */
const restore = (chat: Chat, hadPrivateState: boolean): Chat => {
  const restored: Chat = {
    ...chat,
    messages: chat.messages.map((message) =>
      message.streaming &&
      (message.rawReply !== undefined || message.replyFormat === 'text') &&
      hadPrivateState
        ? { ...message, streaming: false }
        : message,
    ),
    lastActivityAt: chat.lastActivityAt ?? chat.lastUsedAt ?? 0,
    status: chat.status === 'working' && hadPrivateState ? 'interrupted' : chat.status,
    usage: chat.usage ? { ...chat.usage, compacting: false } : undefined,
  };
  if (restored.status === 'interrupted') {
    cancelRunningCalls(restored);
  }
  return restored;
};

const readLegacy = (file: string) =>
  Effect.tryPromise({
    try: async () => {
      try {
        return await readFile(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    },
    catch: (cause) =>
      new LegacyHistoryRejected({ message: 'Cannot read the legacy conversations.', cause }),
  });

const parseLegacy = (original: Buffer | undefined) =>
  Effect.try({
    try: () => {
      const chats: Chat[] = original ? JSON.parse(original.toString('utf8')) : [];
      z.array(chatSchema).parse(chats);
      return chats;
    },
    catch: (cause) =>
      new LegacyHistoryRejected({ message: 'The legacy conversations are not valid.', cause }),
  });

export const make = Effect.fnUntraced(function* (options: ChatStoreOptions) {
  const { file, db } = yield* SqlDatabase;
  const legacyFile = options.legacyFile ?? path.join(path.dirname(file), 'chats.json');
  const instanceId = options.instanceId ?? conversationInstanceId(path.dirname(file));
  const saving = yield* Semaphore.make(1);
  const runScheduled = yield* FiberHandle.makeRuntime<never>();
  const identities: MessageIdentities = new WeakMap();
  let saved = new Map<string, StoredChat>();
  let loaded = false;
  let writable = false;

  const serialize = (chat: Chat, position: number) =>
    encodeChat(chat, position, instanceId, identities, saved.get(chat.id));

  const importLegacy = Effect.fnUntraced(function* () {
    if (yield* isInitialized(db)) {
      return;
    }
    const original = yield* readLegacy(legacyFile);
    const chats = yield* parseLegacy(original);
    if (new Set(chats.map((chat) => chat.id)).size !== chats.length) {
      return yield* new LegacyHistoryRejected({
        message: 'Duplicate conversation IDs in legacy history.',
      });
    }
    const digest = original && createHash('sha256').update(original).digest('hex');
    if (original) {
      const backup = path.join(path.dirname(legacyFile), `chats.pre-sqlite-${digest}.json`);
      yield* Effect.tryPromise({
        try: () => writeMigrationBackup(backup, original),
        catch: (cause) =>
          new LegacyHistoryRejected({ message: 'Cannot back up the legacy conversations.', cause }),
      });
    }
    yield* db.transaction((tx) =>
      Effect.gen(function* () {
        if (yield* isInitialized(tx)) {
          return;
        }
        if ((yield* countRows(tx, chatTable)) !== 0) {
          return yield* new LegacyHistoryRejected({
            message: 'Uninitialized conversation database already contains data.',
          });
        }
        for (const [index, chat] of chats.entries()) {
          yield* insertChat(tx, serialize(chat, index));
        }
        const expected = chats.reduce((sum, chat) => sum + chat.messages.length, 0);
        if ((yield* countRows(tx, messageTable)) !== expected) {
          return yield* new LegacyHistoryRejected({
            message: 'Imported conversation message count does not match.',
          });
        }
        if (digest) {
          yield* tx.insert(metadata).values({ key: 'legacy_sha256', value: digest }).run();
        }
        yield* tx.insert(metadata).values({ key: 'initialized', value: '1' }).run();
      }),
    );
  });

  const inheritPrivateState = (from: string) =>
    db.transaction((tx) =>
      Effect.gen(function* () {
        for (const row of yield* tx
          .select()
          .from(chatInstanceState)
          .where(eq(chatInstanceState.instanceId, from))
          .all()) {
          yield* tx
            .insert(chatInstanceState)
            .values({ ...row, instanceId })
            .onConflictDoNothing()
            .run();
        }
      }),
    );

  // One transaction: the content and the optimistic revisions describe the
  // same moment, even when another process saves while this one reads.
  const readChats = db.transaction((tx) =>
    Effect.gen(function* () {
      const messages = new Map<string, MessageRow[]>();
      for (const row of yield* tx
        .select()
        .from(messageTable)
        .orderBy(messageTable.chatId, messageTable.position)
        .all()) {
        const values = messages.get(row.chatId) ?? [];
        if (row.position !== values.length) {
          return yield* new CorruptRecord({
            table: 'message',
            cause: Error('Conversation messages are not contiguous.'),
          });
        }
        values.push(row);
        messages.set(row.chatId, values);
      }
      const states = new Map(
        (yield* tx
          .select()
          .from(chatInstanceState)
          .where(eq(chatInstanceState.instanceId, instanceId))
          .all()).map((row) => [row.chatId, row]),
      );
      const rows = yield* tx
        .select()
        .from(chatTable)
        .orderBy(chatTable.sortIndex, chatTable.id)
        .all();
      const records = rows.map((row): StoredChat => ({
        row,
        messages: messages.get(row.id) ?? [],
        state: states.get(row.id),
      }));
      const chats = yield* Effect.forEach(records, (record) =>
        Effect.try({
          try: () => {
            const chat = decodeChat(record, identities);
            chatSchema.parse(chat);
            return chat;
          },
          catch: (cause) => new CorruptRecord({ table: 'conversation', cause }),
        }),
      );
      return { records, chats };
    }),
  );

  const load = Effect.fn('ChatStore.load')(
    function* () {
      if (loaded) {
        return yield* new ChatStoreMisuse({ message: 'Conversation store is already open.' });
      }
      loaded = true;
      if (options.inheritInstanceId) {
        yield* inheritPrivateState(options.inheritInstanceId);
      }
      yield* importLegacy();
      const { records, chats } = yield* readChats;
      saved = new Map(records.map((record) => [record.row.id, record]));
      writable = true;
      return chats
        .filter((chat) => !isEmptyDraft(chat))
        .map((chat) => restore(chat, saved.get(chat.id)?.state !== undefined));
    },
    (self) => sqlFailures<Chat[], LoadReason | SqlFailure, never>(self),
    Effect.tapError(() =>
      Effect.sync(() => {
        loaded = false;
      }),
    ),
    Effect.mapError((cause) => new ChatStoreError({ reason: new ChatLoadFailed({ cause }) })),
  );

  const save = Effect.fnUntraced(function* (snapshot: StoredChat[]) {
    const { deleted, changed } = planSave(saved, snapshot);
    if (!changed.length && !deleted.length) {
      return;
    }
    yield* db.transaction((tx) =>
      Effect.gen(function* () {
        for (const chat of deleted) {
          const result = yield* tx
            .delete(chatTable)
            .where(and(eq(chatTable.id, chat.row.id), eq(chatTable.revision, chat.row.revision)))
            .run();
          if (result.changes !== 1) {
            return yield* conflict();
          }
          // Sessions have no foreign key to their chat (they start before it is saved).
          yield* tx.delete(agentSessions).where(eq(agentSessions.chatId, chat.row.id)).run();
        }
        for (const { chat, old, history } of changed) {
          if (!old) {
            yield* insertChat(tx, chat);
            continue;
          }
          if (history) {
            chat.row.revision++;
            const result = yield* tx
              .update(chatTable)
              .set(chat.row)
              .where(and(eq(chatTable.id, chat.row.id), eq(chatTable.revision, old.row.revision)))
              .run();
            if (result.changes !== 1) {
              return yield* conflict();
            }
            yield* saveMessages(tx, chat, old);
          } else {
            const current = yield* tx
              .select({ revision: chatTable.revision })
              .from(chatTable)
              .where(eq(chatTable.id, chat.row.id))
              .get();
            if (current?.revision !== old.row.revision) {
              return yield* conflict();
            }
          }
          if (!chat.state) {
            continue;
          }
          chat.state.historyRevision = chat.row.revision;
          if (!old.state) {
            yield* tx.insert(chatInstanceState).values(chat.state).run();
            continue;
          }
          chat.state.revision++;
          const result = yield* tx
            .update(chatInstanceState)
            .set(chat.state)
            .where(
              and(
                eq(chatInstanceState.chatId, chat.row.id),
                eq(chatInstanceState.instanceId, instanceId),
                eq(chatInstanceState.revision, old.state.revision),
              ),
            )
            .run();
          if (result.changes !== 1) {
            return yield* conflict('Conversation session');
          }
        }
      }),
    );
    saved = new Map(snapshot.map((chat) => [chat.row.id, chat]));
  });

  const flush = Effect.fn('ChatStore.flush')(
    function* (chats: Chat[]) {
      if (!writable) {
        return yield* new ChatStoreMisuse({
          message: 'Load conversations successfully before saving them.',
        });
      }
      const snapshot = chats
        .filter((chat) => !isEmptyDraft(chat))
        .map((chat, index) => serialize(chat, index));
      if (new Set(snapshot.map((chat) => chat.row.id)).size !== snapshot.length) {
        return yield* new ChatStoreMisuse({
          message: 'Duplicate conversation IDs cannot be saved.',
        });
      }
      yield* saving.withPermit(save(snapshot));
    },
    (self) => sqlFailures<void, ChatConflict | ChatStoreMisuse | SqlFailure, never>(self),
    Effect.mapError((reason) => new ChatStoreError({ reason })),
  );

  const schedule = (snapshot: () => Chat[]) => {
    if (!writable) return;
    runScheduled(
      Effect.sleep(SAVE_DELAY).pipe(
        Effect.andThen(Effect.suspend(() => flush(snapshot()))),
        Effect.catch((error) => Effect.sync(() => options.onError(error))),
      ),
      { onlyIfMissing: true },
    );
  };

  // Closing stops the save that is waiting and lets the one in progress commit.
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      writable = false;
    }).pipe(Effect.andThen(saving.withPermit(Effect.void))),
  );

  return ChatStore.of({ instanceId, load, flush, schedule });
});

export const layer = (options: ChatStoreOptions) => Layer.effect(ChatStore, make(options));
