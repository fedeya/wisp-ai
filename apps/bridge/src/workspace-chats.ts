import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { and, eq } from 'drizzle-orm';
import { chatSchema, type Chat } from './chat.ts';
import { isEmptyDraft } from './sessions.ts';
import { ApplicationDatabase } from './db/application-database.ts';
import { chats, messages, chatInstanceState, workspaceDrafts, metadata } from './db/schema.ts';
import {
  encodeChat,
  decodeChat,
  type StoredChat,
  type MessageIdentities,
} from './db/chat-record.ts';

function history(record: StoredChat) {
  const { revision: _revision, sortIndex: _position, ...row } = record.row;
  return { row, messages: record.messages.map(({ id: _id, ...message }) => message) };
}

// A shared development database with private, crash-recoverable active turns.
// Reconciliation and publication happen in one SQLite write transaction.
export class WorkspaceChats {
  private saved = new Map<string, StoredChat>();
  private drafts = new Map<string, number | null>();
  private identities: MessageIdentities = new WeakMap();
  private timer?: ReturnType<typeof setTimeout>;
  private loaded = false;
  readonly database: ApplicationDatabase;
  readonly instanceId: string;
  private onError: (error: unknown) => void;
  private onRename: (previous: string, current: string) => void;
  constructor(
    database: ApplicationDatabase,
    instanceId: string,
    onError: (error: unknown) => void,
    onRename: (previous: string, current: string) => void = () => {},
  ) {
    this.database = database;
    this.instanceId = instanceId;
    this.onError = onError;
    this.onRename = onRename;
  }

  private read(): Map<string, StoredChat> {
    const orm = this.database.orm;
    const content = new Map<string, StoredChat['messages']>();
    for (const row of orm
      .select()
      .from(messages)
      .orderBy(messages.chatId, messages.position)
      .all()) {
      const list = content.get(row.chatId) ?? [];
      if (row.position !== list.length) {
        throw Error('Conversation messages are not contiguous.');
      }
      list.push(row);
      content.set(row.chatId, list);
    }
    const states = new Map(
      orm
        .select()
        .from(chatInstanceState)
        .where(eq(chatInstanceState.instanceId, this.instanceId))
        .all()
        .map((row) => [row.chatId, row]),
    );
    return new Map(
      orm
        .select()
        .from(chats)
        .orderBy(chats.sortIndex, chats.id)
        .all()
        .map((row) => [
          row.id,
          { row, messages: content.get(row.id) ?? [], state: states.get(row.id) },
        ]),
    );
  }

  async load() {
    await this.database.initialize();
    const result = this.database.orm.transaction(
      () => {
        this.database.orm
          .insert(metadata)
          .values({ key: 'initialized', value: '1' })
          .onConflictDoNothing()
          .run();
        this.saved = this.read();
        const local = new Map(
          [...this.saved].map(([id, record]) => [id, decodeChat(record, this.identities)]),
        );
        for (const draft of this.database.orm
          .select()
          .from(workspaceDrafts)
          .where(eq(workspaceDrafts.instanceId, this.instanceId))
          .all()) {
          const chat = JSON.parse(draft.content) as Chat;
          chatSchema.parse(chat);
          if (chat.id !== draft.chatId) {
            throw Error('Workspace draft identity does not match.');
          }
          if (chat.status === 'working') {
            chat.status = 'interrupted';
          }
          for (const message of chat.messages) {
            if (message.streaming && message.rawReply !== undefined) {
              message.streaming = false;
            }
          }
          if (chat.usage) {
            chat.usage.compacting = false;
          }
          this.drafts.set(chat.id, draft.baseRevision);
          local.set(chat.id, chat);
        }
        return [...local.values()];
      },
      { behavior: 'immediate' },
    );
    this.loaded = true;
    return result;
  }

