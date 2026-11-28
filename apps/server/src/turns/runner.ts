// @effect-migrated allow=effectPromises: the agent engine settles a turn's result and ReplyProjection accepts a presentation with Promises, and apps/agent and reply/ stay as they are in this change
import {
  Cause,
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FiberHandle,
  FiberMap,
  FiberSet,
  Option,
  Predicate,
  Schedule,
  Schema,
  Scope,
  Stream,
} from 'effect';
import type { Latch } from 'effect';
import { safeErrorMessage } from '@wisp/agent/contract/model-errors';
import type { ReplyPresentation } from '@wisp/agent/contract/reply-presentation';
import { ChatGPTAuthError, ChatGPTRequestError } from '#/auth';
import { CapabilitySettings } from '#/capabilities';
import { SessionState } from '#/session';
import { UsageTelemetry } from '#/telemetry';
import type { ChatErrorCode, ChatMode, ChatOutcome } from '#/telemetry';
import { endSession, sendChatTurn } from '../agent/agent-session.ts';
import type { AgentEngine } from '../agent/agent-session.ts';
import { beginTurn, settleTurn } from '../chat/chat-lifecycle.ts';
import { chooseChatModel, resolveDefaultModel } from '../chat/chat-model.ts';
import { characterIdentity, rememberTurnQuests, turnInput } from '../chat/context.ts';
import {
  TITLE_INSTRUCTIONS,
  titleFromCompletion,
  titleRequest,
} from '../chat/conversation-title.ts';
import { applyEvent } from '../chat/events.ts';
import type { Chat } from '../chat/events.ts';
import { errorMessage } from '../errors.ts';
import { SnapshotPublisher } from '../game/snapshot-publisher.ts';
import { ModelConnections } from '../models/connections.ts';
import type { ModelFailures } from '../models/model-failures.ts';
import { ReplyProjection } from '../reply/reply-stream.ts';

/**
 * How long an admitted turn may receive nothing from the engine before it
 * fails. Tools are bounded well below this (simulations 45 s, page reads
 * 120 s) and long reasoning still streams, so silence this long means
 * the engine or its provider stopped answering without closing the stream.
 */
const TURN_IDLE_TIMEOUT = Duration.minutes(10);

/** How often a running turn publishes the reply previews it coalesced. */
const STREAM_FLUSH_INTERVAL = Duration.millis(400);

/** How long a conversation title may take before it is given up. */
const TITLE_TIMEOUT = Duration.seconds(20);

/**
 * What an interrupted turn tells the player and the logs: the reason an
 * aborted signal carries when it is given none, as the turn reported it
 * when interrupting it aborted the signal.
 */
const INTERRUPTED_MESSAGE = 'This operation was aborted';

/** Why a title that ran out of time failed, as `fetch` words a passed deadline. */
const TITLE_TIMED_OUT_MESSAGE = 'The operation was aborted due to timeout';

/** Wisp cannot start the turn now: the engine is loading or an account operation runs. */
class TurnUnavailable extends Schema.TaggedError<TurnUnavailable>()('TurnUnavailable', {
  message: Schema.String,
}) {}

/** Nothing can answer: the player skipped connecting an AI provider. */
class NoProvider extends Schema.TaggedError<NoProvider>()('NoProvider', {
  message: Schema.String,
}) {}

/** The conversation was deleted or the game session changed while the turn ran. */
class TurnNotCurrent extends Schema.TaggedError<TurnNotCurrent>()('TurnNotCurrent', {
  message: Schema.String,
}) {}

/** The turn was interrupted before it settled. */
class TurnInterrupted extends Schema.TaggedError<TurnInterrupted>()('TurnInterrupted', {
  message: Schema.String,
}) {}

/** The engine stopped sending events for a running turn. Reported as a timeout. */
class TurnStalled extends Schema.TaggedError<TurnStalled>()('TurnStalled', {
  message: Schema.String,
}) {}

/** The engine settled the turn as failed. */
class TurnResultFailed extends Schema.TaggedError<TurnResultFailed>()('TurnResultFailed', {
  message: Schema.String,
  /** The engine's error was a timeout. */
  timedOut: Schema.Boolean,
  /** The engine's error was a plan quota or a provider rate limit. */
  usageLimited: Schema.Boolean,
  /** The provider refused the request itself, such as a history it will not take. */
  rejected: Schema.Boolean,
}) {}

