import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { and, count, eq, sql } from 'drizzle-orm';
import { Effect, Schema, Semaphore } from 'effect';
import { z } from 'zod';
import { chatSchema, type Chat } from './chat.ts';
import { isEmptyDraft } from './sessions.ts';
import { cancelRunningCalls } from './chat-lifecycle.ts';
import { writeMigrationBackup } from '@wisp/db/private-file';
import type { SqlDatabase, SqlExecutor } from '@wisp/db/sql-database';
import * as Sql from '@wisp/db/sql-database';
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

/** The saved conversations could not be read, or a save found them changed elsewhere. */
export class ChatStoreError extends Schema.TaggedError<ChatStoreError>()('ChatStoreError', {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface ChatStoreOptions {
  /** Called when a scheduled save fails; nobody awaits those. */
  onError: (error: unknown) => void;
  legacyFile?: string;
  instanceId?: string;
  inheritInstanceId?: string;
}

export function conversationInstanceId(runtime: string) {
  const resolved = path.resolve(runtime);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

const changedElsewhere = (what = 'Conversation') =>
  new ChatStoreError({
    message: what + ' changed in another process. Restart Wisp before saving.',
  });

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
  const retained = new Set(chat.messages.map((m) => m.id));
  for (const message of old.messages) {
    if (!retained.has(message.id)) {
      yield* db.delete(messageTable).where(eq(messageTable.id, message.id)).run();
    }
  }
  const previous = new Map(old.messages.map((m) => [m.id, m]));
  const moved = chat.messages.some((message) => {
    const before = previous.get(message.id);
    return before !== undefined && before.position !== message.position;
  });
  if (moved) {
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

/**
 * The conversations of one bridge instance, saved as normalized rows. Saves
 * write only what changed since the last save, and a revision on each chat
 * stops a save from overwriting a copy another process changed.
 */
export const makeChatStore = Effect.fnUntraced(function* (
  { file, db }: SqlDatabase['Service'],
  options: ChatStoreOptions,
) {
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const legacyFile = options.legacyFile ?? path.join(path.dirname(file), 'chats.json');
  const instanceId = options.instanceId ?? conversationInstanceId(path.dirname(file));
  if (!instanceId) {
    return yield* new ChatStoreError({ message: 'Choose a conversation instance identity.' });
  }
  const saving = yield* Semaphore.make(1);
  let saved = new Map<string, StoredChat>();
  const identities: MessageIdentities = new WeakMap();
  let loaded = false;
  let writable = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const serialize = (chat: Chat, position: number) =>
    encodeChat(chat, position, instanceId, identities, saved.get(chat.id));

  const importLegacy = Effect.fnUntraced(function* () {
    if (yield* isInitialized(db)) {
      return;
    }
    const original = yield* Effect.tryPromise({
      try: async () => {
        try {
          return await readFile(legacyFile);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
          throw error;
        }
      },
      catch: (cause) => new ChatStoreError({ message: 'Cannot read legacy conversations.', cause }),
    });
    const chats: Chat[] = original ? JSON.parse(original.toString('utf8')) : [];
    z.array(chatSchema).parse(chats);
    if (new Set(chats.map((chat) => chat.id)).size !== chats.length) {
      return yield* new ChatStoreError({
        message: 'Duplicate conversation IDs in legacy history.',
      });
    }
    const digest = original && createHash('sha256').update(original).digest('hex');
    if (original) {
      const backup = path.join(path.dirname(legacyFile), `chats.pre-sqlite-${digest}.json`);
      yield* Effect.tryPromise({
        try: () => writeMigrationBackup(backup, original),
        catch: (cause) =>
          new ChatStoreError({ message: 'Cannot back up legacy conversations.', cause }),
      });
    }
    yield* db.transaction((tx) =>
      Effect.gen(function* () {
        if (yield* isInitialized(tx)) {
          return;
        }
        if ((yield* countRows(tx, chatTable)) !== 0) {
          return yield* new ChatStoreError({
            message: 'Uninitialized conversation database already contains data.',
          });
        }
        for (const [index, chat] of chats.entries()) {
          yield* insertChat(tx, serialize(chat, index));
        }
        const expected = chats.reduce((sum, chat) => sum + chat.messages.length, 0);
        if ((yield* countRows(tx, messageTable)) !== expected) {
          return yield* new ChatStoreError({
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

  // The content and the optimistic revisions must describe one WAL snapshot,
  // even when another connection commits between these SELECT statements.
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
          return yield* new ChatStoreError({
            message: 'Conversation messages are not contiguous.',
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
      return rows.map((row) => {
        const record = { row, messages: messages.get(row.id) ?? [], state: states.get(row.id) };
        const chat = decodeChat(record, identities);
        chatSchema.parse(chat);
        saved.set(row.id, record);
        return chat;
      });
    }),
  );

  const load = Effect.fn('ChatStore.load')(
    function* () {
      if (loaded) {
        return yield* new ChatStoreError({ message: 'Conversation store is already open.' });
      }
      loaded = true;
      // Installation imports explicitly inherit private state in the copy.
      // An ordinary instance never reads another instance's engine session.
      const inherit = options.inheritInstanceId;
      if (inherit) {
        yield* db.transaction((tx) =>
          Effect.gen(function* () {
            for (const row of yield* tx
              .select()
              .from(chatInstanceState)
              .where(eq(chatInstanceState.instanceId, inherit))
              .all()) {
              yield* tx
                .insert(chatInstanceState)
                .values({ ...row, instanceId })
                .onConflictDoNothing()
                .run();
            }
          }),
        );
      }
      yield* importLegacy();
      const chats = yield* readChats;
      writable = true;
      return chats
        .filter((chat) => !isEmptyDraft(chat))
        .map((chat) => {
          const restored: Chat = {
            ...chat,
            messages: chat.messages.map((message) =>
              message.streaming &&
              (message.rawReply !== undefined || message.replyFormat === 'text') &&
              saved.get(chat.id)?.state
                ? { ...message, streaming: false }
                : message,
            ),
            lastActivityAt: chat.lastActivityAt ?? chat.lastUsedAt ?? 0,
            status:
              chat.status === 'working' && saved.get(chat.id)?.state ? 'interrupted' : chat.status,
            usage: chat.usage ? { ...chat.usage, compacting: false } : undefined,
          };
          // The turn died with the previous bridge, and so did its calls.
          if (restored.status === 'interrupted') {
            cancelRunningCalls(restored);
          }
          return restored;
        });
    },
    Effect.catchDefect((cause) =>
      Effect.fail(new ChatStoreError({ message: errorText(cause), cause })),
    ),
    Effect.tapError(() =>
      Effect.sync(() => {
        loaded = false;
        saved.clear();
      }),
    ),
    Effect.mapError(
      (cause) =>
        new ChatStoreError({
          message: 'Cannot load conversations; the original history was preserved.',
          cause,
        }),
    ),
  );

  const save = Effect.fnUntraced(function* (snapshot: StoredChat[]) {
    const next = new Map(snapshot.map((chat) => [chat.row.id, chat]));
    // Revisions are assigned when the queued snapshot is committed, not when
    // it is captured: earlier saves may still be queued for this same chat.
    const changed = snapshot
      .map((chat) => {
        const old = saved.get(chat.row.id);
        chat.row.revision = old?.row.revision ?? 0;
        if (chat.state) {
          chat.state.revision = old?.state?.revision ?? 0;
          chat.state.historyRevision = chat.row.revision;
        }
        const history =
          !old ||
          !sameRow(chat.row, old.row) ||
          chat.messages.length !== old.messages.length ||
          chat.messages.some((m, i) => !old.messages[i] || !sameRow(m, old.messages[i]));
        const state = !old?.state || !chat.state || !sameRow(chat.state, old.state);
        return { chat, old, history, state };
      })
      .filter(({ history, state }) => history || state);
    const deleted = [...saved.values()].filter((chat) => !next.has(chat.row.id));
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
            return yield* changedElsewhere();
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
              return yield* changedElsewhere();
            }
            yield* saveMessages(tx, chat, old);
          } else {
            const current = yield* tx
              .select({ revision: chatTable.revision })
              .from(chatTable)
              .where(eq(chatTable.id, chat.row.id))
              .get();
            if (current?.revision !== old.row.revision) {
              return yield* changedElsewhere();
            }
          }
          if (chat.state) {
            chat.state.historyRevision = chat.row.revision;
            if (old.state) {
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
                return yield* changedElsewhere('Conversation session');
              }
            } else {
              yield* tx.insert(chatInstanceState).values(chat.state).run();
            }
          }
        }
      }),
    );
    saved = next;
  });

  const flush = Effect.fn('ChatStore.flush')(function* (chats: Chat[]) {
    if (!writable) {
      return yield* new ChatStoreError({
        message: 'Load conversations successfully before saving them.',
      });
    }
    clearTimeout(timer);
    timer = undefined;
    const snapshot = chats
      .filter((chat) => !isEmptyDraft(chat))
      .map((chat, index) => serialize(chat, index));
    if (new Set(snapshot.map((chat) => chat.row.id)).size !== snapshot.length) {
      return yield* new ChatStoreError({ message: 'Duplicate conversation IDs cannot be saved.' });
    }
    yield* saving.withPermit(save(snapshot));
  });

  /** Saves a second after the first change, coalescing the changes in between. */
  const schedule = (snapshot: () => Chat[]) => {
    if (!timer && writable) {
      timer = setTimeout(() => {
        timer = undefined;
        runFork(
          Effect.suspend(() => flush(snapshot())).pipe(
            Effect.catch((error) => Effect.sync(() => options.onError(error))),
          ),
        );
      }, 1000);
    }
  };

  /** Stops scheduled saves and waits for the one in progress. */
  const close = Effect.fn('ChatStore.close')(function* () {
    clearTimeout(timer);
    timer = undefined;
    writable = false;
    yield* saving.withPermit(Effect.void);
    saved.clear();
  });

  return { file, legacyFile, instanceId, load, flush, schedule, close };
});

export type ChatStore = Effect.Success<ReturnType<typeof makeChatStore>>;

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/**
 * A store over its own connection to `file`, for one-off tools and tests:
 * the connection closes, after any save in progress, when the scope does.
 */
export const openChatStore = Effect.fnUntraced(function* (file: string, options: ChatStoreOptions) {
  const database = yield* Sql.make(file).pipe(
    Effect.mapError(
      (cause) =>
        new ChatStoreError({
          message: 'Cannot load conversations; the original history was preserved.',
          cause,
        }),
    ),
  );
  const store = yield* makeChatStore(database, options);
  yield* Effect.addFinalizer(() => store.close());
  return store;
});
