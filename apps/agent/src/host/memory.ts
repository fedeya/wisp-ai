import { Context } from 'effect';
import type { Effect } from 'effect';
import type { MemoryEdit, MemoryEntries, MemorySlot } from '../contract/memory.ts';

type Entries = typeof MemoryEntries.Type;

/** Memory available to an agent session. The host resolves identity and permissions. */
export class Service extends Context.Service<
  Service,
  {
    readonly characterKey: (session: string) => Effect.Effect<string | null, Error>;
    readonly read: (session: string, slot: MemorySlot) => Effect.Effect<Entries, Error>;
    readonly update: (
      session: string,
      slot: MemorySlot,
      edit: MemoryEdit,
    ) => Effect.Effect<Entries, Error>;
  }
>()('@wisp/agent/Memory') {}