/** The engine's event stream failed with `cause`. */
class EngineStreamFailed extends Schema.TaggedError<EngineStreamFailed>()('EngineStreamFailed', {
  cause: Schema.Defect(),
}) {}

/** The conversation title took longer than `TITLE_TIMEOUT`. */
class TitleTimedOut extends Schema.TaggedError<TitleTimedOut>()('TitleTimedOut', {
  message: Schema.String,
}) {}

/** A presentation the agent sent was not accepted; `message` tells the model why. */
export class PresentationFailed extends Schema.TaggedError<PresentationFailed>()(
  'PresentationFailed',
  { message: Schema.String },
) {}

const notCurrent = new TurnNotCurrent({
  message: 'The conversation was deleted or the character changed.',
});

function isTimeout(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if ('name' in error && error.name === 'TimeoutError') return true;
  return (
    'code' in error &&
    (error.code === 'ETIMEDOUT' ||
      error.code === 'UND_ERR_CONNECT_TIMEOUT' ||
      error.code === 'UND_ERR_HEADERS_TIMEOUT' ||
      error.code === 'UND_ERR_BODY_TIMEOUT')
  );
}

// Plan quotas and provider rate limits are expected account states, not Wisp failures.
function isUsageLimit(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = 'code' in error && typeof error.code === 'string' ? error.code : '';
  const message = 'message' in error && typeof error.message === 'string' ? error.message : '';
  return (
    /usage_limit|insufficient_quota|rate_limit/i.test(code) ||
    /usage limit|rate limit|quota/i.test(message)
  );
}

/** What a failure says to the player. */
const failureText = (failure: unknown) =>
  Predicate.isError(failure) ? failure.message : String(failure);

/**
 * What failed a turn: for a ChatGPT request or the engine's stream, what
 * they failed with (the turn has always classified and shown that), and a
 * helper that threw like any other failure.
 */
const failureOf = <E>(cause: Cause.Cause<E>): unknown => {
  const failure = Cause.squash(cause);
  return failure instanceof EngineStreamFailed || failure instanceof ChatGPTRequestError
    ? failure.cause
    : failure;
};

/** A turn to run: the player's text on a chat, and the game state sent with it. */
export interface TurnRequest {
  readonly chat: Chat;
  readonly text: string;
  /** The id of the player's message; a retry passes the failed one's. */
  readonly messageId?: string | undefined;
  /** The game state the addon sent with the message. */
  readonly context?: unknown;
}

/**
 * Runs the agent's turns on the chats of `SessionState`, one at a time per
 * chat, each in a fiber of its own. Interrupting a turn interrupts its fiber.
 */
export class TurnRunner extends Context.Service<
  TurnRunner,
  {
    /**
     * Starts a turn on the chat and returns once it has begun: the chat is
     * `working` and the subscribers were told. Does nothing while the chat
     * has a turn running or Wisp is stopping.
     */
    readonly start: (turn: TurnRequest) => Effect.Effect<void>;
    /** Starts a turn like `start` and waits until it settles. */
    readonly run: (turn: TurnRequest) => Effect.Effect<void>;
    /** Accepts a presentation that the running turn's reply asked for, or says why not. */
    readonly present: (
      chat: Chat,
      callId: string,
      input: ReplyPresentation,
    ) => Effect.Effect<ReplyPresentation, PresentationFailed>;
    /** Interrupts the chat's turn, which settles as interrupted, and waits for it. */
    readonly interrupt: (chat: Chat) => Effect.Effect<void>;
    /** Stops a turn the player cancelled; it settles as cancelled, not interrupted. */
    readonly cancel: (chat: Chat) => Effect.Effect<void>;
    /** Whether a turn could start now: the engine has loaded and Wisp is not stopping. */
    readonly accepting: Effect.Effect<boolean>;
    /**
     * Whether the chat's latest turn failed on a plan or provider usage
     * limit, as classified from error codes and causes, not from the
     * displayed message.
     */
    readonly endedOnUsageLimit: (chat: Chat) => Effect.Effect<boolean>;
  }
>()('@wisp/server/turns/TurnRunner') {}

