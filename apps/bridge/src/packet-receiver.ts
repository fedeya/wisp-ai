import { parseCharacterKey } from '@wisp/protocol/character-key';
import type { Client } from 'eve/client';
import type { Packet } from '@wisp/protocol/protocol';
import { selectionValues } from '@wisp/protocol/ui-schema';
import { routineInput, routineEvent } from '@wisp/protocol/routines';
import { safeErrorMessage } from '@wisp/protocol/model-errors';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SessionState } from './session-state.ts';
import type { Chat } from './events.ts';
import type { DiskTransport } from './transport.ts';
import type { GameRequests } from './game-requests.ts';
import type { IntegrationState } from './integration-state.ts';
import type { CapabilitySettings } from './capabilities.ts';
import type { ModelCatalog } from './model-connections.ts';
import type { RoutineStore } from './routines.ts';
import type { PanelStore } from './panels.ts';
import type { MemoryStore } from './memory-store.ts';
import type { MemoryView } from './agent-server.ts';
import { characterIdentity, TurnContextCache } from './context.ts';
import { chooseChatModel } from './chat-model.ts';
import { parseConnectionModel } from '@wisp/protocol/providers';
import { resumeChat, isEmptyDraft } from './sessions.ts';
import { newChat, openChat, promoteChat, isWorking, settleTurn } from './chat-lifecycle.ts';
import { errorMessage } from './errors.ts';
import type { UsageTelemetry } from './telemetry.ts';
import type { Logger } from 'pino';
const milliseconds = z.number().nonnegative();
const optionalCount = z.int().nonnegative().optional();
const distribution = z.object({
  count: z.int().nonnegative(),
  mean: milliseconds,
  max: milliseconds,
  p50: milliseconds.optional(),
  p95: milliseconds.optional(),
  p99: milliseconds.optional(),
});
const profileWork = z.object({
  ack: distribution.optional(),
  apply: distribution.optional(),
  decode_apply: distribution.optional(),
  reset: distribution.optional(),
  send: distribution.optional(),
});
const transportProfile = z.object({
  elapsedMs: milliseconds,
  frames: distribution,
  // WoW serializes an empty Lua table as an array.
  work: z.union([profileWork, z.tuple([]).transform(() => ({}))]),
  compactAck: z.boolean().optional(),
  bulkAvailable: z.boolean().optional(),
  startSlot: optionalCount,
  endSlot: optionalCount,
  totalBulkLoads: optionalCount,
  downlinkFrames: optionalCount,
  downlinkMessages: optionalCount,
  downlinkResyncs: optionalCount,
});

