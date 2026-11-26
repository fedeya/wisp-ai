import { sameRow, type StoredChat } from './chat-record.ts';

export interface ChangedChat {
  chat: StoredChat;
  /** The copy saved before, when the chat is not new. */
  old?: StoredChat;
  /** The chat row or its messages changed, not only this instance's private state. */
  history: boolean;
}

export interface SavePlan {
  deleted: StoredChat[];
  changed: ChangedChat[];
}

/**
 * What a save must write to turn the `saved` copies into `snapshot`. Each
 * snapshot chat starts from the revisions of its saved copy: they are assigned
 * when the save is planned, not when the snapshot was taken, because an
 * earlier save of the same chat may have committed in between.
 */
export function planSave(saved: ReadonlyMap<string, StoredChat>, snapshot: StoredChat[]): SavePlan {
  const next = new Set(snapshot.map((chat) => chat.row.id));
  const changed = snapshot.flatMap((chat): ChangedChat[] => {
    const old = saved.get(chat.row.id);
    chat.row.revision = old?.row.revision ?? 0;
    if (chat.state) {
      chat.state.revision = old?.state?.revision ?? 0;
      chat.state.historyRevision = chat.row.revision;
    }
    if (!old) {
      return [{ chat, history: true }];
    }
    const history =
      !sameRow(chat.row, old.row) ||
      chat.messages.length !== old.messages.length ||
      chat.messages.some((message, index) => !sameRow(message, old.messages[index]));
    const state = !old.state || !chat.state || !sameRow(chat.state, old.state);
    return history || state ? [{ chat, old, history }] : [];
  });
  const deleted = [...saved.values()].filter((chat) => !next.has(chat.row.id));
  return { deleted, changed };
}
