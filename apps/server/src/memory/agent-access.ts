// @effect-migrated
import { Effect, Schema } from 'effect';
import * as Memory from '@wisp/agent/memory';
import { MemoryEntries } from '@wisp/agent/contract/memory';
import type { MemorySlot } from '@wisp/agent/contract/memory';
import type { Chat } from '../chat/chat.ts';
import type { CapabilitySettings } from '#/capabilities';
import { SessionState, type MemoryView } from '#/session';
import type { MemoryRepository } from './repository.ts';

interface Dependencies {
  repository: MemoryRepository['Service'];
  capabilities: Pick<CapabilitySettings['Service'], 'enabled'>;
  snapshot: (identity: string | undefined) => Effect.Effect<MemoryView, Error>;
}

class MemoryAccessDenied extends Schema.TaggedError<MemoryAccessDenied>()('MemoryAccessDenied', {
  message: Schema.String,
}) {}

const publicEntries = Schema.decodeUnknownEffect(MemoryEntries);

/** The agent's memory, for the working chat of the session that asks, on `SessionState`. */
export const make = Effect.fnUntraced(function* (deps: Dependencies) {
  const session = yield* SessionState;

  const authorize = Effect.fnUntraced(function* (agentSession: string) {
    const state = yield* session.get;
    const owner = state.activeTransport;
    const chat = state.chats.find(
      (chat) => chat.agentSession === agentSession && chat.status === 'working',
    );
    if (!owner || !chat || chat.owner !== owner) {
      return yield* new MemoryAccessDenied({ message: 'No active connection for this character' });
    }
    return chat;
  });

  const scope = Effect.fnUntraced(function* (chat: Chat, slot: MemorySlot) {
    if (!(yield* deps.capabilities.enabled('memory:' + slot))) {
      return yield* new MemoryAccessDenied({
        message: 'This memory capability is disabled in Settings',
      });
    }
    const owner = slot === 'preferences' ? 'local-player' : chat.characterKey;
    if (!owner) {
      return yield* new MemoryAccessDenied({
        message: 'No fresh character identity for this memory',
      });
    }
    return { slot, owner };
  });

  return Memory.Service.of({
    characterKey: Effect.fn('Memory.characterKey')(function* (agentSession) {
      return (yield* authorize(agentSession)).characterKey || null;
    }),
    read: Effect.fn('Memory.read')(function* (agentSession, slot) {
      const chat = yield* authorize(agentSession);
      const memoryScope = yield* scope(chat, slot);
      return yield* deps.repository.read(memoryScope).pipe(Effect.flatMap(publicEntries));
    }),
    update: Effect.fn('Memory.update')(function* (agentSession, slot, edit) {
      const chat = yield* authorize(agentSession);
      if (chat.proactive) {
        return yield* new MemoryAccessDenied({
          message:
            'Automatic suggestions cannot change settings, memory, panels, macros or map markers',
        });
      }
      const memoryScope = yield* scope(chat, slot);
      const entries = yield* deps.repository.update(memoryScope, edit);
      const memoryView = yield* deps.snapshot(chat.characterKey);
      // The addon's memory page shows the change when this chat's window is the one connected.
      yield* session.update((state) =>
        chat.owner === state.activeTransport ? { ...state, memoryView } : state,
      );
      return yield* publicEntries(entries);
    }),
  });
});
