import { expectedCharacter } from '@wisp/protocol/character-key';
import type { Connection, GameEvent } from '@wisp/wow-bridge';
import { selectionValues } from '@wisp/agent/contract/ui-schema';
import { routineInput, routineEvent } from '@wisp/protocol/routines';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { MemoryView, SessionState } from '../session-state.ts';
import type { Chat } from '../chat/events.ts';
import type { IntegrationState } from '../integrations/integration-state.ts';
import type { CapabilitySettings } from '../integrations/capabilities.ts';
import type { ModelCatalog } from '../models/model-connections.ts';
import { RoutineStore } from '../routines/routine-store.ts';
import { PanelStore } from '../panels/panel-store.ts';
import { MemoryStore } from '../agent/memory-store.ts';
import {
  characterIdentity,
  characterProfile,
  TurnContextCache,
  type CharacterProfile,
} from '../chat/context.ts';
import { chooseChatModel } from '../chat/chat-model.ts';
import { resumeChat, isEmptyDraft } from '../chat/sessions.ts';
import { newChat, openChat, promoteChat, isWorking, settleTurn } from '../chat/chat-lifecycle.ts';
import { errorMessage } from '../errors.ts';
import type { UsageTelemetry } from '../telemetry.ts';
import { endSession, type AgentEngine } from '../agent/agent-session.ts';
import { Effect } from 'effect';
interface ReceiverDependencies {
  telemetry?: Pick<UsageTelemetry, 'game'>;
  state: SessionState;
  engine: Pick<AgentEngine, 'end'>;
  request: Connection['request'];
  integrationState: IntegrationState;
  capabilitySettings: CapabilitySettings;
  models: Pick<ModelCatalog, 'models'>;
  refreshModelCatalog: () => Promise<void>;
  setCapability: (id: string, enabled: boolean) => Effect.Effect<void, unknown>;
  memorySnapshot: (identity: string | undefined) => Effect.Effect<MemoryView, unknown>;
  run: (chat: Chat, text: string, messageId?: string, context?: unknown) => Promise<void>;
  interrupt: (chat: Chat) => void;
  /** Stops a turn the player cancelled. */
  cancel?: (chat: Chat) => void;
  runtime: string;
  changed: () => void;
  /** Records a character's name and moves its pre-GUID data before the packet is handled. */
  adoptCharacter?: (character: CharacterProfile) => Effect.Effect<void>;
  now?: () => number;
}
export const createPacketReceiver = Effect.fnUntraced(function* (deps: ReceiverDependencies) {
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  const runPromise = Effect.runPromiseWith(context);
  const routineStore = yield* RoutineStore;
  const panelStore = yield* PanelStore;
  const memoryStore = yield* MemoryStore;
  const {
    state,
    engine,
    request,
    integrationState,
    capabilitySettings,
    models,
    refreshModelCatalog,
    setCapability,
    memorySnapshot,
    run,
    interrupt,
    runtime,
    changed,
  } = deps;
  const chatFor = (id: string | undefined) => state.chats.find((chat) => chat.id === id);
  let contextCache = new TurnContextCache();
  let lastDelivery = '';
  const now = deps.now ?? Date.now;
  let activeSeenAt = 0;
  const createChat = (id: string) => {
    const chat = newChat(id, state.activeTransport);
    state.chats.push(chat);
    return chat;
  };
  return Effect.fnUntraced(function* (packet: GameEvent) {
    const receivedAt = now();
    if (state.activeTransport && packet.session === state.activeTransport) {
      activeSeenAt = receivedAt;
    }
    const establishesSession =
      packet.type === 'hello' || (!state.activeTransport && packet.type === 'poll');
    if (!establishesSession && packet.session !== state.activeTransport) {
      return;
    }
    // The bridge has already selected the window that owns the connection.
    const beforeIntegrations = JSON.stringify(capabilitySettings.snapshot());
    const newTransport = establishesSession && state.activeTransport !== packet.session;
    if (newTransport) {
      runFork(
        Effect.logInfo('Game window connected').pipe(
          Effect.annotateLogs({
            event: 'transport.session_changed',
            reason: packet.takeover ? 'takeover' : packet.heartbeat ? 'heartbeat' : packet.type,
            previousIdleMs: state.activeTransport ? receivedAt - activeSeenAt : undefined,
          }),
        ),
      );
      activeSeenAt = receivedAt;
      contextCache = new TurnContextCache();
      lastDelivery = '';
      for (const chat of state.chats.filter(
        (chat) => chat.owner === state.activeTransport && isWorking(chat),
      )) {
        interrupt(chat);
        settleTurn(chat, 'interrupted');
      }
      state.activeTransport = packet.session;
      state.currentCharacterKey = undefined;
      state.inlineChat = '';
      state.panelCommand = undefined;
      state.routineCommand = undefined;
      state.routinePresence = undefined;
      integrationState.reset();
      state.activeChat = resumeChat(state.chats, packet.chat)?.id || '';
      state.memoryView = undefined;
      void refreshModelCatalog();
    }
    packet = { ...packet, context: contextCache.resolve(packet.context) };
    state.questRevision = contextCache.revision;
    state.characterRevision = contextCache.characterRevision;
    if (integrationState.receive(packet.integrations) && integrationState.report) {
      deps.telemetry?.game(integrationState.report.version);
    }
    if (JSON.stringify(capabilitySettings.snapshot()) !== beforeIntegrations) {
      void capabilitySettings.publish().catch((error) =>
        runFork(
          Effect.logWarning('Integration update failed').pipe(
            Effect.annotateLogs({
              event: 'integration.update_failed',
              error: errorMessage(error),
            }),
          ),
        ),
      );
      changed();
    }
    if (packet.heartbeat && !newTransport) {
      return;
    }
    const delivery = packet.transport?.delivery;
    if (delivery && delivery.messageId !== lastDelivery) {
      lastDelivery = delivery.messageId;
      runFork(
        Effect.logInfo('Message delivery').pipe(
          Effect.annotateLogs({ event: 'transport.message_delivery', ...delivery }),
        ),
      );
    }
    if (packet.type === 'model_catalog') {
      void refreshModelCatalog();
      return;
    }
    if (packet.type === 'chat_model_set') {
      const chat =
        chatFor(packet.chat) ||
        (packet.data.inline && !state.deletedChatIds.has(packet.chat)
          ? createChat(packet.chat)
          : undefined);
      if (!chat) {
        return;
      }
      if (packet.data.inline && !chat.messages.length) {
        chat.inline = true;
        chat.title = 'Quick question';
        chat.titleGenerated = true;
        state.inlineChat = chat.id;
      }
      const requestId = packet.requestId;
      void (async () => {
        try {
          if (isWorking(chat)) {
            throw Error('Wait for this reply before changing model settings.');
          }
          const input = packet.data;
          const available = await models.models();
          if (isWorking(chat)) {
            throw Error('Wait for this reply before changing model settings.');
          }
          const selected = chooseChatModel(available, input.model, input.effort);
          // The chat keeps its agent session: the agent replays each message's
          // provider-native data only to the model that wrote it.
          chat.modelSettings = selected;
          chat.modelError = undefined;
          state.modelCatalog = available;
        } catch (error) {
          chat.modelError = errorMessage(error);
        } finally {
          chat.modelRequestId = requestId;
          changed();
        }
      })();
      return;
    }
    if (packet.type === 'inline_status') {
      const data = packet.data;
      if (data?.event === 'first_text') {
        const timing = z
          .object({
            event: z.literal('first_text'),
            messageId: z.string().min(1).max(200),
            totalMs: z.number().finite().nonnegative(),
            afterSendingMs: z.number().finite().nonnegative().optional(),
          })
          .safeParse(data);
        if (timing.success) {
          runFork(
            Effect.logInfo('First text in WoW').pipe(
              Effect.annotateLogs({
                ...timing.data,
                event: 'chat.first_text_in_wow',
                chat: packet.chat,
              }),
            ),
          );
        }
        changed();
        return;
      }
      const status = {
        at: Date.now(),
        event: String(data?.event ?? '').slice(0, 40),
        key: typeof data?.key === 'string' ? data.key.slice(0, 80) : undefined,
        action: typeof data?.action === 'string' ? data.action.slice(0, 120) : undefined,
        panelShown: data?.panelShown === true,
        hasReference: data?.hasReference === true,
        error: typeof data?.error === 'string' ? data.error.slice(0, 300) : undefined,
      };
      void writeFile(
        path.join(runtime, 'inline-status.json'),
        JSON.stringify(status, null, 2),
      ).catch((error) =>
        runFork(
          Effect.logWarning('Inline diagnostic save failed').pipe(
            Effect.annotateLogs({
              event: 'addon.inline_status_save_failed',
              error: errorMessage(error),
            }),
          ),
        ),
      );
      changed();
      return;
    }
    if (packet.context) {
      const character = characterProfile(packet.context);
      if (character) {
        state.currentCharacterKey = character.key;
        if (deps.adoptCharacter) yield* deps.adoptCharacter(character);
      }
    }
    if (packet.type === 'routine_tick' || packet.type === 'routine_event') {
      const identity = characterIdentity(packet.context);
      const data = packet.data;
      if (!identity || Math.abs(Date.now() - packet.at * 1000) > 90000) {
        return;
      }
      state.routinePresence = {
        identity,
        context: packet.context,
        ready: data?.ready === true,
        at: Date.now(),
        session: packet.session,
      };
      if (packet.type === 'routine_event' && capabilitySettings.enabled('tool:manage_routine')) {
        const event = routineEvent.safeParse({ event: data?.event, values: data?.values });
        if (event.success) {
          runFork(
            routineStore.observe(identity, event.data).pipe(
              Effect.andThen(Effect.sync(changed)),
              Effect.catch((error) =>
                Effect.logWarning('Routine event failed').pipe(
                  Effect.annotateLogs({
                    event: 'routine.event_failed',
                    error: errorMessage(error),
                  }),
                ),
              ),
            ),
          );
        }
      }
      return;
    }
    if (packet.type === 'routine_action') {
      const identity = characterIdentity(packet.context);
      const input = routineInput.safeParse(packet.data);
      if (
        identity &&
        input.success &&
        ['pause', 'resume', 'remove'].includes(input.data.operation)
      ) {
        runFork(
          routineStore.mutate(identity, input.data).pipe(
            Effect.andThen(Effect.sync(changed)),
            Effect.catch((error) =>
              Effect.logWarning('Routine action failed').pipe(
                Effect.annotateLogs({ event: 'routine.action_failed', error: errorMessage(error) }),
              ),
            ),
          ),
        );
      }
      return;
    }
    if (packet.type === 'dismiss_tip' && packet.chat) {
      const chat = chatFor(packet.chat);
      if (chat?.proactive) {
        chat.dismissed = true;
        changed();
      }
      return;
    }
    if (packet.type === 'panel_ask' && packet.key && packet.nodeId) {
      const identity = characterIdentity(packet.context),
        panels = identity
          ? yield* panelStore.list(identity).pipe(
              Effect.catch((error) =>
                Effect.logWarning('Panel lookup failed').pipe(
                  Effect.annotateLogs({
                    event: 'panel.lookup_failed',
                    error: errorMessage(error),
                  }),
                  Effect.as([]),
                ),
              ),
            )
          : [],
        panel = panels.find((p) => p.id === packet.key);
      const node = panel?.ui.find((n) => n.id === packet.nodeId);
      if (!panel || node?.kind !== 'button' || node.action.kind !== 'ask') {
        return;
      }
      let values: ReturnType<typeof selectionValues>;
      try {
        values = selectionValues(panel.ui, packet.values);
      } catch {
        return;
      }
      const id = packet.chat || 'panel-' + randomUUID();
      let chat = chatFor(id);
      if (!chat) {
        chat = createChat(id);
        chat.inline = true;
        chat.title = panel.title;
        chat.titleGenerated = true;
      }
      state.inlineChat = id;
      void run(
        chat,
        node.action.prompt +
          '\n\nPersistent panel: ' +
          panel.id +
          '\nSelected values: ' +
          JSON.stringify(values),
        packet.messageId,
        packet.context,
      );
      changed();
      return;
    }
    if (packet.type === 'ui_action') {
      const chat = chatFor(packet.chat),
        message = chat?.messages.find((m) => m.id === packet.messageId);
      const node = message?.ui?.find((n) => n.id === packet.nodeId);
      if (
        !chat ||
        chat.owner !== state.activeTransport ||
        chat.status === 'working' ||
        node?.kind !== 'button'
      ) {
        return;
      }
      void (async () => {
        if (node.action.kind === 'ask') {
          const values = selectionValues(message!.ui || [], packet.values);
          await run(
            chat,
            node.action.prompt + '\n\nSelected panel values: ' + JSON.stringify(values),
            undefined,
            packet.context,
          );
        } else {
          const undo = node.action.kind === 'undo_settings',
            tool = undo ? 'undo_settings' : 'update_settings';
          if (!capabilitySettings.enabled('tool:' + tool)) {
            throw new Error('This tool is disabled in Settings');
          }
          const identity = characterIdentity(packet.context);
          if (identity && chat.characterKey && identity !== chat.characterKey) {
            throw new Error('Character identity changed; ask again for this character');
          }
          const id = randomUUID();
          const action = {
            kind: tool,
            args: undo
              ? { transactionId: node.action.transactionId }
              : { operation: 'apply', transactionId: node.action.transactionId },
            expectedCharacter: expectedCharacter(identity ?? chat.characterKey),
          };
          chat.status = 'working';
          changed();
          try {
            const result = await runPromise(
              request({
                chat: chat.id,
                session: state.activeTransport,
                operation: { kind: 'act', action },
              }),
            );
            chat.lastUIResult = result;
            const value = result as {
              status?: string;
              data?: {
                verified?: boolean;
                status?: string;
              };
              error?: string;
            };
            chat.messages.push({
              id: 'settings-' + id,
              role: 'system',
              text:
                value.status === 'completed' && value.data?.verified
                  ? undo
                    ? 'Settings restored.'
                    : 'Settings applied. You can undo these changes.'
                  : 'Settings were not applied: ' + (value.error || 'Verification failed.'),
            });
            if (!undo && value.status === 'completed' && value.data?.verified) {
              const undoId = node.id.slice(0, 55) + '_undo';
              if (!message!.ui!.some((n) => n.id === undoId)) {
                message!.ui!.push({
                  id: undoId,
                  parent: node.parent,
                  kind: 'button',
                  label: 'Undo changes',
                  action: { kind: 'undo_settings', transactionId: node.action.transactionId },
                });
              }
            }
          } finally {
            chat.status = 'done';
            changed();
          }
        }
      })().catch((error) => {
        chat.messages.push({ role: 'system', text: error.message });
        changed();
      });
      return;
    }
    if (
      packet.type === 'inline_say' &&
      packet.chat &&
      typeof packet.text === 'string' &&
      packet.text.length <= 16000 &&
      !state.deletedChatIds.has(packet.chat)
    ) {
      let chat = chatFor(packet.chat);
      if (!chat) {
        chat = createChat(packet.chat);
        chat.inline = true;
        chat.title = 'Quick question';
        chat.titleGenerated = true;
      }
      if (!chat.inline) {
        return;
      }
      state.inlineChat = chat.id;
      void run(chat, packet.text, packet.messageId, packet.context);
      changed();
      return;
    }
    if (packet.type === 'promote_inline' && packet.chat) {
      const chat = chatFor(packet.chat);
      if (chat?.inline) {
        promoteChat(chat);
        state.activeChat = chat.id;
        state.inlineChat = '';
        changed();
      }
      return;
    }
    if (packet.type === 'capability_set') {
      const transportSession = state.activeTransport;
      void (async () => {
        if (typeof packet.key !== 'string' || typeof packet.enabled !== 'boolean') {
          throw new Error('Invalid capability setting');
        }
        await runPromise(setCapability(packet.key, packet.enabled));
        if (state.activeTransport === transportSession) {
          state.capabilityAcks[packet.key] = packet.requestId || '';
          state.capabilityError = undefined;
        }
      })()
        .catch((error) => {
          if (state.activeTransport === transportSession) {
            state.capabilityError = { requestId: packet.requestId, message: error.message };
          }
        })
        .finally(changed);
      changed();
      return;
    }
    if (['memory_list', 'memory_save', 'memory_remove'].includes(packet.type)) {
      const identity = characterIdentity(packet.context),
        transportSession = state.activeTransport;
      state.memoryViewRequest = packet.requestId;
      const current = () =>
        state.activeTransport === transportSession && state.memoryViewRequest === packet.requestId;
      const change = Effect.gen(function* () {
        if (packet.type === 'memory_list') return;
        if (packet.slot !== 'preferences' && packet.slot !== 'character') {
          return yield* Effect.fail(Error('Invalid memory scope'));
        }
        const owner = packet.slot === 'preferences' ? 'local-player' : identity;
        if (!owner || typeof packet.key !== 'string') {
          return yield* Effect.fail(
            Error('A fresh character identity and memory key are required'),
          );
        }
        if (packet.type === 'memory_save' && typeof packet.text !== 'string') {
          return yield* Effect.fail(Error('Memory text is required'));
        }
        yield* memoryStore.update(
          packet.slot,
          owner,
          packet.key,
          packet.type === 'memory_save' ? packet.text : undefined,
        );
      });
      runFork(
        change.pipe(
          Effect.andThen(memorySnapshot(identity)),
          Effect.tap((snapshot) =>
            Effect.sync(() => {
              if (current()) state.memoryView = { ...snapshot, requestId: packet.requestId };
            }),
          ),
          Effect.catch((error) =>
            Effect.sync(() => {
              if (current()) {
                state.memoryView = {
                  status: 'unavailable',
                  error: errorMessage(error),
                  requestId: packet.requestId,
                };
              }
            }),
          ),
          Effect.ensuring(Effect.sync(changed)),
        ),
      );
      changed();
      return;
    }
    if (packet.type === 'delete' && packet.chat) {
      const removed = chatFor(packet.chat);
      if (removed) {
        interrupt(removed);
      }
      state.deletedChatIds.add(packet.chat);
      state.chats = state.chats.filter((c) => c.id !== packet.chat);
      endSession(engine, removed?.agentSession);
      state.activeChat = resumeChat(state.chats, packet.nextChat)?.id || '';
      changed();
      return;
    }
    if (packet.chat && state.deletedChatIds.has(packet.chat) && packet.type !== 'hello') {
      changed();
      return;
    }
    if (packet.type === 'hello') {
      state.activeChat = resumeChat(state.chats, packet.chat)?.id || '';
    } else if (packet.chat && ['new', 'say', 'select'].includes(packet.type)) {
      state.chats = state.chats.filter((chat) => chat.id === packet.chat || !isEmptyDraft(chat));
      state.activeChat = packet.chat;
    }
    if (['new', 'say'].includes(packet.type) && packet.chat && !chatFor(packet.chat)) {
      createChat(packet.chat);
    }
    if (
      packet.type === 'say' &&
      packet.chat &&
      typeof packet.text === 'string' &&
      packet.text.length <= 16000
    ) {
      const chat = chatFor(packet.chat)!;
      if (chat.routineId && chat.status !== 'working') {
        chat.proactive = false;
        chat.dismissed = true;
      }
      void run(chat, packet.text, packet.messageId, packet.context);
    }
    if (packet.type === 'retry') {
      const chat = chatFor(packet.chat);
      const message = chat?.messages.findLast((entry) => entry.role === 'user');
      if (chat?.status === 'error' && message?.id) {
        void run(chat, message.text, message.id, packet.context);
      }
    }
    if (packet.type === 'select') {
      const chat = chatFor(packet.chat);
      if (chat) {
        if (chat.status !== 'working') {
          openChat(chat);
        }
      }
    }
    if (packet.type === 'cancel') {
      const chat = chatFor(packet.chat);
      if (chat) {
        (deps.cancel ?? interrupt)(chat);
      }
    }
    if (packet.type !== 'poll') {
      changed();
    }
  });
});