export interface TurnRunnerOptions {
  /** The agent engine the turns run on. */
  readonly engine: AgentEngine;
  /** Opens once the engine has loaded; a turn before that fails as `engine_not_ready`. */
  readonly ready: Latch.Latch;
  /** Opens when Wisp starts stopping; no turn starts after that. */
  readonly stopping: Latch.Latch;
  /** The model a chat without a model of its own starts on. */
  readonly defaultModel: Effect.Effect<string>;
  /** Whether an account operation is running, which a turn must not start during. */
  readonly accountBusy: Effect.Effect<boolean>;
  /** Why this turn's proxied model requests failed, as fixed categories. */
  readonly modelFailures: Pick<ModelFailures, 'since'>;
  /** The MCP connections the player added, whose tools telemetry keeps generic. */
  readonly isCustomMcpConnection: (connection: string) => boolean;
  /** How long an admitted turn may go without engine activity; defaults to `TURN_IDLE_TIMEOUT`. */
  readonly idleTimeout?: Duration.Input;
}

/** The running turn of a chat, as presentations and interruptions reach it. */
interface ActiveTurn {
  readonly parts: ReplyProjection;
  /** Aborts when the turn is interrupted or stalls, and once it ended. */
  readonly signal: AbortSignal;
  /** Why the turn was interrupted or stalled, if it was. */
  readonly abortedBecause: () => Option.Option<string>;
  /** Aborts `signal` for `reason`; the turn then settles as interrupted, unless it stalled. */
  readonly abort: (reason: string) => Effect.Effect<void>;
  /** Fails while the turn no longer owns the chat on its game session. */
  readonly assertCurrent: Effect.Effect<void, TurnNotCurrent>;
  /** Restarts the idle watchdog. */
  readonly touch: Effect.Effect<void>;
}

/** Milliseconds since `start`, a `Clock.monotonicTimeNanos` reading. */
const millisSince = (start: bigint) =>
  Effect.map(Clock.monotonicTimeNanos, (now) => Number(now - start) / 1e6);

/**
 * A turn runner whose turns and conversation titles run until the scope
 * closes. Closing it interrupts the turns still running and waits for them
 * and for the titles being generated.
 */
