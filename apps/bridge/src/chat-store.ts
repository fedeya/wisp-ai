import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrateChats } from './db/migrate.ts';
import { z } from 'zod';
import { chatSchema, type Chat } from './chat.ts';
import { isEmptyDraft } from './sessions.ts';

interface StoredChat {
  id: string;
  metadata: string;
  messages: string[];
  position: number;
  revision: number;
  characterKey: string | null;
  lastActivity: number;
}

function serialize(chat: Chat, position: number, revision = 0): StoredChat {
  const { messages, ...metadata } = chat;
  return {
    id: chat.id,
    metadata: JSON.stringify(metadata),
    messages: messages.map((message) => JSON.stringify(message)),
    position,
    revision,
    characterKey: chat.characterKey ?? null,
    lastActivity: chat.lastActivityAt ?? chat.lastUsedAt ?? 0,
  };
}

export class ChatStore {
  readonly file: string;
  readonly legacyFile: string;
  private onError: (error: unknown) => void;
  private db?: DatabaseSync;
  private queue: Promise<void> = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private saved = new Map<string, StoredChat>();
  private writable = false;
  constructor(
    file: string,
    onError: (error: unknown) => void,
    legacyFile = path.join(path.dirname(file), 'chats.json'),
  ) {
    this.file = file;
    this.legacyFile = legacyFile;
    this.onError = onError;
  }

  async load(): Promise<Chat[]> {
    if (this.db) {
      throw Error('Conversation store is already open.');
    }
    await mkdir(path.dirname(this.file), { recursive: true });
    try {
      const db = (this.db = new DatabaseSync(this.file, { timeout: 5000 }));
      const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
      if (version < 0 || version > 2) {
        throw Error(`Unsupported conversation database version: ${version}`);
      }
      db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
      migrateChats(db);
      await this.importLegacy();
      const chats = this.readChats();
      this.writable = true;
      return chats
        .filter((chat) => !isEmptyDraft(chat))
        .map((chat) => ({
          ...chat,
          lastActivityAt: chat.lastActivityAt ?? chat.lastUsedAt ?? 0,
          status: chat.status === 'working' ? 'interrupted' : chat.status,
          usage: chat.usage ? { ...chat.usage, compacting: false } : undefined,
        }));
    } catch (cause) {
      this.db?.close();
      this.db = undefined;
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
    // Validate every conversation before importing. Preserve unknown fields too.
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
      // Migration may have completed on another connection during the backup.
      if (initialized()) {
        return;
      }
      if (Number(db.prepare('SELECT count(*) AS count FROM chats').get()!.count) !== 0) {
        throw Error('Uninitialized conversation database already contains data.');
      }
      chats.forEach((chat, index) => this.insertChat(serialize(chat, index)));
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
    const db = this.db!;
    const messages = new Map<string, string[]>();
    for (const row of db
      .prepare('SELECT chat_id, position, content FROM messages ORDER BY chat_id, position')
      .iterate()) {
      const id = String(row.chat_id);
      const values = messages.get(id) ?? [];
      if (Number(row.position) !== values.length) {
        throw Error('Conversation messages are not contiguous.');
      }
      values.push(String(row.content));
      messages.set(id, values);
    }
    const chats: Chat[] = [];
    for (const row of db.prepare('SELECT * FROM chats ORDER BY sort_index, id').iterate()) {
      const id = String(row.id);
      const content = messages.get(id) ?? [];
      const chat: Chat = {
        ...JSON.parse(String(row.metadata)),
        messages: content.map((value) => JSON.parse(value)),
      };
      chatSchema.parse(chat);
      if (chat.id !== id) {
        throw Error('Conversation identity does not match its database row.');
      }
      this.saved.set(id, {
        ...serialize(chat, Number(row.sort_index), Number(row.revision)),
        metadata: String(row.metadata),
        messages: content,
      });
      chats.push(chat);
    }
    return chats;
  }

  private insertChat(chat: StoredChat) {
    this.db!.prepare(
      'INSERT INTO chats(id, sort_index, character_key, last_activity, revision, metadata) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      chat.id,
      chat.position,
      chat.characterKey,
      chat.lastActivity,
      chat.revision,
      chat.metadata,
    );
    const message = this.db!.prepare(
      'INSERT INTO messages(chat_id, position, content) VALUES (?, ?, ?)',
    );
    chat.messages.forEach((content, index) => message.run(chat.id, index, content));
  }

  // Batch streaming changes; write only the changed conversation/message rows.
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
    // Freeze values before waiting for earlier queued writes.
    const snapshot = chats
      .filter((chat) => !isEmptyDraft(chat))
      .map((chat, i) => serialize(chat, i));
    if (new Set(snapshot.map((chat) => chat.id)).size !== snapshot.length) {
      throw Error('Duplicate conversation IDs cannot be saved.');
    }
    const work = this.queue.catch(() => {}).then(() => this.save(snapshot));
    this.queue = work;
    await work;
  }

  private save(snapshot: StoredChat[]) {
    const db = this.db!;
    const next = new Map(snapshot.map((chat) => [chat.id, chat]));
    const changed = snapshot.filter((chat) => {
      const old = this.saved.get(chat.id);
      return (
        !old ||
        old.metadata !== chat.metadata ||
        old.position !== chat.position ||
        old.messages.length !== chat.messages.length ||
        chat.messages.some((m, i) => m !== old.messages[i])
      );
    });
    const deleted = [...this.saved.values()].filter((chat) => !next.has(chat.id));
    if (!changed.length && !deleted.length) {
      return;
    }
    this.transaction(() => {
      for (const chat of deleted) {
        const result = db
          .prepare('DELETE FROM chats WHERE id = ? AND revision = ?')
          .run(chat.id, chat.revision);
        if (result.changes !== 1) {
          throw Error('Conversation changed in another process. Restart Wisp before saving.');
        }
      }
      for (const chat of changed) {
        const old = this.saved.get(chat.id);
        if (!old) {
          this.insertChat(chat);
          continue;
        }
        chat.revision = old.revision + 1;
        const result = db
          .prepare(
            'UPDATE chats SET sort_index = ?, character_key = ?, last_activity = ?, metadata = ?, revision = revision + 1 WHERE id = ? AND revision = ?',
          )
          .run(
            chat.position,
            chat.characterKey,
            chat.lastActivity,
            chat.metadata,
            chat.id,
            old.revision,
          );
        if (result.changes !== 1) {
          throw Error('Conversation changed in another process. Restart Wisp before saving.');
        }
        const message = db.prepare(
          'INSERT INTO messages(chat_id, position, content) VALUES (?, ?, ?) ON CONFLICT(chat_id, position) DO UPDATE SET content = excluded.content',
        );
        chat.messages.forEach((content, index) => {
          if (content !== old.messages[index]) {
            message.run(chat.id, index, content);
          }
        });
        if (chat.messages.length < old.messages.length) {
          db.prepare('DELETE FROM messages WHERE chat_id = ? AND position >= ?').run(
            chat.id,
            chat.messages.length,
          );
        }
      }
    });
    const changedIds = new Set(changed.map((chat) => chat.id));
    for (const chat of snapshot) {
      if (!changedIds.has(chat.id)) {
        chat.revision = this.saved.get(chat.id)!.revision;
      }
    }
    this.saved = next;
  }

  async close() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.writable = false;
    await this.queue.catch(() => {});
    this.db?.close();
    this.db = undefined;
    this.saved.clear();
  }
}
