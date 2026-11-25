import { randomUUID } from 'node:crypto';
import { Cause, Deferred, Effect, Exit, Schema } from 'effect';

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
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/**
 * A game request that WoW did not answer. The message is what the agent or the
 * player reads, so it says what to do next.
 */
export class GameRequestFailed extends Schema.TaggedError<GameRequestFailed>()(
  'GameRequestFailed',
  {
    reason: Schema.Literals(['cancelled', 'timeout', 'unresponsive']),
    message: Schema.String,
  },
) {}

const CANCELLED = () =>
  new GameRequestFailed({ reason: 'cancelled', message: 'Game request cancelled' });

/** Fails when the caller cancels the request. */
const cancelled = (signal?: AbortSignal) =>
  signal
    ? Effect.callback<never, GameRequestFailed>((resume) => {
        const abort = () => resume(Effect.fail(CANCELLED()));
        signal.addEventListener('abort', abort, { once: true });
        return Effect.sync(() => signal.removeEventListener('abort', abort));
      })
    : Effect.never;

/** How long new agent game requests fail at once after one timed out, unless WoW answers first. */
export const UNRESPONSIVE_MS = 60_000;
const TIMEOUT_MESSAGE = 'WoW did not respond in time. Open Wisp and try again.';
// The agent reads these: they tell it to stop calling game tools for the rest of the turn.
const AGENT_TIMEOUT_MESSAGE =
  'WoW did not respond in time. Do not call game tools again in this turn: answer with what you already know, and tell the player to type /reload in WoW if Wisp keeps not responding.';
const UNRESPONSIVE_MESSAGE =
  'WoW did not respond to the previous game request, so this one was not sent. Do not call game tools again in this turn: answer with what you already know, and tell the player to type /reload in WoW if Wisp keeps not responding.';

export interface GameTimeout {
  kind: 'state' | 'inspection' | 'action';
  /** True when the addon sent nothing at all while the request waited. */
  addonSilent: boolean;
  waitedMs: number;
}
interface GameRequestOptions {
  now?: () => number;
  onTimeout?: (timeout: GameTimeout) => void;
}

export class GameRequests {
  private pending = new Map<string, PendingRequest>();
  private recoveryIds = new Map<string, string>();
  private changed: () => void;
  private now: () => number;
  private onTimeout: (timeout: GameTimeout) => void;
  private lastHeardAt = 0;
  private unresponsiveSince?: number;
  /** IDs of recently timed-out requests, kept only to recognize a late answer. */
  private timedOut = new Map<string, { session: string; chat: string }>();
  constructor(changed: () => void, options: GameRequestOptions = {}) {
    this.changed = changed;
    this.now = options.now ?? Date.now;
    this.onTimeout = options.onTimeout ?? (() => {});
  }

  /** Records any packet from the active game window, to tell a silent addon from a busy one. */
  heard() {
    this.lastHeardAt = this.now();
  }

  request(input: GameRequest, signal?: AbortSignal, timeout = 30_000): Promise<unknown> {
    if (signal?.aborted) {
      return Promise.reject(CANCELLED());
    }
    // One timeout means the whole game channel is stuck: every game tool waits on it.
    // Fail the agent's next ones at once instead of making the player wait 30 seconds each.
    // Requests the player starts (a settings button, a simulation) are always sent.
    if (
      input.agent &&
      this.unresponsiveSince !== undefined &&
      this.now() - this.unresponsiveSince < UNRESPONSIVE_MS
    ) {
      return Promise.reject(
        new GameRequestFailed({ reason: 'unresponsive', message: UNRESPONSIVE_MESSAGE }),
      );
    }
    const startedAt = this.now();
    const answer = Deferred.makeUnsafe<unknown, Error>();
    let id = randomUUID();
    const previousIds: string[] = [];
    let finished = false;
    // Removes the request at once, so a second answer to it is not accepted.
    const finish = () => {
      if (finished) {
        return;
      }
      finished = true;
      for (const previous of previousIds) {
        this.recoveryIds.delete(previous);
      }
      this.pending.delete(id);
      this.changed();
    };
    this.pending.set(id, {
      ...input,
      resolve: (value) => {
        finish();
        Deferred.doneUnsafe(answer, Exit.succeed(value));
      },
      reject: (error) => {
        finish();
        Deferred.doneUnsafe(answer, Exit.fail(error));
      },
    });
    this.changed();

    // A lost read can be repeated safely, twice within the deadline. A fresh ID
    // lets the addon's deduplication distinguish recovery from a retransmitted action.
    const resend = Effect.sync(() => {
      const request = this.pending.get(id);
      if (!request) {
        return;
      }
      this.pending.delete(id);
      previousIds.push(id);
      id = randomUUID();
      for (const previous of previousIds) {
        this.recoveryIds.set(previous, id);
      }
      this.pending.set(id, request);
      this.changed();
    });
    const recovery =
      !input.action && (input.sections || input.inspection)
        ? Effect.forEach([1, 2], () => Effect.sleep(timeout / 3).pipe(Effect.andThen(resend)), {
            discard: true,
          })
        : Effect.void;
    const timedOut = Effect.suspend(() => {
      const timedOutAt = this.now();
      this.unresponsiveSince = timedOutAt;
      this.onTimeout({
        kind: input.action ? 'action' : input.inspection ? 'inspection' : 'state',
        addonSilent: this.lastHeardAt <= startedAt,
        waitedMs: timedOutAt - startedAt,
      });
      // Remember every ID this request used, so a late answer proves WoW recovered.
      for (const timedOutId of [id, ...previousIds]) {
        this.timedOut.set(timedOutId, { session: input.session, chat: input.chat });
      }
      for (const oldest of this.timedOut.keys()) {
        if (this.timedOut.size <= 64) break;
        this.timedOut.delete(oldest);
      }
      return Effect.fail(
        new GameRequestFailed({
          reason: 'timeout',
          message: input.agent ? AGENT_TIMEOUT_MESSAGE : TIMEOUT_MESSAGE,
        }),
      );
    });

    const waiting = Effect.gen(function* () {
      yield* Effect.forkScoped(recovery);
      return yield* Deferred.await(answer).pipe(
        Effect.timeoutOrElse({ duration: timeout, orElse: () => timedOut }),
      );
    }).pipe(
      Effect.scoped,
      Effect.raceFirst(cancelled(signal)),
      Effect.ensuring(Effect.sync(finish)),
    );
    return Effect.runPromiseExit(waiting).then((exit) => {
      if (Exit.isSuccess(exit)) {
        return exit.value;
      }
      throw Cause.squash(exit.cause);
    });
  }
  receive(requestId: string, session: string, chat: string | undefined, value: unknown) {
    const request = this.pending.get(this.recoveryIds.get(requestId) || requestId);
    if (request?.session === session && request.chat === chat) {
      this.unresponsiveSince = undefined;
      request.resolve(value);
      return true;
    }
    // A valid answer to a request that already timed out: its promise stays
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
      request.reject(new Error(reason));
    }
  }
  cancelChat(chat: string) {
    for (const request of this.pending.values()) {
      if (request.chat === chat) {
        request.reject(new Error('Conversation deleted'));
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
