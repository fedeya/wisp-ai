import { randomUUID } from 'node:crypto';
import type { Chat, Message } from '../chat.ts';
import type { chats, messages, chatInstanceState } from './schema.ts';

export type ChatRow = typeof chats.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type InstanceRow = typeof chatInstanceState.$inferSelect;
export interface StoredChat {
  row: ChatRow;
  messages: MessageRow[];
  state?: InstanceRow;
}
export type MessageIdentities = WeakMap<Message, { chatId: string; id: string }>;
const json = (value: unknown) => (value === undefined ? null : JSON.stringify(value));

export function sameRow(a: object, b: object) {
  return Object.entries(a).every(([key, value]) => value === (b as Record<string, unknown>)[key]);
}

export function encodeChat(
  chat: Chat,
  position: number,
  instanceId: string,
  identities: MessageIdentities,
  previous?: StoredChat,
): StoredChat {
  const {
    id,
    title,
    status,
    characterKey,
    lastUsedAt,
    lastActivityAt,
    messages: entries,
    owner,
    eveId,
    unread,
    modelSettings,
    modelRequestId,
    modelError,
    usage,
    lastUIResult,
    ...extras
  } = chat;
  const old = previous?.messages ?? [];
  const rows = entries.map((message, index) => {
    const { id: sourceId, role, text, ...rest } = message;
    return {
      chatId: id,
      position: index,
      sourceId: sourceId ?? null,
      role,
      text,
      extras: JSON.stringify(rest),
    };
  });
  const assigned = new Map<number, string>();
  const used = new Set<string>();
  const assign = (index: number, storageId: string) => {
    assigned.set(index, storageId);
    used.add(storageId);
  };
  // Runtime object identity survives edits and array reordering.
  entries.forEach((message, index) => {
    const known = identities.get(message);
    if (known?.chatId === id && !used.has(known.id)) {
      assign(index, known.id);
    }
  });
  // Preserve IDs when callers reconstruct message objects, too. Source IDs may
  // be missing or duplicated in old histories, so they are not primary keys.
  rows.forEach((row, index) => {
    if (assigned.has(index) || row.sourceId === null) {
      return;
    }
    const matches = old.filter((m) => m.sourceId === row.sourceId);
    if (
      matches.length === 1 &&
      rows.filter((m) => m.sourceId === row.sourceId).length === 1 &&
      !used.has(matches[0].id)
    ) {
      assign(index, matches[0].id);
    }
  });
  rows.forEach((row, index) => {
    if (assigned.has(index)) {
      return;
    }
    const match = old.find(
      (m) =>
        !used.has(m.id) &&
        m.sourceId === row.sourceId &&
        m.role === row.role &&
        m.text === row.text &&
        m.extras === row.extras,
    );
    if (match) {
      assign(index, match.id);
    }
  });
  return {
    row: {
      id,
      sortIndex: position,
      title,
      status,
      characterKey: characterKey ?? null,
      lastUsedAt: lastUsedAt ?? null,
      lastActivityAt: lastActivityAt ?? null,
      revision: previous?.row.revision ?? 0,
      extras: JSON.stringify(extras),
    },
    state: {
      instanceId,
      chatId: id,
      revision: previous?.state?.revision ?? 0,
      historyRevision: previous?.row.revision ?? 0,
      owner,
      eveId: eveId ?? null,
      unread: unread ?? null,
      modelSettings: json(modelSettings),
      modelRequestId: modelRequestId ?? null,
      modelError: modelError ?? null,
      usage: json(usage),
      lastUIResult: json(lastUIResult),
    },
    messages: rows.map((row, index) => {
      let storageId = assigned.get(index);
      if (!storageId) {
        const candidate = old[index];
        storageId =
          candidate &&
          !used.has(candidate.id) &&
          candidate.sourceId === row.sourceId &&
          candidate.role === row.role
            ? candidate.id
            : randomUUID();
        used.add(storageId);
      }
      identities.set(entries[index], { chatId: id, id: storageId });
      return { ...row, id: storageId };
    }),
  };
}

export function decodeChat(record: StoredChat, identities: MessageIdentities): Chat {
  const { row, state } = record;
  const chat: Chat = {
    ...JSON.parse(row.extras),
    id: row.id,
    title: row.title,
    status: row.status,
    owner: state?.owner ?? '',
    messages: record.messages.map((message) => {
      const value: Message = {
        ...JSON.parse(message.extras),
        role: message.role,
        text: message.text,
      };
      if (message.sourceId !== null) {
        value.id = message.sourceId;
      }
      identities.set(value, { chatId: row.id, id: message.id });
      return value;
    }),
  };
  if (row.characterKey !== null) {
    chat.characterKey = row.characterKey;
  }
  if (row.lastUsedAt !== null) {
    chat.lastUsedAt = row.lastUsedAt;
  }
  if (row.lastActivityAt !== null) {
    chat.lastActivityAt = row.lastActivityAt;
  }
  if (state) {
    if (state.eveId !== null && state.historyRevision === row.revision) {
      chat.eveId = state.eveId;
    }
    if (state.unread !== null) {
      chat.unread = state.unread;
    }
    if (state.modelSettings !== null) {
      chat.modelSettings = JSON.parse(state.modelSettings);
    }
    if (state.modelRequestId !== null) {
      chat.modelRequestId = state.modelRequestId;
    }
    if (state.modelError !== null) {
      chat.modelError = state.modelError;
    }
    if (state.usage !== null) {
      chat.usage = JSON.parse(state.usage);
    }
    if (state.lastUIResult !== null) {
      chat.lastUIResult = JSON.parse(state.lastUIResult);
    }
  }
  return chat;
}
