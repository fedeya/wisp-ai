import type { Client } from 'eve/client';
import { applyEvent, type Chat } from './events.ts';
import { ReplyProjection } from './reply-stream.ts';
import { sendChatTurn } from './agent-session.ts';
import { beginTurn, settleTurn } from './chat-lifecycle.ts';
import { turnInput, characterIdentity, rememberTurnQuests } from './context.ts';
import { chooseChatModel } from './chat-model.ts';
import { safeErrorMessage } from '@wisp/protocol/model-errors';
import type { CapabilitySettings } from './capabilities.ts';
import type { ModelCatalog } from './model-connections.ts';

interface TurnDependencies {
  client: Pick<Client, 'sessions'>;
  models: ModelCatalog;
  capabilitySettings: Pick<CapabilitySettings, 'publish' | 'enabled' | 'snapshot'>;
  currentTransport: () => string;
  activeChat: () => string;
  defaultModel: () => string;
  isReady: () => boolean;
  isStopping: () => boolean;
  accountBusy: () => boolean;
  isCurrent: (chat: Chat) => boolean;
  changed: () => void;
  log: (message: string) => void;
  flushFirstText?: () => void;
}
export function createTurnRunner(deps: TurnDependencies) {
  const {
    client,
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
    log,
  } = deps;
  const generations = new WeakMap<Chat, symbol>();
  const running = new Set<Promise<void>>();
  const controllers = new WeakMap<Chat, AbortController>();
  async function execute(chat: Chat, text: string, messageId?: string, context?: unknown) {
    if (isStopping() || chat.status === 'working') {
      return;
    }
    const controller = new AbortController();
    const started = performance.now();
    let preparedMs: number | undefined;
    let admittedMs: number | undefined;
    let firstTextMs: number | undefined;
    controllers.set(chat, controller);
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
    changed();
    const parts = new ReplyProjection();
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
        throw new Error('Eve is still starting. Please try again in a few seconds.');
      }
      if (accountBusy()) {
        throw Error('Finish the connection operation first.');
      }
      const chosenModel = chat.modelSettings?.model || defaultModel();
      await models.prepare(chosenModel);
      const available = await models.models();
      assertCurrent();
      chat.modelSettings = chooseChatModel(
        available,
        chat.modelSettings?.model || defaultModel(),
        chat.modelSettings?.effort,
      );
      assertCurrent();
      preparedMs = Math.round(performance.now() - started);
      const response = await sendChatTurn(
        client,
        chat,
        turnInput(
          text,
          context,
          chat,
          capabilitySettings.snapshot(),
          !chat.titleGenerated &&
            !chat.proactive &&
            !chat.inline &&
            capabilitySettings.enabled('tool:set_conversation_title'),
        ),
        controller.signal,
      );
      assertCurrent();
      admittedMs = Math.round(performance.now() - started);
      changed();
      for await (const event of response.stream({ signal: controller.signal })) {
        assertCurrent();
        const sourceRevision = parts.sourceRevision;
        const visibleChanged = applyEvent(chat, event, parts);
        if (visibleChanged && !chat.proactive) {
          if (
            firstTextMs === undefined &&
            [...parts.streams.values()].some((state) => state.reply.view().text)
          ) {
            firstTextMs = Math.round(performance.now() - started);
            deps.flushFirstText?.();
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
      const result = await response.result({ signal: controller.signal });
      assertCurrent();
      if (result.sessionEnded) {
        chat.eveId = undefined;
      }
      if (chat.proactive) {
        chat.tipSkipped = parts.noTip;
      }
      if (result.status === 'failed') {
        throw new Error(
          safeErrorMessage(result.error.message || 'The response failed. Please try again.'),
        );
      }
      settleTurn(
        chat,
        result.status === 'awaiting-input'
          ? 'needs_input'
          : result.status === 'cancelled'
            ? 'cancelled'
            : 'done',
      );
      chat.unread = chat.id !== activeChat();
      if (!parts.hasContent && chat.status === 'done' && !chat.proactive) {
        chat.messages.push({ role: 'system', text: 'The turn completed without a text response.' });
      }
    } catch (error) {
      if (!ownsTurn()) {
        return;
      }
      settleTurn(
        chat,
        !controller.signal.aborted && isCurrent(chat) && currentTransport() === owner
          ? 'error'
          : 'interrupted',
      );
      parts.flush(chat, Date.now(), true);
      chat.eveId = undefined;
      chat.messages.push({
        role: 'system',
        text: error instanceof Error ? error.message : String(error),
      });
      log(
        'Turn failed: ' +
          chat.id +
          ': ' +
          safeErrorMessage(error instanceof Error ? error.message : String(error)),
      );
    } finally {
      log(
        'Turn timing: ' +
          JSON.stringify({
            chat: chat.id,
            messageId,
            preparedMs,
            admittedMs,
            firstTextMs,
            totalMs: Math.round(performance.now() - started),
          }),
      );
      clearInterval(streaming);
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
    drain: () => Promise.allSettled(running),
    interrupt: (chat: Chat) => controllers.get(chat)?.abort(),
  });
}
