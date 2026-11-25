import { Cause, Effect, Exit, Schedule, Schema, Stream } from 'effect';
import { applyEvent, type Chat } from '../chat/events.ts';
import { ReplyProjection } from '../reply/reply-stream.ts';
import type { ReplyPresentation } from '@wisp/protocol/reply-presentation';
import { endSession, sendChatTurn, type AgentEngine } from './agent-session.ts';
import { beginTurn, settleTurn } from '../chat/chat-lifecycle.ts';
import { turnInput, characterIdentity, rememberTurnQuests } from '../chat/context.ts';
import { chooseChatModel, resolveDefaultModel } from '../chat/chat-model.ts';
import { generateConversationTitle } from '../chat/conversation-title.ts';
import { ChatGPTAuthError } from '../auth/chatgpt-auth.ts';
import { safeErrorMessage } from '@wisp/protocol/model-errors';
import { errorMessage } from '../errors.ts';
import type { Logger } from '../logger.ts';
import type { CapabilitySettings } from '../integrations/capabilities.ts';
import type { ModelCatalog } from '../models/model-connections.ts';
import type { ModelFailures } from '../models/model-failures.ts';
import type { ChatErrorCode, ChatOutcome, UsageTelemetry } from '../telemetry.ts';

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

/**
 * How long an admitted turn may receive nothing from the engine before it
 * fails. Tools are bounded well below this (simulations 45 s, page reads
 * 120 s) and long reasoning still streams, so silence this long means
 * the engine or its provider stopped answering without closing the stream.
 */
export const TURN_IDLE_TIMEOUT_MS = 10 * 60_000;

// Why a turn did not complete. Each failure names the stage it stopped at, so
// telemetry reads its code from the error instead of from a variable tracking
// the stage.

/** Wisp itself cannot take a turn yet. */
class TurnRefused extends Schema.TaggedError<TurnRefused>()('TurnRefused', {
  code: Schema.Literals(['engine_not_ready', 'account_busy']),
  message: Schema.String,
}) {}

/** Nothing can answer: the player skipped connecting an AI provider. */
class NoProvider extends Schema.TaggedError<NoProvider>()('NoProvider', {
  message: Schema.String,
}) {}

/** A stage threw; `cause` is what it threw, shown to the player as is. */
class StageFailed extends Schema.TaggedError<StageFailed>()('StageFailed', {
  code: Schema.Literals([
    'capability_sync_failed',
    'model_preparation_failed',
    'model_catalog_failed',
    'turn_start_failed',
    'turn_stream_failed',
  ]),
  cause: Schema.Defect(),
}) {}

/** The engine finished the turn as failed. */
class TurnResultFailed extends Schema.TaggedError<TurnResultFailed>()('TurnResultFailed', {
  error: Schema.Defect(),
}) {}

/** The engine stopped sending events for a running turn. */
class TurnStalled extends Schema.TaggedError<TurnStalled>()('TurnStalled', {
  idleMs: Schema.Number,
}) {}

/** The chat was deleted or its character changed while the turn ran. */
class NoLongerCurrent extends Schema.TaggedError<NoLongerCurrent>()('NoLongerCurrent', {}) {}

type TurnFailure =
  | TurnRefused
  | NoProvider
  | StageFailed
  | TurnResultFailed
  | TurnStalled
  | NoLongerCurrent;

const NO_PROVIDER_MESSAGE =
  'No AI is connected to Wisp yet. Open the Wisp app and connect ChatGPT or an API key, then send your message again.';

/** What the player reads, and what failed underneath, for one failure. */
function describe(failure: TurnFailure): { text: string; underlying: unknown } {
  switch (failure._tag) {
    case 'TurnRefused':
    case 'NoProvider':
      return { text: failure.message, underlying: failure };
    case 'StageFailed':
      return {
        text: failure.cause instanceof Error ? failure.cause.message : String(failure.cause),
        underlying: failure.cause,
      };
    case 'TurnResultFailed': {
      const error = failure.error as { message?: string } | undefined;
      return {
        text: safeErrorMessage(error?.message || 'The response failed. Please try again.'),
        underlying: failure.error,
      };
    }
    case 'TurnStalled':
      return {
        text: `Wisp received nothing from the AI for ${Math.round(failure.idleMs / 60_000) || 1} minutes and stopped waiting. Please try again.`,
        underlying: failure,
      };
    case 'NoLongerCurrent':
      return {
        text: 'The conversation was deleted or the character changed.',
        underlying: failure,
      };
  }
}

