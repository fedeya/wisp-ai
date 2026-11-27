import { randomUUID } from 'node:crypto';
import { selectionValues } from '@wisp/agent/contract/ui-schema';
import type { Connection, GameEvent } from '@wisp/wow-bridge';
import { Context, Effect, Layer } from 'effect';
import { endSession } from '../agent/agent-session.ts';
import type { AgentEngine } from '../agent/agent-session.ts';
import type { createTurnRunner } from '../agent/turn-runner.ts';
import { PanelRepository } from '../panels/repository.ts';
import { make as makeReplyAction } from '../game/reply-actions.ts';
import { make as makeModelChange } from '../models/addon-models.ts';
import type { ModelCatalog } from '../models/model-connections.ts';
import type { SessionState } from '../session-state.ts';
import { isWorking, newChat, openChat, promoteChat, settleTurn } from './chat-lifecycle.ts';
import { characterIdentity } from './context.ts';
import { isEmptyDraft, resumeChat } from './sessions.ts';

type TurnRunner = Effect.Success<ReturnType<typeof createTurnRunner>>;
export type RunTurn = (...args: Parameters<TurnRunner>) => ReturnType<TurnRunner>;
export type Turns = Pick<TurnRunner, 'cancel' | 'interrupt'> & { run: RunTurn };
type ConversationPacket = Extract<
  GameEvent,
  {
    type:
      | 'new'
      | 'select'
      | 'delete'
      | 'cancel'
      | 'retry'
      | 'dismiss_tip'
      | 'promote_inline'
      | 'say'
      | 'inline_say';
  }
>;

interface Dependencies {
  state: SessionState;
  engine: Pick<AgentEngine, 'end'>;
  turns: Turns;
  request: Connection['request'];
  enabled: (id: string) => boolean;
  models: Pick<ModelCatalog, 'models'>;
  saveChats: () => void;
  invalidateAddonView: () => void;
}

function make(deps: Dependencies, panels: Pick<PanelRepository['Service'], 'get'>) {
  const { state, engine, turns, saveChats, invalidateAddonView } = deps;
  const find = (id: string | undefined) => state.chats.find((chat) => chat.id === id);
  function create(id: string) {
    const chat = newChat(id, state.activeTransport);
    state.chats.push(chat);
    return chat;
  }
  function publishChanges() {
    saveChats();
    invalidateAddonView();
  }

  function leaveWindow() {
    let interrupted = false;
    for (const chat of state.chats) {
      if (chat.owner === state.activeTransport && isWorking(chat)) {
        turns.interrupt(chat);
        settleTurn(chat, 'interrupted');
        interrupted = true;
      }
    }
    if (interrupted) saveChats();
  }

  function resume(id: string | undefined) {
    const activeChat = resumeChat(state.chats, id)?.id ?? '';
    if (state.activeChat === activeChat) return false;
    state.activeChat = activeChat;
    return true;
  }

  const panelQuestion = Effect.fn('AddonConversations.panelQuestion')(function* (
    packet: Extract<GameEvent, { type: 'panel_ask' }>,
  ) {
    const identity = characterIdentity(packet.context);
    if (!identity) return;
    const panel = yield* panels
      .get(identity, packet.key)
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning(error.message).pipe(
            Effect.annotateLogs({ event: 'addon.panel_read_failed' }),
            Effect.as(undefined),
          ),
        ),
      );
    const node = panel?.ui.find((item) => item.id === packet.nodeId);
    if (
      packet.session !== state.activeTransport ||
      !panel ||
      node?.kind !== 'button' ||
      node.action.kind !== 'ask'
    ) {
      return;
    }
    let values: ReturnType<typeof selectionValues>;
    try {
      values = selectionValues(panel.ui, packet.values);
    } catch {
      return;
    }
    const id = packet.chat || 'panel-' + randomUUID();
    let chat = find(id);
    if (!chat) {
      chat = create(id);
      chat.inline = true;
      chat.title = panel.title;
      chat.titleGenerated = true;
    }
    state.inlineChat = id;
    void turns.run(
      chat,
      node.action.prompt +
        '\n\nPersistent panel: ' +
        panel.id +
        '\nSelected values: ' +
        JSON.stringify(values),
      packet.messageId,
      packet.context,
    );
    publishChanges();
  });

  function handle(packet: ConversationPacket) {
    const chat = find(packet.chat);
    if (packet.type === 'delete') {
      if (chat) turns.interrupt(chat);
      state.deletedChatIds.add(packet.chat);
      state.chats = state.chats.filter((candidate) => candidate.id !== packet.chat);
      endSession(engine, chat?.agentSession);
      state.activeChat = resumeChat(state.chats, packet.nextChat)?.id ?? '';
      publishChanges();
      return;
    }
    if (packet.type === 'dismiss_tip') {
      if (chat?.proactive) {
        chat.dismissed = true;
        publishChanges();
      }
      return;
    }
    if (packet.type === 'promote_inline') {
      if (chat?.inline) {
        promoteChat(chat);
        state.activeChat = chat.id;
        state.inlineChat = '';
        publishChanges();
      }
      return;
    }
    if (state.deletedChatIds.has(packet.chat)) {
      if (packet.type !== 'inline_say') invalidateAddonView();
      return;
    }
    if (packet.type === 'inline_say') {
      const inline = chat ?? create(packet.chat);
      if (!chat) {
        inline.inline = true;
        inline.title = 'Quick question';
        inline.titleGenerated = true;
      }
      if (!inline.inline) return;
      state.inlineChat = inline.id;
      void turns.run(inline, packet.text, packet.messageId, packet.context);
      publishChanges();
      return;
    }

    switch (packet.type) {
      case 'new':
      case 'say':
      case 'select': {
        state.chats = state.chats.filter(
          (candidate) => candidate.id === packet.chat || !isEmptyDraft(candidate),
        );
        state.activeChat = packet.chat;
        if (packet.type === 'select') {
          if (chat && chat.status !== 'working') openChat(chat);
        } else {
          const selected = chat ?? create(packet.chat);
          if (packet.type === 'say') {
            if (selected.routineId && selected.status !== 'working') {
              selected.proactive = false;
              selected.dismissed = true;
            }
            void turns.run(selected, packet.text, packet.messageId, packet.context);
          }
        }
        publishChanges();
        break;
      }
      case 'retry': {
        const message = chat?.messages.findLast((entry) => entry.role === 'user');
        if (chat?.status === 'error' && message?.id) {
          void turns.run(chat, message.text, message.id, packet.context);
        }
        break;
      }
      case 'cancel':
        if (chat) turns.cancel(chat);
        break;
    }
  }

  const changeModel = makeModelChange({
    state,
    models: deps.models,
    findChat: find,
    createChat: create,
    saveChats,
    invalidateAddonView,
  });
  const replyAction = makeReplyAction({
    state,
    request: deps.request,
    enabled: deps.enabled,
    run: turns.run,
    saveChats,
    invalidateAddonView,
  });
  return { handle, panelQuestion, leaveWindow, resume, changeModel, replyAction };
}

export class Service extends Context.Service<Service, ReturnType<typeof make>>()(
  '@wisp/server/chat/AddonConversations',
) {}

export const layer = (deps: Dependencies) =>
  Layer.effect(
    Service,
    Effect.map(PanelRepository, (panels) => Service.of(make(deps, panels))),
  );