export const make = Effect.fn('TurnRunner.make')(function* (options: TurnRunnerOptions) {
  const session = yield* SessionState;
  const models = yield* ModelConnections;
  const capabilities = yield* CapabilitySettings;
  const telemetry = yield* UsageTelemetry;
  const publisher = yield* SnapshotPublisher;
  const { engine, ready, stopping, defaultModel, accountBusy, modelFailures } = options;
  const idleTimeout = Duration.fromInputUnsafe(options.idleTimeout ?? TURN_IDLE_TIMEOUT);
  const idleMinutes = Math.round(Duration.toMillis(idleTimeout) / 60_000) || 1;

  // Titles run beside the turns: a slow or failed title never delays or fails
  // a reply, and an interrupted turn leaves its title running. Closing waits
  // for them, as it did when titles were awaited with the turns.
  const titles = yield* FiberSet.make<void, never>();
  yield* Effect.addFinalizer(() => FiberSet.awaitEmpty(titles));
  const turns = yield* FiberMap.make<string, void, never>();
  // Turns run with the runner's services and log annotations, not the caller's.
  const runTurn = yield* FiberMap.runtime(turns)<never>();

  const generations = new WeakMap<Chat, symbol>();
  const active = new WeakMap<Chat, ActiveTurn>();
  const cancelled = new WeakSet<Chat>();
  const usageLimited = new WeakSet<Chat>();
  const naming = new WeakSet<Chat>();

  const isCurrent = (chat: Chat) => Effect.map(session.get, ({ chats }) => chats.includes(chat));

  const nameConversation = (chat: Chat, text: string, model: string) =>
    Effect.gen(function* () {
      if (naming.has(chat)) {
        return;
      }
      naming.add(chat);
      const untitled = chat.title;
      const title = models.complete(model, TITLE_INSTRUCTIONS, titleRequest(text)).pipe(
        Effect.timeoutOrElse({
          duration: TITLE_TIMEOUT,
          orElse: () => Effect.fail(new TitleTimedOut({ message: TITLE_TIMED_OUT_MESSAGE })),
        }),
        Effect.map(titleFromCompletion),
        Effect.flatMap((title) =>
          Effect.gen(function* () {
            // Keep a name the user or agent chose meanwhile, and skip deleted chats.
            if (
              !title ||
              chat.titleGenerated ||
              chat.title !== untitled ||
              !(yield* isCurrent(chat))
            ) {
              return;
            }
            chat.title = title;
            chat.titleGenerated = true;
            // The chat was edited in place.
            yield* session.commit;
          }),
        ),
        Effect.catch((error) =>
          Effect.logInfo('Conversation title failed').pipe(
            Effect.annotateLogs({
              event: 'chat.title_failed',
              chat: chat.id,
              error: errorMessage(error),
            }),
          ),
        ),
        Effect.ensuring(Effect.sync(() => naming.delete(chat))),
      );
      yield* FiberSet.run(titles, title);
    });

  /**
   * The turn on `chat`, from `beginTurn` until it settled and told the
   * subscribers. Only the turn's own work can be interrupted, so however it
   * ends, the chat settles and its telemetry is recorded.
   */
  const execute = ({ chat, text, messageId, context }: TurnRequest) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const started = yield* Clock.monotonicTimeNanos;
        // `ModelFailures` stamps failures with `performance.now()`.
        const failuresSince = performance.now();
        const observeTool = yield* telemetry.toolObserver(options.isCustomMcpConnection);
        const turnUsage = yield* telemetry.usageObserver;
        // The engine and the reply projection take an AbortSignal: this one aborts
        // when the turn is interrupted or stalls, and once it ended.
        const signalScope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(signalScope, Exit.void));
        const signal = yield* Effect.abortSignal.pipe(Scope.provide(signalScope));
        // Why the signal aborted, as presentations report it.
        let abortedBecause: string | undefined;
        const abort = (reason: string) =>
          Effect.suspend(() => {
            abortedBecause ??= reason;
            return Scope.close(signalScope, Exit.void);
          });
        let outcome: ChatOutcome = 'cancelled';
        let failureCode: ChatErrorCode = 'capability_sync_failed';
        let preparedMs: number | undefined;
        let admittedMs: number | undefined;
        let firstTextMs: number | undefined;
        // Failure paths clear chat.agentSession before telemetry reads which session failed.
        let agentSession: string | undefined;
        usageLimited.delete(chat);
        cancelled.delete(chat);
        const generation = Symbol();
        generations.set(chat, generation);
        const ownsTurn = () => generations.get(chat) === generation;
        const owner = (yield* session.get).activeTransport;
        beginTurn(chat, owner, characterIdentity(context), text, messageId);
        rememberTurnQuests(chat, context);
        // Still the turn's chat on the game session it started on.
        const current = Effect.map(
          session.get,
          (state) => ownsTurn() && state.chats.includes(chat) && state.activeTransport === owner,
        );
        const assertCurrent = Effect.flatMap(current, (still) =>
          still ? Effect.void : Effect.fail(notCurrent),
        );
        // Once the engine admits the turn, every stream event or presentation
        // call restarts this watchdog. If the engine goes silent without closing
        // the stream, the turn fails as a timeout instead of staying "working"
        // until the player cancels it.
        const stalled = yield* Deferred.make<never, TurnStalled>();
        let stalledWith: TurnStalled | undefined;
        const watchdog = yield* FiberHandle.make<void, never>();
        const stall = Effect.gen(function* () {
          const error = new TurnStalled({
            message: `Wisp received nothing from the AI for ${idleMinutes} minutes and stopped waiting. Please try again.`,
          });
          stalledWith = error;
          yield* abort(error.message);
          yield* Deferred.fail(stalled, error);
        });
        // A presentation can still touch the turn once it ended; that does nothing.
        let ended = false;
        const touch = Effect.suspend(() =>
          ended
            ? Effect.void
            : FiberHandle.run(watchdog, Effect.sleep(idleTimeout).pipe(Effect.andThen(stall))),
        ).pipe(Effect.asVoid);
        // The chat is `working` with the player's message.
        yield* session.commit;
        const parts = new ReplyProjection();
        active.set(chat, {
          parts,
          signal,
          abortedBecause: () => Option.fromNullishOr(abortedBecause),
          abort,
          assertCurrent,
          touch,
        });
        // Coalesced reply previews publish on this tick.
        const streaming = yield* Effect.gen(function* () {
          const state = yield* session.get;
          if (
            ownsTurn() &&
            state.chats.includes(chat) &&
            state.activeTransport === owner &&
            parts.flush(chat) &&
            !chat.proactive
          ) {
            yield* session.commit;
          }
        }).pipe(Effect.schedule(Schedule.windowed(STREAM_FLUSH_INTERVAL)), Effect.forkChild);

        // A visible change of the reply is committed; its first text and
        // presentation progress publish without the coalescing window.
        const receive = (event: unknown) =>
          Effect.gen(function* () {
            // The engine prepares the turn before its first event.
            failureCode = 'turn_stream_failed';
            yield* touch;
            yield* assertCurrent;
            const sourceRevision = parts.sourceRevision;
            const progressRevision = parts.presentationProgressRevision;
            const visibleChanged = applyEvent(chat, event, parts);
            yield* observeTool.observe(event);
            yield* turnUsage.observe(event);
            let flush = false;
            if (visibleChanged && !chat.proactive) {
              const firstText =
                firstTextMs === undefined &&
                [...parts.streams.values()].some((state) => state.reply.view().text);
              if (firstText) {
                firstTextMs = Math.round(yield* millisSince(started));
              }
              flush = firstText || progressRevision !== parts.presentationProgressRevision;
            }
            if (visibleChanged || parts.sourceRevision !== sourceRevision) {
              if (visibleChanged) {
                chat.lastActivityAt = yield* Clock.currentTimeMillis;
              }
              // Source-only deltas need persistence without changing the published view.
              yield* session.commit;
            }
            // After the commit, so the flushed snapshot shows this event.
            if (flush) {
              yield* publisher.flush;
            }
          });

        const body = Effect.gen(function* () {
          yield* capabilities.publish;
          if (!ready.isOpen()) {
            failureCode = 'engine_not_ready';
            return yield* new TurnUnavailable({
              message: 'Wisp is still starting. Please try again in a few seconds.',
            });
          }
          if (yield* accountBusy) {
            failureCode = 'account_busy';
            return yield* new TurnUnavailable({
              message: 'Finish the connection operation first.',
            });
          }
          if (!(yield* models.hasProvider)) {
            failureCode = 'no_provider';
            return yield* new NoProvider({
              message:
                'No AI is connected to Wisp yet. Open the Wisp app and connect ChatGPT or an API key, then send your message again.',
            });
          }
          failureCode = 'model_preparation_failed';
          let chosenModel = chat.modelSettings?.model || (yield* defaultModel);
          if (!chosenModel) {
            // The catalog was not loaded yet: start on whatever the providers offer first.
            failureCode = 'model_catalog_failed';
            chosenModel = resolveDefaultModel(undefined, yield* models.models);
            yield* assertCurrent;
            failureCode = 'model_preparation_failed';
          }
          yield* models.prepare(chosenModel);
          failureCode = 'model_catalog_failed';
          const available = yield* models.models;
          yield* assertCurrent;
          const settings = chooseChatModel(available, chosenModel, chat.modelSettings?.effort);
          chat.modelSettings = settings;
          yield* assertCurrent;
          preparedMs = Math.round(yield* millisSince(started));
          if (
            !chat.titleGenerated &&
            !chat.proactive &&
            !chat.inline &&
            (yield* capabilities.enabled('tool:set_conversation_title'))
          ) {
            yield* nameConversation(chat, text, settings.model);
          }
          failureCode = 'turn_start_failed';
          const response = sendChatTurn(
            engine,
            chat,
            turnInput(text, context, chat, yield* capabilities.snapshot),
            signal,
          );
          agentSession = chat.agentSession;
          yield* assertCurrent;
          admittedMs = Math.round(yield* millisSince(started));
          yield* session.commit;
          yield* touch;
          yield* Stream.fromAsyncIterable(
            response.events,
            (cause) => new EngineStreamFailed({ cause }),
          ).pipe(Stream.runForEach(receive));
          failureCode = 'turn_result_failed';
          // The engine settles the result when its events end; it never rejects.
          const result = yield* Effect.promise(() => response.result);
          yield* assertCurrent;
          if (chat.proactive) {
            chat.tipSkipped = parts.noTip;
          }
          if (result.status === 'failed') {
            return yield* new TurnResultFailed({
              message: safeErrorMessage(
                result.error?.message || 'The response failed. Please try again.',
              ),
              timedOut: isTimeout(result.error),
              usageLimited: isUsageLimit(result.error),
              rejected: result.reason === 'rejected',
            });
          }
          const status = result.status === 'cancelled' ? 'cancelled' : 'done';
          settleTurn(chat, status);
          outcome = status === 'done' ? 'completed' : status;
          chat.unread = chat.id !== (yield* session.get).activeChat;
          if (!parts.hasContent && chat.status === 'done' && !chat.proactive) {
            chat.messages.push({
              role: 'system',
              text: 'The turn completed without a text response.',
            });
          }
        });

        // How a turn that did not complete settles the chat.
        const settleFailure = (cause: Cause.Cause<unknown>) =>
          Effect.gen(function* () {
            if (!ownsTurn()) {
              return;
            }
            // Interrupted by the player, a new game session or shutdown, which
            // aborted the turn's signal first, or stalled. What failed meanwhile is
            // reported, if anything did.
            const aborted = abortedBecause !== undefined || Cause.hasInterrupts(cause);
            if (cancelled.has(chat) && aborted && stalledWith === undefined) {
              settleTurn(chat, 'cancelled');
              outcome = 'cancelled';
              parts.flush(chat, yield* Clock.currentTimeMillis, true);
              return;
            }
            // A stalled turn reports the stall, not the abort it caused, and counts
            // as a failure rather than an interruption.
            const failure =
              stalledWith ??
              (Cause.hasInterruptsOnly(cause)
                ? new TurnInterrupted({ message: INTERRUPTED_MESSAGE })
                : failureOf(cause));
            const state = yield* session.get;
            const failed =
              (stalledWith !== undefined || !aborted) &&
              state.chats.includes(chat) &&
              state.activeTransport === owner;
            settleTurn(chat, failed ? 'error' : 'interrupted');
            let rejected = false;
            if (failed) {
              const timedOut =
                failure instanceof TurnResultFailed
                  ? failure.timedOut
                  : failure instanceof TurnStalled ||
                    isTimeout(failure) ||
                    (Predicate.isError(failure) && isTimeout(failure.cause));
              outcome = timedOut ? 'timeout' : 'failed';
              if (
                failure instanceof ChatGPTAuthError &&
                failureCode === 'model_preparation_failed'
              ) {
                failureCode = 'model_auth_failed';
              }
              if (
                (failure instanceof TurnResultFailed && failure.usageLimited) ||
                isUsageLimit(failure) ||
                (Predicate.isError(failure) && isUsageLimit(failure.cause))
              ) {
                failureCode = 'usage_limit';
                usageLimited.add(chat);
              }
              rejected = failure instanceof TurnResultFailed && failure.rejected;
            }
            parts.flush(chat, yield* Clock.currentTimeMillis, true);
            // The session survives a failed turn: its log keeps the steps that ran and
            // replays unfinished tools as interrupted. Only a request the provider
            // rejected (such as a history it will not take) starts a new session,
            // which begins from the chat's visible messages.
            if (rejected) {
              endSession(engine, chat.agentSession);
              chat.agentSession = undefined;
            }
            chat.messages.push({
              role: 'system',
              text: failureText(failure),
              // The addon shows this notice in the game's language; `text` is the fallback.
              ...(failure instanceof NoProvider ? { notice: 'noProvider' as const } : {}),
            });
            yield* (failed ? Effect.logError : Effect.logInfo)('Turn failed').pipe(
              Effect.annotateLogs({
                event: 'chat.turn_failed',
                chat: chat.id,
                messageId,
                outcome,
                error: errorMessage(failure),
              }),
            );
          });

        // What the turn records and leaves behind however it ended.
        const finish = Effect.gen(function* () {
          const model = chat.modelSettings?.model || (yield* defaultModel);
          const mode: ChatMode = chat.routineId
            ? 'routine'
            : chat.proactive
              ? 'tip'
              : chat.inline
                ? 'hover'
                : 'chat';
          yield* telemetry.chat({
            mode,
            outcome,
            duration: yield* millisSince(started),
            errorCode:
              outcome === 'timeout' ? 'timeout' : outcome === 'failed' ? failureCode : undefined,
            firstTextMs,
            usage: yield* turnUsage.usage,
            ...(model
              ? {
                  provider: yield* models.provider(model),
                  failureKind:
                    outcome === 'failed' || outcome === 'timeout'
                      ? modelFailures.since(agentSession, failuresSince)
                      : undefined,
                }
              : {}),
          });
          yield* Effect.logInfo('Turn timing').pipe(
            Effect.annotateLogs({
              event: 'chat.turn_timing',
              chat: chat.id,
              messageId,
              outcome,
              preparedMs,
              admittedMs,
              firstTextMs,
              totalMs: Math.round(yield* millisSince(started)),
            }),
          );
          yield* Fiber.interrupt(streaming);
          ended = true;
          yield* FiberHandle.clear(watchdog);
          if (active.get(chat)?.parts === parts) {
            active.delete(chat);
          }
          if (ownsTurn()) {
            const now = yield* Clock.currentTimeMillis;
            chat.lastActivityAt = now;
            if (chat.usage) {
              chat.usage.compacting = false;
            }
            parts.finish();
            if (yield* current) {
              parts.flush(chat, now, true);
            }
            if (chat.proactive && chat.status === 'done') {
              chat.tipSkipped ||= !chat.messages.some(
                (m) => m.role === 'assistant' && (m.text.trim() || m.ui?.length),
              );
            }
            // The chat was edited in place.
            yield* session.commit;
          }
        });

        const exit = yield* Effect.exit(
          restore(Effect.raceFirst(body, Deferred.await(stalled))).pipe(
            // Interrupting the turn aborts what the engine and the projection run for it.
            Effect.onInterrupt(() => abort(INTERRUPTED_MESSAGE)),
          ),
        );
        if (Exit.isFailure(exit)) {
          yield* settleFailure(exit.cause);
        }
        yield* finish;
      }),
    ).pipe(Effect.scoped);

  /** Starts the turn unless Wisp is stopping or the chat has one running. */
  const begin = (turn: TurnRequest) =>
    Effect.sync(() =>
      stopping.isOpen() || turn.chat.status === 'working'
        ? Option.none()
        : Option.some(runTurn(turn.chat.id, execute(turn))),
    );

  const present = Effect.fn('TurnRunner.present')(function* (
    chat: Chat,
    callId: string,
    input: ReplyPresentation,
  ) {
    const turn = active.get(chat);
    if (!turn) {
      return yield* new PresentationFailed({ message: 'This reply is no longer active.' });
    }
    const check = Effect.gen(function* () {
      const aborted = turn.abortedBecause();
      if (Option.isSome(aborted)) {
        return yield* new PresentationFailed({ message: aborted.value });
      }
      yield* turn.assertCurrent.pipe(
        Effect.mapError(({ message }) => new PresentationFailed({ message })),
      );
      yield* turn.touch;
    });
    yield* check;
    const value = yield* Effect.tryPromise({
      // Interrupting the call, as a hang-up does, aborts its signal.
      try: (signal) =>
        turn.parts.acceptPresentation(callId, input, AbortSignal.any([signal, turn.signal])),
      // A turn that was interrupted or stalled reports why, as its signal's reason did.
      catch: (error) =>
        new PresentationFailed({
          message: Option.getOrElse(turn.abortedBecause(), () => failureText(error)),
        }),
    });
    yield* check;
    return value;
  });

  // The turn's signal aborts first, so the turn settles as interrupted even
  // when what it was waiting for fails as the interruption arrives.
  const interrupt = Effect.fn('TurnRunner.interrupt')(function* (chat: Chat) {
    const turn = active.get(chat);
    if (turn) {
      yield* turn.abort(INTERRUPTED_MESSAGE);
    }
    yield* FiberMap.remove(turns, chat.id);
  });

  const cancel = Effect.fn('TurnRunner.cancel')(function* (chat: Chat) {
    const turn = active.get(chat);
    if (turn && Option.isNone(turn.abortedBecause())) {
      cancelled.add(chat);
      yield* interrupt(chat);
    }
  });

  return TurnRunner.of({
    start: (turn) => Effect.asVoid(begin(turn)),
    run: (turn) =>
      begin(turn).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (fiber) => Effect.asVoid(Fiber.await(fiber)),
          }),
        ),
      ),
    present,
    interrupt,
    cancel,
    accepting: Effect.sync(() => ready.isOpen() && !stopping.isOpen()),
    endedOnUsageLimit: (chat) => Effect.sync(() => usageLimited.has(chat)),
  });
});
