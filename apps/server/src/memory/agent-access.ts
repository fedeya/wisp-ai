import { Effect, Schema } from 'effect';
import * as Memory from '@wisp/agent/memory';
import { MemoryEntries } from '@wisp/agent/contract/memory';
import type { MemorySlot } from '@wisp/agent/contract/memory';
import type { Chat } from '../chat/chat.ts';
import type { CapabilitySettings } from '../integrations/capabilities.ts';
import type { MemoryView } from '../session-state.ts';
import type { MemoryRepository } from './repository.ts';

interface Dependencies {
  repository: MemoryRepository['Service'];
  chats: () => readonly Chat[];
  currentTransport: () => string;
  capabilities: Pick<CapabilitySettings, 'enabled'>;
  snapshot: (identity: string | undefined) => Effect.Effect<MemoryView, Error>;
  setView: (view: MemoryView) => void;
  changed: () => void;
}

class MemoryAccessDenied extends Schema.TaggedError<MemoryAccessDenied>()('MemoryAccessDenied', {
  message: Schema.String,
}) {}

const publicEntries = Schema.decodeUnknownEffect(MemoryEntries);

export function make(deps: Dependencies) {
  const authorize = Effect.fnUntraced(function* (session: string) {
    const owner = deps.currentTransport();
    const chat = deps
      .chats()
      .find((chat) => chat.agentSession === session && chat.status === 'working');
    if (!owner || !chat || chat.owner !== owner) {
      return yield* new MemoryAccessDenied({ message: 'No active connection for this character' });
    }
    return chat;
  });

  const scope = Effect.fnUntraced(function* (chat: Chat, slot: MemorySlot) {
    if (!deps.capabilities.enabled('memory:' + slot)) {
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
    characterKey: Effect.fn('Memory.characterKey')(function* (session) {
      return (yield* authorize(session)).characterKey || null;
    }),
    read: Effect.fn('Memory.read')(function* (session, slot) {
      const chat = yield* authorize(session);
      const memoryScope = yield* scope(chat, slot);
      return yield* deps.repository.read(memoryScope).pipe(Effect.flatMap(publicEntries));
    }),
    update: Effect.fn('Memory.update')(function* (session, slot, edit) {
      const chat = yield* authorize(session);
      if (chat.proactive) {
        return yield* new MemoryAccessDenied({
          message:
            'Automatic suggestions cannot change settings, memory, panels, macros or map markers',
        });
      }
      const memoryScope = yield* scope(chat, slot);
      const entries = yield* deps.repository.update(memoryScope, edit);
      const snapshot = yield* deps.snapshot(chat.characterKey);
      if (chat.owner === deps.currentTransport()) deps.setView(snapshot);
      deps.changed();
      return yield* publicEntries(entries);
    }),
  });
}
