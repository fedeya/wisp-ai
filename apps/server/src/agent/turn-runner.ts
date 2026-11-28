import { applyEvent, type Chat } from '../chat/events.ts';
import { ReplyProjection } from '../reply/reply-stream.ts';
import type { ReplyPresentation } from '@wisp/agent/contract/reply-presentation';
import { endSession, sendChatTurn, type AgentEngine } from './agent-session.ts';
import { beginTurn, settleTurn } from '../chat/chat-lifecycle.ts';
import { turnInput, characterIdentity, rememberTurnQuests } from '../chat/context.ts';
import { chooseChatModel, resolveDefaultModel } from '../chat/chat-model.ts';
import { generateConversationTitle } from '../chat/conversation-title.ts';
import { ChatGPTAuthError } from '../auth/index.ts';
import { safeErrorMessage } from '@wisp/agent/contract/model-errors';
import { errorMessage } from '../errors.ts';
import { Effect } from 'effect';
import type { CapabilitySettings } from '../integrations/capabilities.ts';
import type { ModelCatalog } from '../models/model-connections.ts';
import type { ModelFailures } from '../models/model-failures.ts';
import type { ChatErrorCode, ChatMode, ChatOutcome, TurnUsage } from '#/telemetry';

/**
 * What the turn runner records. `runtime.ts` adapts `UsageTelemetry` to it;
 * remove it when the runner migrates and takes the service.
 */
export interface TurnTelemetry {
  chat(
    mode: ChatMode,
    outcome: ChatOutcome,
    duration: number,
    errorCode?: ChatErrorCode,
    firstTextMs?: number,
    usage?: TurnUsage,
    details?: { provider?: string | undefined; failureKind?: string | undefined },
  ): void;
  toolObserver(): (event: unknown) => void;
  usageObserver(): { observe(event: unknown): void; usage(): TurnUsage };
}

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

/** Nothing can answer: the player skipped connecting an AI provider. */
class NoProviderError extends Error {
  constructor() {
    super(
      'No AI is connected to Wisp yet. Open the Wisp app and connect ChatGPT or an API key, then send your message again.',
    );
    this.name = 'NoProviderError';
  }
}

/**
 * How long an admitted turn may receive nothing from the engine before it
 * fails. Tools are bounded well below this (simulations 45 s, page reads
 * 120 s) and long reasoning still streams, so silence this long means
 * the engine or its provider stopped answering without closing the stream.
 */
export const TURN_IDLE_TIMEOUT_MS = 10 * 60_000;

