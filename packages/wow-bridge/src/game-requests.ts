import { Clock, Deferred, Effect } from 'effect';
import { SecureRandom } from 'effect/crypto';

export interface GameRequest {
  chat: string;
  session: string;
  sections?: string[];
  inspection?: unknown;
  action?: unknown;
  /** Agent tool calls fail fast while WoW is unresponsive and get errors written for the agent. */
  agent?: boolean;
}
interface PendingRequest extends GameRequest {
  finish: (result: Effect.Effect<unknown, Error>) => void;
}

/** How long new agent game requests fail at once after one timed out, unless WoW answers first. */
export const UNRESPONSIVE_MS = 60_000;
const TIMEOUT_MESSAGE = 'WoW did not respond in time. Open Wisp and try again.';
// The agent reads these: they tell it to stop calling game tools for the rest of the turn.
const AGENT_TIMEOUT_MESSAGE =
  'WoW did not respond in time. Do not call game tools again in this turn: answer with what you already know, and tell the player to type /reload in WoW if Wisp keeps not responding.';
const UNRESPONSIVE_MESSAGE =
  'WoW did not respond to the previous game request, so this one was not sent. Do not call game tools again in this turn: answer with what you already know, and tell the player to type /reload in WoW if Wisp keeps not responding.';

export interface GameRequestOptions {
  now?: () => number;
}

export class GameRequests {
  private pending = new Map<string, PendingRequest>();
  private recoveryIds = new Map<string, string>();
  private changed: () => void;
  private now: () => number;
  private readonly nextId: Effect.Effect<string>;
  private lastHeardAt = 0;
  private unresponsiveSince?: number;
  private closed = false;
  /** IDs of recently timed-out requests, kept only to recognize a late answer. */
  private timedOut = new Map<string, { session: string; chat: string }>();
  private constructor(
    changed: () => void,
    options: GameRequestOptions,
    clock: Clock.Clock,
    nextId: Effect.Effect<string>,
  ) {
    this.changed = changed;
    this.now = options.now ?? (() => clock.currentTimeMillisUnsafe());
    this.nextId = nextId;
  }

  static readonly make = Effect.fnUntraced(function* (
    changed: () => void,
    options: GameRequestOptions = {},
  ) {
    const clock = yield* Clock.Clock;
    const random = yield* SecureRandom.SecureRandom;
    return new GameRequests(changed, options, clock, random.uuidV4());
  }, Effect.provide(SecureRandom.layerWebCrypto));

  /** Records any packet from the active game window, to tell a silent addon from a busy one. */
  heard() {
    this.lastHeardAt = this.now();
  }

  request(
    input: GameRequest,
    timeout = 30_000,
    isActive = () => true,
  ): Effect.Effect<unknown, Error> {
    return Effect.gen({ self: this }, function* () {
      if (this.closed) {
        return yield* Effect.fail(new Error('Bridge stopped'));
      }
      // A timeout backs off agent tools on the whole channel. Player requests still go through.
      if (
        input.agent &&
        this.unresponsiveSince !== undefined &&
        this.now() - this.unresponsiveSince < UNRESPONSIVE_MS
      ) {
        return yield* Effect.fail(new Error(UNRESPONSIVE_MESSAGE));
      }
      const startedAt = this.now();
      const reply = yield* Deferred.make<unknown, Error>();
      let id = yield* this.nextId;
      const previousIds: string[] = [];

      const remove = () => {
        if (!this.pending.delete(id)) return false;
        for (const previous of previousIds) {
          this.recoveryIds.delete(previous);
        }
        this.changed();
        return true;
      };

      const request: PendingRequest = {
        ...input,
        finish: (result) => {
          if (remove()) Deferred.doneUnsafe(reply, result);
        },
      };
      yield* Effect.acquireRelease(
        Effect.suspend(() => {
          if (this.closed) return Effect.fail(new Error('Bridge stopped'));
          if (!isActive()) return Effect.fail(new Error('No active connection for this character'));
          this.pending.set(id, request);
          return Effect.void;
        }),
        () => Effect.sync(remove),
      );
      this.changed();

      // Recover only reads. The addon deduplicates by ID, so each retry needs a new one.
      if (!input.action && (input.sections || input.inspection)) {
        const retry = Effect.sleep(timeout / 3).pipe(
          Effect.andThen(
            Effect.gen({ self: this }, function* () {
              const nextId = yield* this.nextId;
              if (!this.pending.delete(id)) return;
              previousIds.push(id);
              id = nextId;
              for (const previous of previousIds) {
                this.recoveryIds.set(previous, id);
              }
              this.pending.set(id, request);
              this.changed();
            }),
          ),
        );
        yield* Effect.andThen(retry, retry).pipe(Effect.forkScoped({ startImmediately: true }));
      }

      const expire = Effect.gen({ self: this }, function* () {
        if (!this.pending.has(id)) return;
        const timedOutAt = this.now();
        this.unresponsiveSince = timedOutAt;
        const timeoutDetails = {
          kind: input.action ? 'action' : input.inspection ? 'inspection' : 'state',
          addonSilent: this.lastHeardAt <= startedAt,
          waitedMs: timedOutAt - startedAt,
        };
        // Remember every ID this request used, so a late answer proves WoW recovered.
        for (const timedOutId of [id, ...previousIds]) {
          this.timedOut.set(timedOutId, { session: input.session, chat: input.chat });
        }
        for (const oldest of this.timedOut.keys()) {
          if (this.timedOut.size <= 64) break;
          this.timedOut.delete(oldest);
        }
        request.finish(
          Effect.fail(new Error(input.agent ? AGENT_TIMEOUT_MESSAGE : TIMEOUT_MESSAGE)),
        );
        yield* Effect.logWarning('WoW did not answer a request').pipe(
          Effect.annotateLogs({ event: 'game.request_timeout', ...timeoutDetails }),
        );
      }).pipe(Effect.uninterruptible);
      yield* Effect.sleep(timeout).pipe(
        Effect.andThen(expire),
        Effect.forkScoped({ startImmediately: true }),
      );
      return yield* Deferred.await(reply);
    }).pipe(Effect.scoped);
  }
  receive(requestId: string, session: string, chat: string | undefined, value: unknown) {
    const request = this.pending.get(this.recoveryIds.get(requestId) || requestId);
    if (request?.session === session && request.chat === chat) {
      this.unresponsiveSince = undefined;
      request.finish(Effect.succeed(value));
      return true;
    }
    // A valid answer to a request that already timed out: its result stays
    // rejected, but WoW is answering again, so stop failing new requests.
    const late = this.timedOut.get(requestId);
    if (late?.session === session && late.chat === chat) {
      this.timedOut.delete(requestId);
      this.unresponsiveSince = undefined;
    }
    return false;
  }
  cancelAll(reason: string) {
    // A new window or reconnection starts with a fresh channel.
    this.unresponsiveSince = undefined;
    for (const request of this.pending.values()) {
      request.finish(Effect.fail(new Error(reason)));
    }
  }
  close() {
    this.closed = true;
    this.cancelAll('Bridge stopped');
  }
  cancelChat(chat: string) {
    for (const request of this.pending.values()) {
      if (request.chat === chat) {
        request.finish(Effect.fail(new Error('Conversation deleted')));
      }
    }
  }
  snapshot() {
    return [...this.pending.entries()].map(([id, { chat, sections, inspection, action }]) => ({
      id,
      chat,
      sections,
      inspection,
      action,
    }));
  }
}
