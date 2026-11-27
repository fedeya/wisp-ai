import { Context, Effect, Layer } from 'effect';
import type { GameEvent } from '@wisp/wow-bridge';
import type { MemoryEdit } from '@wisp/agent/contract/memory';
import { characterIdentity } from '../chat/context.ts';
import { errorMessage } from '../errors.ts';
import type { MemoryView, SessionState } from '../session-state.ts';
import { MemoryRepository } from './repository.ts';

type MemoryPacket = Pick<
  GameEvent,
  'context' | 'key' | 'requestId' | 'session' | 'slot' | 'text'
> & {
  type: Extract<GameEvent['type'], 'memory_list' | 'memory_save' | 'memory_remove'>;
};

export const snapshot = Effect.fn('Memory.snapshot')(function* (
  repository: MemoryRepository['Service'],
  identity: string | undefined,
) {
  const preferences = yield* repository.read({ slot: 'preferences', owner: 'local-player' });
  const character = identity ? yield* repository.read({ slot: 'character', owner: identity }) : [];
  return {
    status: 'available',
    entries: [
      ...preferences.map((entry) => ({ ...entry, slot: 'preferences' })),
      ...character.map((entry) => ({ ...entry, slot: 'character' })),
    ],
  } satisfies MemoryView;
});

export class Service extends Context.Service<
  Service,
  {
    handle: (packet: MemoryPacket) => Effect.Effect<void>;
    reset: () => void;
  }
>()('@wisp/server/memory/AddonAccess') {}

export const layer = (state: SessionState, invalidateAddonView: () => void) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const repository = yield* MemoryRepository;
      let pending: symbol | undefined;

      const readOrEdit = Effect.fnUntraced(function* (packet: MemoryPacket) {
        const identity = characterIdentity(packet.context);
        if (packet.type !== 'memory_list') {
          if (packet.slot !== 'preferences' && packet.slot !== 'character') {
            return yield* Effect.fail(Error('Invalid memory scope'));
          }
          const owner = packet.slot === 'preferences' ? 'local-player' : identity;
          if (!owner || typeof packet.key !== 'string') {
            return yield* Effect.fail(
              Error('A fresh character identity and memory key are required'),
            );
          }
          let edit: MemoryEdit = { operation: 'remove', key: packet.key };
          if (packet.type === 'memory_save') {
            if (typeof packet.text !== 'string') {
              return yield* Effect.fail(Error('Memory text is required'));
            }
            edit = { operation: 'save', key: packet.key, text: packet.text };
          }
          yield* repository.update({ slot: packet.slot, owner }, edit);
        }
        return yield* snapshot(repository, identity);
      });

      const handle = Effect.fn('AddonMemory.handle')(function* (packet: MemoryPacket) {
        const request = Symbol();
        pending = request;
        state.memoryViewRequest = packet.requestId;
        const view: MemoryView = yield* readOrEdit(packet).pipe(
          Effect.catch((error) =>
            Effect.succeed({ status: 'unavailable', error: errorMessage(error) }),
          ),
        );
        if (
          pending === request &&
          state.activeTransport === packet.session &&
          state.memoryViewRequest === packet.requestId
        ) {
          state.memoryView = { ...view, requestId: packet.requestId };
          invalidateAddonView();
        }
      });

      return Service.of({
        handle,
        reset() {
          pending = undefined;
          state.memoryView = undefined;
          state.memoryViewRequest = undefined;
        },
      });
    }),
  );
