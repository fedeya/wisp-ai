import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { and, eq, sql } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/node-sqlite';
import { z } from 'zod';
import { chatSchema, type Chat } from './chat.ts';
import { isEmptyDraft } from './sessions.ts';
import { migrateChats } from './db/migrate.ts';
import { preparePrivateDatabase } from './db/private-file.ts';
import { chats as chatTable, messages as messageTable, chatInstanceState } from './db/schema.ts';
import {
  encodeChat,
  decodeChat,
  sameRow,
  type StoredChat,
  type MessageRow,
  type MessageIdentities,
} from './db/chat-record.ts';

interface StoreOptions {
  instanceId?: string;
  inheritInstanceId?: string;
}

export function conversationInstanceId(runtime: string) {
  const resolved = path.resolve(runtime);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export class ChatStore {
  readonly file: string;
  readonly legacyFile: string;
  readonly instanceId: string;
  private options: StoreOptions;
  private onError: (error: unknown) => void;
  private db?: DatabaseSync;
  private orm?: ReturnType<typeof drizzle>;
  private queue: Promise<void> = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private saved = new Map<string, StoredChat>();
  private identities: MessageIdentities = new WeakMap();
  private writable = false;

  constructor(
    file: string,
    onError: (error: unknown) => void,
    legacyFile = path.join(path.dirname(file), 'chats.json'),
    options: StoreOptions = {},
  ) {
    this.file = file;
    this.legacyFile = legacyFile;
    this.instanceId = options.instanceId ?? conversationInstanceId(path.dirname(file));
    if (!this.instanceId || this.instanceId === '__legacy__') {
      throw Error('Choose a non-reserved conversation instance identity.');
    }
    this.options = options;
    this.onError = onError;
  }

  async load(): Promise<Chat[]> {
    if (this.db) {
      throw Error('Conversation store is already open.');
    }
    try {
      await preparePrivateDatabase(this.file);
      this.db = new DatabaseSync(this.file, { timeout: 5000 });
      const version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
      if (version > 4) {
        throw Error(`Unsupported conversation database version: ${version}`);
      }
      this.db.exec(
        'PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;',
      );
      this.orm = migrateChats(this.db);
      this.transaction(() => {
        this.orm!.update(chatInstanceState)
          .set({ instanceId: this.instanceId })
          .where(eq(chatInstanceState.instanceId, '__legacy__'))
          .run();
        // Installation imports explicitly inherit private state in the copy.
        // An ordinary instance never reads another instance's engine session.
        if (this.options.inheritInstanceId) {
          for (const row of this.orm!.select()
            .from(chatInstanceState)
            .where(eq(chatInstanceState.instanceId, this.options.inheritInstanceId))
            .all()) {
            this.orm!.insert(chatInstanceState)
              .values({ ...row, instanceId: this.instanceId })
              .onConflictDoNothing()
              .run();
          }
        }
      });
      await this.importLegacy();
      const chats = this.readChats();
      this.writable = true;
      return chats
        .filter((chat) => !isEmptyDraft(chat))
        .map((chat) => ({
          ...chat,
          lastActivityAt: chat.lastActivityAt ?? chat.lastUsedAt ?? 0,
          status:
            chat.status === 'working' && this.saved.get(chat.id)?.state
              ? 'interrupted'
              : chat.status,
          usage: chat.usage ? { ...chat.usage, compacting: false } : undefined,
        }));
    } catch (cause) {
      this.db?.close();
      this.db = undefined;
      this.orm = undefined;
      this.saved.clear();
      throw Error('Cannot load conversations; the original history was preserved.', { cause });
    }
  }

  private transaction(work: () => void) {
    const db = this.db!;
    db.exec('BEGIN IMMEDIATE');
    try {
      work();
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  private serialize(chat: Chat, position: number) {
    return encodeChat(chat, position, this.instanceId, this.identities, this.saved.get(chat.id));
  }

  private async importLegacy() {
    const db = this.db!;
    const initialized = () =>
      db.prepare("SELECT value FROM metadata WHERE key = 'initialized'").get();
    if (initialized()) {
      return;
    }
    let original: Buffer | undefined;
    try {
      original = await readFile(this.legacyFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    const chats: Chat[] = original ? JSON.parse(original.toString('utf8')) : [];
    z.array(chatSchema).parse(chats);
    if (new Set(chats.map((chat) => chat.id)).size !== chats.length) {
      throw Error('Duplicate conversation IDs in legacy history.');
    }
    const digest = original && createHash('sha256').update(original).digest('hex');
    if (original) {
      const backup = path.join(path.dirname(this.legacyFile), `chats.pre-sqlite-${digest}.json`);
      try {
        await writeFile(backup, original, { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
          !(await readFile(backup)).equals(original)
        ) {
          throw error;
        }
      }
    }
    this.transaction(() => {
      if (initialized()) {
        return;
      }
      if (Number(db.prepare('SELECT count(*) AS count FROM chats').get()!.count) !== 0) {
        throw Error('Uninitialized conversation database already contains data.');
      }
      chats.forEach((chat, index) => this.insertChat(this.serialize(chat, index)));
      if (
        Number(db.prepare('SELECT count(*) AS count FROM messages').get()!.count) !==
        chats.reduce((sum, chat) => sum + chat.messages.length, 0)
      ) {
        throw Error('Imported conversation message count does not match.');
      }
      const record = db.prepare('INSERT INTO metadata(key, value) VALUES (?, ?)');
      if (digest) {
        record.run('legacy_sha256', digest);
      }
      record.run('initialized', '1');
    });
  }

  private readChats(): Chat[] {
    // The content and the optimistic revisions must describe one WAL snapshot,
    // even when another connection commits between these SELECT statements.
    return this.orm!.transaction(
      (orm) => {
        const messages = new Map<string, MessageRow[]>();
        for (const row of orm
          .select()
          .from(messageTable)
          .orderBy(messageTable.chatId, messageTable.position)
          .all()) {
          const values = messages.get(row.chatId) ?? [];
          if (row.position !== values.length) {
            throw Error('Conversation messages are not contiguous.');
          }
          values.push(row);
          messages.set(row.chatId, values);
        }
        const states = new Map(
          orm
            .select()
            .from(chatInstanceState)
            .where(eq(chatInstanceState.instanceId, this.instanceId))
            .all()
            .map((row) => [row.chatId, row]),
        );
        return orm
          .select()
          .from(chatTable)
          .orderBy(chatTable.sortIndex, chatTable.id)
          .all()
          .map((row) => {
            const record = { row, messages: messages.get(row.id) ?? [], state: states.get(row.id) };
            const chat = decodeChat(record, this.identities);
            chatSchema.parse(chat);
            this.saved.set(row.id, record);
            return chat;
          });
      },
      { behavior: 'deferred' },
    );
  }

  private insertChat(chat: StoredChat) {
    this.orm!.insert(chatTable).values(chat.row).run();
    for (const message of chat.messages) {
      this.orm!.insert(messageTable).values(message).run();
    }
    if (chat.state) {
      this.orm!.insert(chatInstanceState).values(chat.state).run();
    }
  }

  schedule(snapshot: () => Chat[]) {
    if (!this.timer && this.writable) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush(snapshot()).catch(this.onError);
      }, 1000);
    }
  }

  async flush(chats: Chat[]) {
    if (!this.writable) {
      throw Error('Load conversations successfully before saving them.');
    }
    clearTimeout(this.timer);
    this.timer = undefined;
    const snapshot = chats
      .filter((chat) => !isEmptyDraft(chat))
      .map((chat, index) => this.serialize(chat, index));
    if (new Set(snapshot.map((chat) => chat.row.id)).size !== snapshot.length) {
      throw Error('Duplicate conversation IDs cannot be saved.');
    }
    const work = this.queue.catch(() => {}).then(() => this.save(snapshot));
    this.queue = work;
    await work;
  }

  private save(snapshot: StoredChat[]) {
    const orm = this.orm!;
    const next = new Map(snapshot.map((chat) => [chat.row.id, chat]));
    // Revisions are assigned when the queued snapshot is committed, not when
    // it is captured: earlier saves may still be queued for this same chat.
    const changed = snapshot
      .map((chat) => {
        const old = this.saved.get(chat.row.id);
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
    const deleted = [...this.saved.values()].filter((chat) => !next.has(chat.row.id));
    if (!changed.length && !deleted.length) {
      return;
    }
    this.transaction(() => {
      for (const chat of deleted) {
        const result = orm
          .delete(chatTable)
          .where(and(eq(chatTable.id, chat.row.id), eq(chatTable.revision, chat.row.revision)))
          .run();
        if (result.changes !== 1) {
          throw Error('Conversation changed in another process. Restart Wisp before saving.');
        }
      }
      for (const { chat, old, history } of changed) {
        if (!old) {
          this.insertChat(chat);
          continue;
        }
        if (history) {
          chat.row.revision++;
          const result = orm
            .update(chatTable)
            .set(chat.row)
            .where(and(eq(chatTable.id, chat.row.id), eq(chatTable.revision, old.row.revision)))
            .run();
          if (result.changes !== 1) {
            throw Error('Conversation changed in another process. Restart Wisp before saving.');
          }
          this.saveMessages(chat, old);
        } else if (
          orm
            .select({ revision: chatTable.revision })
            .from(chatTable)
            .where(eq(chatTable.id, chat.row.id))
            .get()?.revision !== old.row.revision
        ) {
          throw Error('Conversation changed in another process. Restart Wisp before saving.');
        }
        if (chat.state) {
          chat.state.historyRevision = chat.row.revision;
          if (old.state) {
            chat.state.revision++;
            const result = orm
              .update(chatInstanceState)
              .set(chat.state)
              .where(
                and(
                  eq(chatInstanceState.chatId, chat.row.id),
                  eq(chatInstanceState.instanceId, this.instanceId),
                  eq(chatInstanceState.revision, old.state.revision),
                ),
              )
              .run();
            if (result.changes !== 1) {
              throw Error(
                'Conversation session changed in another process. Restart Wisp before saving.',
              );
            }
          } else {
            orm.insert(chatInstanceState).values(chat.state).run();
          }
        }
      }
    });
    this.saved = next;
  }

  private saveMessages(chat: StoredChat, old: StoredChat) {
    const orm = this.orm!;
    const retained = new Set(chat.messages.map((m) => m.id));
    for (const message of old.messages) {
      if (!retained.has(message.id)) {
        orm.delete(messageTable).where(eq(messageTable.id, message.id)).run();
      }
    }
    const previous = new Map(old.messages.map((m) => [m.id, m]));
    const moved = chat.messages.some(
      (message) =>
        previous.has(message.id) && previous.get(message.id)!.position !== message.position,
    );
    if (moved) {
      orm
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
        orm.insert(messageTable).values(message).run();
      } else if (moved || !sameRow(message, before)) {
        orm
          .update(messageTable)
          .set(message)
          .where(and(eq(messageTable.id, message.id), eq(messageTable.chatId, chat.row.id)))
          .run();
      }
    }
  }

  async close() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.writable = false;
    await this.queue.catch(() => {});
    this.db?.close();
    this.db = undefined;
    this.orm = undefined;
    this.saved.clear();
  }
}
