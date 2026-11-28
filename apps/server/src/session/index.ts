// @effect-migrated
import { Context, Effect, Layer, Stream, SubscriptionRef } from 'effect';
import type { AccountModel } from '../chat/chat-model.ts';
import type { Chat } from '../chat/chat.ts';

/** The memory page the addon shows, or why it could not be read. */
export interface MemoryView {
  readonly entries?: readonly unknown[];
  readonly status: string;
  readonly error?: string;
  readonly requestId?: string;
}

/** A panel the desktop asked the addon to show or hide. */
export interface PanelCommand {
  readonly seq: number;
  readonly id: string;
  readonly characterKey: string;
  readonly action: 'show' | 'hide';
}

/** The character the addon last reported for routines, and whether it can run one. */
export interface RoutinePresence {
  readonly identity: string;
  readonly context: unknown;
  readonly ready: boolean;
  readonly at: number;
  readonly session: string;
}

/** What the bridge knows about the game session and its conversations. */
export interface Session {
  /**
   * The conversations. The list is replaced by updates, but each chat is
   * still edited in place by the turn runner, the reply projection and the
   * packet receiver; `SessionState.commit` tells the subscribers.
   */
  readonly chats: readonly Chat[];
  readonly activeTransport: string;
  readonly questRevision?: number;
  readonly characterRevision?: number;
  readonly activeChat: string;
  readonly inlineChat: string;
  readonly currentCharacterKey?: string;
  readonly routineCommand?: { readonly seq: number; readonly id: string };
  readonly panelCommand?: PanelCommand;
  readonly memoryView?: MemoryView;
  readonly memoryViewRequest?: string;
  readonly modelCatalog: readonly AccountModel[];
  readonly modelCatalogError?: string;
  readonly capabilityAcks: Readonly<Record<string, string>>;
  readonly capabilityError?: { readonly requestId?: string; readonly message: string };
  readonly routinePresence?: RoutinePresence;
  readonly deletedChatIds: ReadonlySet<string>;
}

/** A session with `chats` and nothing else known yet. */
export const initialSession = (chats: readonly Chat[] = []): Session => ({
  chats,
  activeTransport: '',
  activeChat: '',
  inlineChat: '',
  modelCatalog: [],
  capabilityAcks: {},
  deletedChatIds: new Set(),
});

/**
 * The bridge's session. Whatever reacts to it (the addon snapshot, chat
 * persistence) subscribes to `changes`.
 */
export class SessionState extends Context.Service<
  SessionState,
  {
    /** The session as it is now. */
    readonly get: Effect.Effect<Session>;
    /**
     * Each session an update stores, starting with the next one. Every update
     * stores a new value, so a subscriber can tell by identity whether it has
     * seen one. Updates made together may arrive in one array.
     */
    readonly changes: Stream.Stream<Session>;
    /** Stores what `f` returns and tells the subscribers. */
    readonly update: (f: (session: Session) => Session) => Effect.Effect<void>;
    /**
     * Stores what `f` returns without telling the subscribers, who see it with
     * the next `update` or `commit`: for bookkeeping that needs no snapshot of
     * its own (the addon's context revisions, routine presence), and for what
     * a packet changes before the update that ends it.
     */
    readonly stage: (f: (session: Session) => Session) => Effect.Effect<void>;
    /**
     * Tells the subscribers about the session as it is: what `stage` stored,
     * and the edits made in place to its chats. The turn runner, the reply
     * projection and the packet receiver still edit `Chat` objects directly;
     * once they replace a chat through `update`, only staged packets need this.
     */
    readonly commit: Effect.Effect<void>;
  }
>()('@wisp/server/session/SessionState') {}

/** A stored session, and whether storing it told the subscribers. */
interface Stored {
  readonly session: Session;
  readonly told: boolean;
}

/** Session state that starts as `initial`. */
export const make = Effect.fnUntraced(function* (initial: Session) {
  const ref = yield* SubscriptionRef.make<Stored>({ session: initial, told: false });
  const update = (f: (session: Session) => Session) =>
    SubscriptionRef.update(ref, ({ session }): Stored => {
      const next = f(session);
      // A copy when `f` changed nothing in the record, so each update is a new value.
      return { session: next === session ? { ...next } : next, told: true };
    });
  return SessionState.of({
    get: SubscriptionRef.get(ref).pipe(Effect.map(({ session }) => session)),
    changes: SubscriptionRef.changes(ref).pipe(
      // The first element is the value when the stream starts.
      Stream.drop(1),
      Stream.filter(({ told }) => told),
      Stream.map(({ session }) => session),
    ),
    update,
    stage: (f) =>
      SubscriptionRef.update(ref, ({ session }): Stored => ({ session: f(session), told: false })),
    commit: update((session) => session),
  });
});

/** Session state that starts as `initial`. */
export const layerFrom = (initial: Session) => Layer.effect(SessionState, make(initial));

/** Session state that starts with no chats and no game session. */
export const layer = layerFrom(initialSession());