/** The engine stopped sending events for a running turn. */
class TurnStalledError extends Error {
  constructor(idleMs: number) {
    super(
      `Wisp received nothing from the AI for ${Math.round(idleMs / 60_000) || 1} minutes and stopped waiting. Please try again.`,
    );
    // Classified as a timeout by isTimeout() and in telemetry.
    this.name = 'TimeoutError';
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

interface TurnDependencies {
  telemetry?: TurnTelemetry;
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
  flushSnapshot?: () => void;
  /** How long an admitted turn may go without engine activity; defaults to `TURN_IDLE_TIMEOUT_MS`. */
  idleTimeoutMs?: number;
}
export const createTurnRunner = Effect.fnUntraced(function* (deps: TurnDependencies) {
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
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
  } = deps;
  const idleTimeoutMs = deps.idleTimeoutMs ?? TURN_IDLE_TIMEOUT_MS;
  const generations = new WeakMap<Chat, symbol>();
  const running = new Set<Promise<void>>();
  const controllers = new WeakMap<Chat, AbortController>();
  const cancelled = new WeakSet<Chat>();
  const projections = new WeakMap<
    Chat,
    { parts: ReplyProjection; assertCurrent: () => void; signal: AbortSignal; touch: () => void }
  >();
  const naming = new WeakSet<Chat>();
  // Runs beside the turn: a slow or failed title never delays or fails the reply.
  function nameConversation(chat: Chat, text: string, model: string) {
    if (naming.has(chat)) {
      return;
    }
    naming.add(chat);
    const untitled = chat.title;
    const work = generateConversationTitle(
      (instructions, input, signal) => models.complete(model, instructions, input, signal),
      text,
      AbortSignal.timeout(20000),
    )
      .then(
        (title) => {
          // Keep a name the user or agent chose meanwhile, and skip deleted chats.
          if (!title || chat.titleGenerated || chat.title !== untitled || !isCurrent(chat)) {
            return;
          }
          chat.title = title;
          chat.titleGenerated = true;
          changed();
        },
        (error) => {
          runFork(
            Effect.logInfo('Conversation title failed').pipe(
              Effect.annotateLogs({
                event: 'chat.title_failed',
                chat: chat.id,
                error: errorMessage(error),
              }),
            ),
          );
        },
      )
      .finally(() => naming.delete(chat));
    running.add(work);
    void work.finally(() => running.delete(work));
  }
  async function execute(chat: Chat, text: string, messageId?: string, context?: unknown) {
    if (isStopping() || chat.status === 'working') {
      return;
    }
    const controller = new AbortController();
    const started = performance.now();
    const observeTool = deps.telemetry?.toolObserver();
    const turnUsage = deps.telemetry?.usageObserver();
    let outcome: ChatOutcome = 'cancelled';
    let failureCode: ChatErrorCode = 'capability_sync_failed';
    let timedOut = false;
    let usageLimited = false;
    // The provider refused the request itself, such as a history it will not take.
    let rejected = false;
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
    const assertCurrent = () => {
      controller.signal.throwIfAborted();
      if (!ownsTurn() || !isCurrent(chat) || currentTransport() !== owner) {
        throw Error('The conversation was deleted or the character changed.');
      }
    };
    // Once the engine admits the turn, every stream event or presentation call
    // restarts this watchdog. If the engine goes silent without closing the
    // stream, the turn fails as a timeout instead of staying "working" until
    // the player cancels it.
    let stalled: TurnStalledError | undefined;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const touch = () => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        stalled = new TurnStalledError(idleTimeoutMs);
        controller.abort(stalled);
      }, idleTimeoutMs);
      idle.unref?.();
    };
    changed();
    const parts = new ReplyProjection();
    projections.set(chat, { parts, assertCurrent, signal: controller.signal, touch });
    const streaming = setInterval(() => {
      if (
        ownsTurn() &&
        isCurrent(chat) &&
        currentTransport() === owner &&
        parts.flush(chat) &&
        !chat.proactive
      ) {
        changed();
      }
    }, 400);
    try {
      await capabilitySettings.publish();
      if (!isReady()) {
        failureCode = 'engine_not_ready';
        throw new Error('Wisp is still starting. Please try again in a few seconds.');
      }
      if (accountBusy()) {
        failureCode = 'account_busy';
        throw Error('Finish the connection operation first.');
      }
      if (deps.hasProvider && !deps.hasProvider()) {
        failureCode = 'no_provider';
        throw new NoProviderError();
      }
      failureCode = 'model_preparation_failed';
      let chosenModel = chat.modelSettings?.model || defaultModel();
      if (!chosenModel) {
        // The catalog was not loaded yet: start on whatever the providers offer first.
        failureCode = 'model_catalog_failed';
        chosenModel = resolveDefaultModel(undefined, await models.models());
        assertCurrent();
        failureCode = 'model_preparation_failed';
      }
      await models.prepare(chosenModel);
      failureCode = 'model_catalog_failed';
      const available = await models.models();
      assertCurrent();
      chat.modelSettings = chooseChatModel(available, chosenModel, chat.modelSettings?.effort);
      assertCurrent();
      preparedMs = Math.round(performance.now() - started);
      if (
        !chat.titleGenerated &&
        !chat.proactive &&
        !chat.inline &&
        capabilitySettings.enabled('tool:set_conversation_title')
      ) {
        nameConversation(chat, text, chat.modelSettings.model);
      }
      failureCode = 'turn_start_failed';
      const response = sendChatTurn(
        engine,
        chat,
        turnInput(text, context, chat, capabilitySettings.snapshot()),
        controller.signal,
      );
      agentSession = chat.agentSession;
      assertCurrent();
      admittedMs = Math.round(performance.now() - started);
      changed();
      touch();
      for await (const event of response.events) {
        // The engine prepares the turn before its first event.
        failureCode = 'turn_stream_failed';
        touch();
        assertCurrent();
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
      }
      failureCode = 'turn_result_failed';
      const result = await response.result;
      assertCurrent();
      if (chat.proactive) {
        chat.tipSkipped = parts.noTip;
      }
      if (result.status === 'failed') {
        timedOut = isTimeout(result.error);
        usageLimited = isUsageLimit(result.error);
        rejected = result.reason === 'rejected';
        throw new Error(
          safeErrorMessage(result.error?.message || 'The response failed. Please try again.'),
        );
      }
      const status = result.status === 'cancelled' ? 'cancelled' : 'done';
      settleTurn(chat, status);
      outcome = status === 'done' ? 'completed' : status;
      chat.unread = chat.id !== activeChat();
      if (!parts.hasContent && chat.status === 'done' && !chat.proactive) {
        chat.messages.push({ role: 'system', text: 'The turn completed without a text response.' });
      }
    } catch (error) {
      if (!ownsTurn()) {
        return;
      }
      if (cancelled.has(chat) && controller.signal.aborted && stalled === undefined) {
        settleTurn(chat, 'cancelled');
        outcome = 'cancelled';
        parts.flush(chat, Date.now(), true);
        return;
      }
      // A stalled turn is aborted by its watchdog; report the stall, not the
      // abort it caused, and count it as a failure rather than an interruption.
      const failure = stalled ?? error;
      const failed =
        (stalled !== undefined || !controller.signal.aborted) &&
        isCurrent(chat) &&
        currentTransport() === owner;
      settleTurn(chat, failed ? 'error' : 'interrupted');
      if (failed) {
        outcome =
          timedOut || isTimeout(failure) || (failure instanceof Error && isTimeout(failure.cause))
            ? 'timeout'
            : 'failed';
        if (failure instanceof ChatGPTAuthError && failureCode === 'model_preparation_failed') {
          failureCode = 'model_auth_failed';
        }
        if (
          usageLimited ||
          isUsageLimit(failure) ||
          (failure instanceof Error && isUsageLimit(failure.cause))
        ) {
          failureCode = 'usage_limit';
          usageLimitedChats.add(chat);
        }
      }
      parts.flush(chat, Date.now(), true);
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
        text: failure instanceof Error ? failure.message : String(failure),
        // The addon shows this notice in the game's language; `text` is the fallback.
        ...(failure instanceof NoProviderError ? { notice: 'noProvider' as const } : {}),
      });
      const log = failed ? Effect.logError : Effect.logInfo;
      runFork(
        log('Turn failed').pipe(
          Effect.annotateLogs({
            event: 'chat.turn_failed',
            chat: chat.id,
            messageId,
            outcome,
            error: errorMessage(failure),
          }),
        ),
      );
    } finally {
      const model = chat.modelSettings?.model || defaultModel();
      deps.telemetry?.chat(
        chat.routineId ? 'routine' : chat.proactive ? 'tip' : chat.inline ? 'hover' : 'chat',
        outcome,
        performance.now() - started,
        outcome === 'timeout' ? 'timeout' : outcome === 'failed' ? failureCode : undefined,
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
      runFork(
        Effect.logInfo('Turn timing').pipe(
          Effect.annotateLogs({
            event: 'chat.turn_timing',
            chat: chat.id,
            messageId,
            outcome,
            preparedMs,
            admittedMs,
            firstTextMs,
            totalMs: Math.round(performance.now() - started),
          }),
        ),
      );
      clearInterval(streaming);
      clearTimeout(idle);
      if (projections.get(chat)?.parts === parts) {
        projections.delete(chat);
      }
      if (ownsTurn()) {
        chat.lastActivityAt = Date.now();
        if (chat.usage) {
          chat.usage.compacting = false;
        }
        parts.finish();
        if (isCurrent(chat) && currentTransport() === owner) {
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
  }
  function run(chat: Chat, text: string, messageId?: string, context?: unknown) {
    const work = execute(chat, text, messageId, context);
    running.add(work);
    void work.then(
      () => running.delete(work),
      () => running.delete(work),
    );
    return work;
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
});