  // Mutates the array only after commit; active chat objects stay untouched.
  synchronize(local: Chat[]) {
    if (!this.loaded) {
      throw Error('Load workspace conversations before saving.');
    }
    if (new Set(local.map((chat) => chat.id)).size !== local.length) {
      throw Error('Duplicate conversation IDs.');
    }
    const nextDrafts = new Map<string, number | null>();
    const result = this.database.orm.transaction(
      () => {
        const orm = this.database.orm;
        const remote = this.read();
        const output: { chat: Chat; original?: Chat }[] = [];
        const pending = new Map(local.map((chat) => [chat.id, chat]));
        const state = (record: StoredChat) => {
          if (!record.state) {
            return;
          }
          orm
            .insert(chatInstanceState)
            .values(record.state)
            .onConflictDoUpdate({
              target: [chatInstanceState.instanceId, chatInstanceState.chatId],
              set: record.state,
            })
            .run();
        };
        const publish = (chat: Chat, old?: StoredChat) => {
          const record = encodeChat(chat, output.length, this.instanceId, this.identities, old);
          record.row.revision = old ? old.row.revision + 1 : 0;
          record.state!.historyRevision = record.row.revision;
          orm
            .insert(chats)
            .values(record.row)
            .onConflictDoUpdate({ target: chats.id, set: record.row })
            .run();
          orm.delete(messages).where(eq(messages.chatId, chat.id)).run();
          for (const row of record.messages) {
            orm.insert(messages).values(row).run();
          }
          state(record);
          remote.set(chat.id, record);
        };
        for (const id of new Set([
          ...pending.keys(),
          ...this.saved.keys(),
          ...this.drafts.keys(),
          ...remote.keys(),
        ])) {
          const own = pending.get(id);
          const before = this.saved.get(id);
          const current = remote.get(id);
          const baseRevision = this.drafts.has(id) ? this.drafts.get(id) : before?.row.revision;
          if (own?.status === 'working') {
            const draft = {
              instanceId: this.instanceId,
              chatId: id,
              baseRevision: baseRevision ?? null,
              content: JSON.stringify(own),
            };
            orm
              .insert(workspaceDrafts)
              .values(draft)
              .onConflictDoUpdate({
                target: [workspaceDrafts.instanceId, workspaceDrafts.chatId],
                set: draft,
              })
              .run();
            nextDrafts.set(id, draft.baseRevision);
            output.push({ chat: own });
            continue;
          }
          orm
            .delete(workspaceDrafts)
            .where(
              and(eq(workspaceDrafts.instanceId, this.instanceId), eq(workspaceDrafts.chatId, id)),
            )
            .run();
          if (own && isEmptyDraft(own)) {
            output.push({ chat: own });
            continue;
          }
          const encoded = own && encodeChat(own, 0, this.instanceId, this.identities, before);
          const changed =
            this.drafts.has(id) ||
            (encoded ? !before || !isDeepStrictEqual(history(encoded), history(before)) : !!before);
          if (!changed) {
            if (current) {
              if (encoded && !isDeepStrictEqual(encoded.state, before?.state)) {
                state(encoded);
                current.state = encoded.state;
              }
              output.push({ chat: decodeChat(current, this.identities), original: own });
            }
          } else if (current?.row.revision === (baseRevision ?? undefined)) {
            if (own) {
              publish(own, current);
              output.push({ chat: own });
            } else {
              orm.delete(chats).where(eq(chats.id, id)).run();
              remote.delete(id);
            }
          } else if (own && !current && (baseRevision === null || baseRevision === undefined)) {
            publish(own);
            output.push({ chat: own });
          } else {
            if (current) {
              output.push({ chat: decodeChat(current, this.identities) });
            }
            if (own) {
              const copy = {
                ...own,
                id: randomUUID(),
                title: own.title + ' (conflict copy)',
                eveId: undefined,
              };
              publish(copy);
              output.push({ chat: copy, original: own });
            }
          }
        }
        return { output, remote };
      },
      { behavior: 'immediate' },
    );
    const values = result.output.map(({ chat, original }) => {
      if (!original || original === chat) {
        return chat;
      }
      for (const key of Object.keys(original)) {
        if (!(key in chat)) {
          delete (original as unknown as Record<string, unknown>)[key];
        }
      }
      const previousId = original.id;
      Object.assign(original, chat);
      if (previousId !== original.id) {
        this.onRename(previousId, original.id);
      }
      return original;
    });
    this.saved = result.remote;
    this.drafts = nextDrafts;
    local.splice(0, local.length, ...values);
  }

  schedule(snapshot: () => Chat[]) {
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        try {
          this.synchronize(snapshot());
        } catch (error) {
          this.onError(error);
        }
      }, 1000);
    }
  }
  async flush(local: Chat[]) {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.synchronize(local);
  }
  async close() {
    clearTimeout(this.timer);
    this.loaded = false;
  }
}
