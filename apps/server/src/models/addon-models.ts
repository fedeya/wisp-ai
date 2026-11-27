import { Effect } from 'effect';
import type { GameEvent } from '@wisp/wow-bridge';
import { isWorking } from '../chat/chat-lifecycle.ts';
import { chooseChatModel } from '../chat/chat-model.ts';
import type { Chat } from '../chat/events.ts';
import { errorMessage } from '../errors.ts';
import type { SessionState } from '../session-state.ts';
import type { ModelCatalog } from './model-connections.ts';

export function make(deps: {
  state: SessionState;
  models: Pick<ModelCatalog, 'models'>;
  findChat: (id: string) => Chat | undefined;
  createChat: (id: string) => Chat;
  saveChats: () => void;
  invalidateAddonView: () => void;
}) {
  const { state, models, findChat, createChat, saveChats, invalidateAddonView } = deps;
  return Effect.fn('AddonModels.changeChatModel')(function* ({
    chat: id,
    data,
    requestId,
  }: Extract<GameEvent, { type: 'chat_model_set' }>) {
    const existing = findChat(id);
    const chat =
      existing ?? (data.inline && !state.deletedChatIds.has(id) ? createChat(id) : undefined);
    if (!chat) return;
    if (data.inline && !chat.messages.length) {
      chat.inline = true;
      chat.title = 'Quick question';
      chat.titleGenerated = true;
      state.inlineChat = chat.id;
    }
    yield* Effect.gen(function* () {
      const busy = 'Wait for this reply before changing model settings.';
      if (isWorking(chat)) return yield* Effect.fail(busy);
      const available = yield* Effect.tryPromise({
        try: () => models.models(),
        catch: errorMessage,
      });
      if (isWorking(chat)) return yield* Effect.fail(busy);
      const selected = yield* Effect.try({
        try: () => chooseChatModel(available, data.model, data.effort),
        catch: errorMessage,
      });
      // Keep the session: the agent filters provider-native data on replay.
      chat.modelSettings = selected;
      chat.modelError = undefined;
      state.modelCatalog = available;
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          chat.modelError = error;
        }),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          chat.modelRequestId = requestId;
          saveChats();
          invalidateAddonView();
        }),
      ),
    );
  });
}