function failureCode(failure: TurnFailure): ChatErrorCode {
  switch (failure._tag) {
    case 'TurnRefused':
    case 'StageFailed':
      return failure.code;
    case 'NoProvider':
      return 'no_provider';
    case 'TurnResultFailed':
      return 'turn_result_failed';
    case 'TurnStalled':
      return 'timeout';
    case 'NoLongerCurrent':
      return 'unknown';
  }
}

// Plan quotas and provider rate limits are expected account states, not Wisp failures.
// Chats whose latest turn failed on a plan or provider usage limit, as
// classified from error codes and causes, not from the displayed message.
const usageLimitedChats = new WeakSet<Chat>();
export function endedOnUsageLimit(chat: Chat) {
  return usageLimitedChats.has(chat);
}
function isUsageLimit(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = 'code' in error && typeof error.code === 'string' ? error.code : '';
  const message = 'message' in error && typeof error.message === 'string' ? error.message : '';
  return (
    /usage_limit|insufficient_quota|rate_limit/i.test(code) ||
    /usage limit|rate limit|quota/i.test(message)
  );
}
const causeOf = (error: unknown) => (error instanceof Error ? error.cause : undefined);

interface TurnDependencies {
  telemetry?: Pick<UsageTelemetry, 'chat' | 'toolObserver' | 'usageObserver'>;
  engine: AgentEngine;
  models: ModelCatalog;
  capabilitySettings: Pick<CapabilitySettings, 'publish' | 'enabled' | 'snapshot'>;
  currentTransport: () => string;
  activeChat: () => string;
  defaultModel: () => string;
  isReady: () => boolean;
  isStopping: () => boolean;
  accountBusy: () => boolean;
  /** Why this turn's proxied model requests failed, as fixed categories. */
  modelFailures?: Pick<ModelFailures, 'since'>;
  /** Who answers a model id (for example `anthropic` or `chatgpt`), never the id itself. */
  modelProvider?: (model: string) => string | undefined;
  /** Whether any provider could answer. Omitted means yes. */
  hasProvider?: () => boolean;
  isCurrent: (chat: Chat) => boolean;
  changed: () => void;
  logger: Pick<Logger, 'info' | 'error'>;
  flushSnapshot?: () => void;
  /** How long an admitted turn may go without engine activity; defaults to `TURN_IDLE_TIMEOUT_MS`. */
  idleTimeoutMs?: number;
}
export function createTurnRunner(deps: TurnDependencies) {
  const {
    engine,
    models,
    capabilitySettings,
    currentTransport,
    activeChat,
    defaultModel,
    isReady,
    isStopping,
    accountBusy,
    isCurrent,
    changed,
    logger,
  } = deps;
  const idleTimeoutMs = deps.idleTimeoutMs ?? TURN_IDLE_TIMEOUT_MS;
  const generations = new WeakMap<Chat, symbol>();
  const running = new Set<Promise<unknown>>();
  const controllers = new WeakMap<Chat, AbortController>();
  const cancelled = new WeakSet<Chat>();
  const projections = new WeakMap<
    Chat,
    { parts: ReplyProjection; assertCurrent: () => void; signal: AbortSignal; touch: () => void }
  >();
  const naming = new WeakSet<Chat>();

  function track(work: Promise<unknown>) {
    running.add(work);
    void work.finally(() => running.delete(work));
    return work;
  }

  // Runs beside the turn: a slow or failed title never delays or fails the reply.
  function nameConversation(chat: Chat, text: string, model: string) {
    if (naming.has(chat)) {
      return;
    }
    naming.add(chat);
    const untitled = chat.title;
    const naming$ = Effect.tryPromise((signal) =>
      generateConversationTitle(
        (instructions, input, signal) => models.complete(model, instructions, input, signal),
        text,
        signal,
      ),
    ).pipe(
      Effect.timeout('20 seconds'),
      Effect.match({
        onSuccess: (title) => {
          // Keep a name the user or agent chose meanwhile, and skip deleted chats.
          if (!title || chat.titleGenerated || chat.title !== untitled || !isCurrent(chat)) {
            return;
          }
          chat.title = title;
          chat.titleGenerated = true;
          changed();
        },
        onFailure: (error) => {
          logger.info(
            {
              event: 'chat.title_failed',
              chat: chat.id,
              error: errorMessage(error._tag === 'UnknownError' ? error.cause : error),
            },
            'Conversation title failed',
          );
        },
      }),
      Effect.ensuring(Effect.sync(() => naming.delete(chat))),
    );
    track(Effect.runPromise(naming$));
  }

  function execute(chat: Chat, text: string, messageId?: string, context?: unknown) {
    if (isStopping() || chat.status === 'working') {
      return Promise.resolve();
    }
    const controller = new AbortController();
    const started = performance.now();
    const observeTool = deps.telemetry?.toolObserver();
    const turnUsage = deps.telemetry?.usageObserver();
    let preparedMs: number | undefined;
    let admittedMs: number | undefined;
    let firstTextMs: number | undefined;
    // Failure paths clear chat.agentSession before telemetry reads which session failed.
    let agentSession: string | undefined;
    controllers.set(chat, controller);
    usageLimitedChats.delete(chat);
    cancelled.delete(chat);
    const generation = Symbol();
    generations.set(chat, generation);
    const ownsTurn = () => generations.get(chat) === generation;
    const owner = currentTransport();
    beginTurn(chat, owner, characterIdentity(context), text, messageId);
    rememberTurnQuests(chat, context);
    const current = () => ownsTurn() && isCurrent(chat) && currentTransport() === owner;
    // The engine's signal: aborted by a player interrupt, and when the turn's
    // scope closes for any other reason (a stall, a failure).
    const ended = new AbortController();
    const signal = AbortSignal.any([controller.signal, ended.signal]);
    // The last engine event or presentation call. Once the engine admits the
    // turn, a watchdog fails the turn as a timeout when this grows older than
    // the idle timeout, instead of leaving it "working" until the player cancels.
    let lastActivity = Date.now();
    const touch = () => {
      lastActivity = Date.now();
    };
    const assertCurrent = () => {
      signal.throwIfAborted();
      if (!current()) {
        throw Error(describe(new NoLongerCurrent()).text);
      }
    };
    changed();
    const parts = new ReplyProjection();
    projections.set(chat, { parts, assertCurrent, signal, touch });

    const ensureCurrent = Effect.suspend(() =>
      current() ? Effect.void : Effect.fail(new NoLongerCurrent()),
    );
    const attempt = <A>(code: StageFailed['code'], run: () => PromiseLike<A>) =>
      Effect.tryPromise({ try: run, catch: (cause) => new StageFailed({ code, cause }) });
    const attemptSync = <A>(code: StageFailed['code'], run: () => A) =>
      Effect.try({ try: run, catch: (cause) => new StageFailed({ code, cause }) });

    const flushPreview = Effect.sync(() => {
      if (current() && parts.flush(chat) && !chat.proactive) {
        changed();
      }
    });
    const watchdog = Effect.gen(function* () {
      for (;;) {
        const remaining = lastActivity + idleTimeoutMs - Date.now();
        if (remaining <= 0) {
          return yield* new TurnStalled({ idleMs: idleTimeoutMs });
        }
        yield* Effect.sleep(remaining);
      }
    });

    const project = (event: Parameters<typeof applyEvent>[1]) =>
      Effect.gen(function* () {
        touch();
        yield* ensureCurrent;
        yield* attemptSync('turn_stream_failed', () => {
          const sourceRevision = parts.sourceRevision;
          const progressRevision = parts.presentationProgressRevision;
          const visibleChanged = applyEvent(chat, event, parts);
          observeTool?.(event);
          turnUsage?.observe(event);
          if (visibleChanged && !chat.proactive) {
            const firstText =
              firstTextMs === undefined &&
              [...parts.streams.values()].some((state) => state.reply.view().text);
            if (firstText) {
              firstTextMs = Math.round(performance.now() - started);
            }
            if (firstText || progressRevision !== parts.presentationProgressRevision) {
              deps.flushSnapshot?.();
            }
          }
          if (visibleChanged || parts.sourceRevision !== sourceRevision) {
            if (visibleChanged) {
              chat.lastActivityAt = Date.now();
            }
            // Source-only deltas need persistence without changing the published view.
            changed();
          }
        });
      });

    const turn = Effect.gen(function* () {
      yield* Effect.addFinalizer(() => Effect.sync(() => ended.abort()));
      yield* Effect.forkScoped(Effect.repeat(flushPreview, Schedule.spaced('400 millis')));
      yield* attempt('capability_sync_failed', () => capabilitySettings.publish());
      if (!isReady()) {
        return yield* new TurnRefused({
          code: 'engine_not_ready',
          message: 'Wisp is still starting. Please try again in a few seconds.',
        });
      }
      if (accountBusy()) {
        return yield* new TurnRefused({
          code: 'account_busy',
          message: 'Finish the connection operation first.',
        });
      }
      if (deps.hasProvider && !deps.hasProvider()) {
        return yield* new NoProvider({ message: NO_PROVIDER_MESSAGE });
      }
      let chosenModel = chat.modelSettings?.model || defaultModel();
      if (!chosenModel) {
        // The catalog was not loaded yet: start on whatever the providers offer first.
        const offered = yield* attempt('model_catalog_failed', () => models.models());
        yield* ensureCurrent;
        chosenModel = yield* attemptSync('model_catalog_failed', () =>
          resolveDefaultModel(undefined, offered),
        );
      }
      const model = chosenModel;
      yield* attempt('model_preparation_failed', () => models.prepare(model));
      const available = yield* attempt('model_catalog_failed', () => models.models());
      yield* ensureCurrent;
      const settings = yield* attemptSync('model_catalog_failed', () =>
        chooseChatModel(available, model, chat.modelSettings?.effort),
      );
      chat.modelSettings = settings;
      yield* ensureCurrent;
      preparedMs = Math.round(performance.now() - started);
      if (
        !chat.titleGenerated &&
        !chat.proactive &&
        !chat.inline &&
        capabilitySettings.enabled('tool:set_conversation_title')
      ) {
        nameConversation(chat, text, settings.model);
      }
      const response = yield* attemptSync('turn_start_failed', () =>
        sendChatTurn(
          engine,
          chat,
          turnInput(text, context, chat, capabilitySettings.snapshot()),
          signal,
        ),
      );
      agentSession = chat.agentSession;
      yield* ensureCurrent;
      admittedMs = Math.round(performance.now() - started);
      changed();
      touch();
      // The engine prepares the turn before its first event: a stream that
      // fails before any event failed to start.
      let started$ = false;
      const result = yield* Stream.fromAsyncIterable(
        response.events,
        (cause) =>
          new StageFailed({ code: started$ ? 'turn_stream_failed' : 'turn_start_failed', cause }),
      ).pipe(
        Stream.tap(() => Effect.sync(() => (started$ = true))),
        Stream.runForEach(project),
        Effect.andThen(Effect.promise(() => response.result)),
        Effect.raceFirst(watchdog),
      );
      yield* ensureCurrent;
      if (chat.proactive) {
        chat.tipSkipped = parts.noTip;
      }
      if (result.status === 'failed') {
        return yield* new TurnResultFailed({ error: result.error });
      }
      const status = result.status === 'cancelled' ? 'cancelled' : 'done';
      settleTurn(chat, status);
      chat.unread = chat.id !== activeChat();
      if (!parts.hasContent && chat.status === 'done' && !chat.proactive) {
        chat.messages.push({ role: 'system', text: 'The turn completed without a text response.' });
      }
      return status === 'done' ? ('completed' as const) : status;
    });

    // Settles a turn that did not complete and says how it ended.
    function settleFailure(cause: Cause.Cause<TurnFailure>): {
      outcome: ChatOutcome;
      code?: ChatErrorCode;
    } {
      const failure = Cause.findErrorOption(cause);
      const stalled = failure._tag === 'Some' && failure.value._tag === 'TurnStalled';
      if (cancelled.has(chat) && controller.signal.aborted && !stalled) {
        settleTurn(chat, 'cancelled');
        parts.flush(chat, Date.now(), true);
        return { outcome: 'cancelled' };
      }
      const failed = !controller.signal.aborted && isCurrent(chat) && currentTransport() === owner;
      const { text: notice, underlying } =
        failure._tag === 'Some'
          ? describe(failure.value)
          : Cause.hasInterrupts(cause)
            ? { text: errorMessage(controller.signal.reason), underlying: controller.signal.reason }
            : { text: errorMessage(Cause.squash(cause)), underlying: Cause.squash(cause) };
      settleTurn(chat, failed ? 'error' : 'interrupted');
      let outcome: ChatOutcome = 'cancelled';
      let code: ChatErrorCode = failure._tag === 'Some' ? failureCode(failure.value) : 'unknown';
      if (failed) {
        outcome =
          stalled || isTimeout(underlying) || isTimeout(causeOf(underlying)) ? 'timeout' : 'failed';
        if (underlying instanceof ChatGPTAuthError && code === 'model_preparation_failed') {
          code = 'model_auth_failed';
        }
        if (isUsageLimit(underlying) || isUsageLimit(causeOf(underlying))) {
          code = 'usage_limit';
          usageLimitedChats.add(chat);
        }
      }
      parts.flush(chat, Date.now(), true);
      // A failed turn can leave its history unanswerable; continue in a new session.
      endSession(engine, chat.agentSession);
      chat.agentSession = undefined;
      chat.messages.push({
        role: 'system',
        text: notice,
        // The addon shows this notice in the game's language; `text` is the fallback.
        ...(failure._tag === 'Some' && failure.value._tag === 'NoProvider'
          ? { notice: 'noProvider' as const }
          : {}),
      });
      logger[failed ? 'error' : 'info'](
        {
          event: 'chat.turn_failed',
          chat: chat.id,
          messageId,
          outcome,
          error: errorMessage(underlying),
        },
        'Turn failed',
      );
      return { outcome, code };
    }

    function finish(exit: Exit.Exit<ChatOutcome, TurnFailure>) {
      const { outcome, code } = Exit.isSuccess(exit)
        ? { outcome: exit.value, code: undefined }
        : ownsTurn()
          ? settleFailure(exit.cause)
          : { outcome: 'cancelled' as const, code: undefined };
      const model = chat.modelSettings?.model || defaultModel();
      deps.telemetry?.chat(
        chat.routineId ? 'routine' : chat.proactive ? 'tip' : chat.inline ? 'hover' : 'chat',
        outcome,
        performance.now() - started,
        outcome === 'timeout' ? 'timeout' : outcome === 'failed' ? code : undefined,
        firstTextMs,
        turnUsage?.usage(),
        model
          ? {
              provider: deps.modelProvider?.(model),
              failureKind:
                outcome === 'failed' || outcome === 'timeout'
                  ? deps.modelFailures?.since(agentSession, started)
                  : undefined,
            }
          : {},
      );
      logger.info(
        {
          event: 'chat.turn_timing',
          chat: chat.id,
          messageId,
          outcome,
          preparedMs,
          admittedMs,
          firstTextMs,
          totalMs: Math.round(performance.now() - started),
        },
        'Turn timing',
      );
      if (projections.get(chat)?.parts === parts) {
        projections.delete(chat);
      }
      if (ownsTurn()) {
        chat.lastActivityAt = Date.now();
        if (chat.usage) {
          chat.usage.compacting = false;
        }
        parts.finish();
        if (current()) {
          parts.flush(chat, Date.now(), true);
        }
        if (chat.proactive && chat.status === 'done') {
          chat.tipSkipped ||= !chat.messages.some(
            (m) => m.role === 'assistant' && (m.text.trim() || m.ui?.length),
          );
        }
        changed();
      }
    }

    return Effect.runPromiseExit(
      Effect.scoped(turn).pipe(Effect.onExit((exit) => Effect.sync(() => finish(exit)))),
      { signal: controller.signal },
    ).then(() => undefined);
  }

  function run(chat: Chat, text: string, messageId?: string, context?: unknown) {
    return track(execute(chat, text, messageId, context)) as Promise<void>;
  }
  return Object.assign(run, {
    present: async (chat: Chat, callId: string, input: ReplyPresentation, signal: AbortSignal) => {
      const active = projections.get(chat);
      if (!active) {
        throw Error('This reply is no longer active.');
      }
      active.assertCurrent();
      active.touch();
      const value = await active.parts.acceptPresentation(
        callId,
        input,
        AbortSignal.any([signal, active.signal]),
      );
      active.assertCurrent();
      active.touch();
      return value;
    },
    drain: () => Promise.allSettled(running),
    interrupt: (chat: Chat) => controllers.get(chat)?.abort(),
    /** Stops a turn the player cancelled; it settles as cancelled, not interrupted. */
    cancel: (chat: Chat) => {
      const controller = controllers.get(chat);
      if (controller && !controller.signal.aborted) {
        cancelled.add(chat);
        controller.abort();
      }
    },
  });
}