interface ReceiverDependencies {
  telemetry?: Pick<UsageTelemetry, 'game'>;
  state: SessionState;
  client: Pick<Client, 'sessions'>;
  pending: GameRequests;
  integrationState: IntegrationState;
  capabilitySettings: CapabilitySettings;
  models: Pick<ModelCatalog, 'models'>;
  routineStore: RoutineStore;
  panelStore: PanelStore;
  memoryStore: MemoryStore;
  transport: () => Pick<DiskTransport, 'resetSession' | 'setCursor'>;
  refreshModelCatalog: () => Promise<void>;
  setCapability: (id: string, enabled: boolean) => Promise<void>;
  memorySnapshot: (identity: string | undefined) => Promise<MemoryView>;
  run: (chat: Chat, text: string, messageId?: string, context?: unknown) => Promise<void>;
  interrupt: (chat: Chat) => void;
  runtime: string;
  changed: () => void;
  flushAcknowledgment?: () => void;
  logger: Pick<Logger, 'warn'>;
  addonLogger: Pick<Logger, 'info'>;
}
export function createPacketReceiver(deps: ReceiverDependencies) {
  const {
    state,
    client,
    pending,
    integrationState,
    capabilitySettings,
    models,
    routineStore,
    panelStore,
    memoryStore,
    transport,
    refreshModelCatalog,
    setCapability,
    memorySnapshot,
    run,
    interrupt,
    runtime,
    changed,
    logger,
    addonLogger,
  } = deps;
  const chatFor = (id: string | undefined) => state.chats.find((chat) => chat.id === id);
  let contextCache = new TurnContextCache();
  let lastDelivery = '';
  const createChat = (id: string) => {
    const chat = newChat(id, state.activeTransport);
    state.chats.push(chat);
    return chat;
  };
  return function receive(packet: Packet) {
    const establishesSession =
      packet.type === 'hello' || (!state.activeTransport && packet.type === 'poll');
    if (!establishesSession && packet.session !== state.activeTransport) {
      return;
    }
    const beforeIntegrations = JSON.stringify(capabilitySettings.snapshot());
    const newTransport = establishesSession && state.activeTransport !== packet.session;
    if (newTransport) {
      contextCache = new TurnContextCache();
      lastDelivery = '';
      pending.cancelAll('The addon reloaded or the character changed. Query again.');
      for (const chat of state.chats.filter(
        (chat) => chat.owner === state.activeTransport && isWorking(chat),
      )) {
        interrupt(chat);
        settleTurn(chat, 'interrupted');
        if (chat.eveId) {
          void client.sessions
            .attach(chat.eveId)
            .cancel()
            .catch((error) =>
              logger.warn(
                { event: 'session.cancel_failed', error: errorMessage(error) },
                'Session cancellation failed',
              ),
            );
        }
      }
      state.activeTransport = packet.session;
      state.currentCharacterKey = undefined;
      state.inlineChat = '';
      state.panelCommand = undefined;
      state.routineCommand = undefined;
      state.routinePresence = undefined;
      integrationState.reset();
      state.firstReadyRevision = 0;
      state.activeChat = resumeChat(state.chats, packet.chat)?.id || '';
      state.memoryView = undefined;
      state.acknowledgments = [];
      state.handled.clear();
      transport().resetSession();
      void refreshModelCatalog();
    }
    packet.context = contextCache.resolve(packet.context);
    state.questRevision = contextCache.revision;
    state.characterRevision = contextCache.characterRevision;
    if (
      packet.type !== 'poll' &&
      !packet.heartbeat &&
      !state.acknowledgments.includes(packet.seq)
    ) {
      state.acknowledgments.push(packet.seq);
      state.acknowledgments = state.acknowledgments.slice(-32);
    }
    if (packet.messageId) {
      deps.flushAcknowledgment?.();
    }
    if (
      Number.isSafeInteger(packet.nextSlot) &&
      packet.nextSlot! >= 1 &&
      packet.nextSlot! <= 1024
    ) {
      transport().setCursor(packet.nextSlot!, Number(packet.receivedRev || 0));
    }
    if (integrationState.receive(packet.integrations) && integrationState.report) {
      deps.telemetry?.game(integrationState.report.version);
    }
    if (JSON.stringify(capabilitySettings.snapshot()) !== beforeIntegrations) {
      void capabilitySettings
        .publish()
        .catch((error) =>
          logger.warn(
            { event: 'integration.update_failed', error: errorMessage(error) },
            'Integration update failed',
          ),
        );
      changed();
    }
    if (packet.heartbeat && !newTransport) {
      return;
    }
    const packetKey = packet.session + ':' + packet.seq;
    if (state.handled.has(packetKey)) {
      if (packet.type !== 'poll') {
        changed();
      }
      return;
    }
    state.handled.add(packetKey);
    const delivery = packet.transport?.delivery;
    if (delivery && delivery.messageId !== lastDelivery) {
      lastDelivery = delivery.messageId;
      addonLogger.info(
        {
          event: 'addon.message_delivery',
          ...delivery,
        },
        'Message delivery',
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
          if (
            chat.eveId &&
            chat.modelSettings?.model !== selected.model &&
            (parseConnectionModel(chat.modelSettings?.model || '') ||
              parseConnectionModel(selected.model))
          ) {
            // Start clean provider-native history while retaining the visible
            // conversation. Reasoning signatures/response IDs are not portable.
            const previous = chat.eveId;
            chat.eveId = undefined;
            void client.sessions
              .attach(previous)
              .end({ reason: 'AI model or connection changed' })
              .catch((error) =>
                logger.warn(
                  { event: 'session.cleanup_failed', error: errorMessage(error) },
                  'Session cleanup failed',
                ),
              );
          }
          chat.modelSettings = selected;
          chat.modelError = undefined;
          state.modelCatalog = available;
        } catch (error) {
          chat.modelError = safeErrorMessage(
            error instanceof Error ? error.message : String(error),
          );
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
          const { messageId, totalMs, afterSendingMs } = timing.data;
          addonLogger.info(
            {
              event: 'addon.first_text',
              messageId,
              totalMs,
              afterSendingMs,
            },
            'First text visible in WoW',
          );
        }
        changed();
        return;
      }
      if (data?.event === 'transport_profile') {
        const profile = transportProfile.safeParse(data);
        if (profile.success) {
          addonLogger.info(
            {
              event: 'addon.transport_profile',
              ...profile.data,
            },
            'WoW transport profile',
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
        logger.warn(
          { event: 'addon.inline_status_save_failed', error: errorMessage(error) },
          'Inline diagnostic save failed',
        ),
      );
      changed();
      return;
    }
    if (packet.context) {
      state.currentCharacterKey = characterIdentity(packet.context) || state.currentCharacterKey;
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
          void routineStore
            .observe(identity, event.data)
            .then(changed)
            .catch((error) =>
              logger.warn(
                { event: 'routine.event_failed', error: errorMessage(error) },
                'Routine event failed',
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
        void routineStore
          .mutate(identity, input.data)
          .then(changed)
          .catch((error) =>
            logger.warn(
              { event: 'routine.action_failed', error: errorMessage(error) },
              'Routine action failed',
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
        panel = identity ? panelStore.list(identity).find((p) => p.id === packet.key) : undefined;
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
          if (!identity || identity !== chat.characterKey) {
            throw new Error('Character identity changed; ask again for this character');
          }
          const current = parseCharacterKey(identity),
            id = randomUUID();
          const action = {
            kind: tool,
            args: undo
              ? { transactionId: node.action.transactionId }
              : { operation: 'apply', transactionId: node.action.transactionId },
            expectedCharacter: { realm: current.realm, name: current.name },
          };
          chat.status = 'working';
          changed();
          try {
            const result = await pending.request({
              chat: chat.id,
              session: state.activeTransport,
              action,
            });
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
        await setCapability(packet.key, packet.enabled);
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
      void (async () => {
        if (packet.type !== 'memory_list') {
          if (packet.slot !== 'preferences' && packet.slot !== 'character') {
            throw new Error('Invalid memory scope');
          }
          const owner = packet.slot === 'preferences' ? 'local-player' : identity;
          if (!owner || typeof packet.key !== 'string') {
            throw new Error('A fresh character identity and memory key are required');
          }
          if (packet.type === 'memory_save' && typeof packet.text !== 'string') {
            throw new Error('Memory text is required');
          }
          await memoryStore.update(
            packet.slot,
            owner,
            packet.key,
            packet.type === 'memory_save' ? packet.text : undefined,
          );
        }
        const snapshot = await memorySnapshot(identity);
        if (
          state.activeTransport === transportSession &&
          state.memoryViewRequest === packet.requestId
        ) {
          state.memoryView = { ...snapshot, requestId: packet.requestId };
        }
      })()
        .catch((error) => {
          if (
            state.activeTransport === transportSession &&
            state.memoryViewRequest === packet.requestId
          ) {
            state.memoryView = {
              status: 'unavailable',
              error: error.message,
              requestId: packet.requestId,
            };
          }
        })
        .finally(changed);
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
      pending.cancelChat(packet.chat);
      if (removed?.eveId) {
        void client.sessions
          .attach(removed.eveId)
          .end({ reason: 'Conversation deleted by user' })
          .catch(() => {});
      }
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
    if (packet.type === 'state_result' && packet.requestId) {
      pending.receive(packet.requestId, packet.session, packet.chat, packet.data);
    }
    if (packet.type === 'cancel') {
      const chat = chatFor(packet.chat);
      if (chat?.eveId) {
        void client.sessions
          .attach(chat.eveId)
          .cancel()
          .catch(() => {});
      }
    }
    if (packet.type !== 'poll') {
      changed();
    }
  };
}
