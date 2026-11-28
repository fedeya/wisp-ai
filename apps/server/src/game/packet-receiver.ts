import { expectedCharacter } from '@wisp/protocol/character-key';
import type { Connection, GameEvent } from '@wisp/wow-bridge';
import { selectionValues } from '@wisp/agent/contract/ui-schema';
import { rejectUnknownKeys } from '@wisp/protocol/checks';
import { routineInput, routineEvent } from '@wisp/protocol/routines';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SessionState, type MemoryView, type Session } from '#/session';
import type { Chat } from '../chat/events.ts';
import type { AccountModel } from '../chat/chat-model.ts';
import type { CapabilitySettings, IntegrationState } from '#/capabilities';
import type { ModelCatalog } from '../models/catalog.ts';
import type { ModelConnections } from '../models/connections.ts';
import type { RoutineStore } from '../routines/routine-store.ts';
import type { PanelStore } from '../panels/panel-store.ts';
import type { MemoryRepository } from '../memory/repository.ts';
import type { MemoryEdit } from '@wisp/agent/contract/memory';
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
import type { UsageTelemetry } from '#/telemetry';
import { endSession, type AgentEngine } from '../agent/agent-session.ts';
import type { SnapshotPublisher } from './snapshot-publisher.ts';
import { Effect, Option, Schema } from 'effect';
// The addon's routine packets are strict, like the protocol schemas.
const decodeRoutineEvent = Schema.decodeUnknownOption(routineEvent, rejectUnknownKeys);
const decodeRoutineAction = Schema.decodeUnknownOption(routineInput, rejectUnknownKeys);
interface ReceiverDependencies {
  telemetry?: UsageTelemetry['Service'];
  engine: Pick<AgentEngine, 'end'>;
  request: Connection['request'];
  integrationState: IntegrationState['Service'];
  capabilitySettings: CapabilitySettings['Service'];
  models: Pick<ModelConnections['Service'], 'models'>;
  routineStore: RoutineStore;
  panelStore: PanelStore;
  memoryRepository: MemoryRepository['Service'];
  catalog: Pick<ModelCatalog['Service'], 'refresh'>;
  setCapability: (id: string, enabled: boolean) => Effect.Effect<void, unknown>;
  memorySnapshot: (identity: string | undefined) => Effect.Effect<MemoryView, Error>;
  run: (chat: Chat, text: string, messageId?: string, context?: unknown) => Promise<void>;
  interrupt: (chat: Chat) => void;
  /** Stops a turn the player cancelled. */
  cancel?: (chat: Chat) => void;
  runtime: string;
  /** Told when routines or capabilities the snapshot shows change. */
  snapshot: Pick<SnapshotPublisher['Service'], 'invalidate'>;
  /** Records a character's name and moves its pre-GUID data before the packet is handled. */
  adoptCharacter?: (character: CharacterProfile) => Effect.Effect<void>;
  now?: () => number;
}
/**
 * Handles the addon's packets on `SessionState`. A packet's bookkeeping is
 * staged and told to the subscribers with the update that ends it, so one
 * packet still makes one change.
 */
export const createPacketReceiver = Effect.fnUntraced(function* (deps: ReceiverDependencies) {
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  const runPromise = Effect.runPromiseWith(context);
  const session = yield* SessionState;
  const {
    engine,
    request,
    integrationState,
    capabilitySettings,
    models,
    routineStore,
    panelStore,
    memoryRepository,
    catalog,
    setCapability,
    memorySnapshot,
    run,
    interrupt,
    runtime,
    snapshot,
  } = deps;
  const chatFor = (state: Session, id: string | undefined) =>
    state.chats.find((chat) => chat.id === id);
  let contextCache = new TurnContextCache();
  let lastDelivery = '';
  const now = deps.now ?? Date.now;
  let activeSeenAt = 0;
  // Staged: the packet that asks for the chat tells the subscribers.
  const createChat = Effect.fnUntraced(function* (id: string) {
    const chat = newChat(id, (yield* session.get).activeTransport);
    yield* session.stage((state) => ({ ...state, chats: [...state.chats, chat] }));
    return chat;
  });
  return Effect.fnUntraced(function* receive(packet: GameEvent) {
    const receivedAt = now();
    const before = yield* session.get;
    if (before.activeTransport && packet.session === before.activeTransport) {
      activeSeenAt = receivedAt;
    }
    const establishesSession =
      packet.type === 'hello' || (!before.activeTransport && packet.type === 'poll');
    if (!establishesSession && packet.session !== before.activeTransport) {
      return;
    }
    // The bridge has already selected the window that owns the connection.
    const beforeIntegrations = JSON.stringify(yield* capabilitySettings.snapshot);
    const newTransport = establishesSession && before.activeTransport !== packet.session;
    if (newTransport) {
      runFork(
        Effect.logInfo('Game window connected').pipe(
          Effect.annotateLogs({
            event: 'transport.session_changed',
            reason: packet.takeover ? 'takeover' : packet.heartbeat ? 'heartbeat' : packet.type,
            previousIdleMs: before.activeTransport ? receivedAt - activeSeenAt : undefined,
          }),
        ),
      );
      activeSeenAt = receivedAt;
      contextCache = new TurnContextCache();
      lastDelivery = '';
      for (const chat of before.chats.filter(
        (chat) => chat.owner === before.activeTransport && isWorking(chat),
      )) {
        interrupt(chat);
        settleTurn(chat, 'interrupted');
      }
      const transportSession = packet.session;
      yield* session.stage((state) => ({
        ...state,
        activeTransport: transportSession,
        currentCharacterKey: undefined,
        inlineChat: '',
        panelCommand: undefined,
        routineCommand: undefined,
        routinePresence: undefined,
      }));
      yield* integrationState.reset;
      const requestedChat = packet.chat;
      yield* session.stage((state) => ({
        ...state,
        activeChat: resumeChat(state.chats, requestedChat)?.id || '',
        memoryView: undefined,
      }));
      yield* Effect.forkDetach(catalog.refresh);
    }
    packet = { ...packet, context: contextCache.resolve(packet.context) };
    const questRevision = contextCache.revision;
    const characterRevision = contextCache.characterRevision;
    const revisions = yield* session.get;
    // The addon reads the revisions back with the next snapshot; they need none of their own.
    if (
      revisions.questRevision !== questRevision ||
      revisions.characterRevision !== characterRevision
    ) {
      yield* session.stage((state) => ({ ...state, questRevision, characterRevision }));
    }
    if ((yield* integrationState.receive(packet.integrations)) && deps.telemetry) {
      const report = yield* integrationState.report;
      if (Option.isSome(report)) yield* deps.telemetry.game(report.value.version);
    }
    if (JSON.stringify(yield* capabilitySettings.snapshot) !== beforeIntegrations) {
      yield* capabilitySettings.publish.pipe(
        Effect.catch((error) =>
          Effect.logWarning('Integration update failed').pipe(
            Effect.annotateLogs({
              event: 'integration.update_failed',
              error: errorMessage(error),
            }),
          ),
        ),
        Effect.forkDetach,
      );
      yield* snapshot.invalidate;
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
      yield* Effect.forkDetach(catalog.refresh);
      return;
    }
    if (packet.type === 'chat_model_set') {
      const current = yield* session.get;
      const existing = chatFor(current, packet.chat);
      const chat =
        existing ??
        (packet.data.inline && !current.deletedChatIds.has(packet.chat)
          ? yield* createChat(packet.chat)
          : undefined);
      if (!chat) {
        return;
      }
      if (packet.data.inline && !chat.messages.length) {
        chat.inline = true;
        chat.title = 'Quick question';
        chat.titleGenerated = true;
        yield* session.stage((state) => ({ ...state, inlineChat: chat.id }));
      }
      const requestId = packet.requestId;
      const input = packet.data;
      void (async () => {
        let available: readonly AccountModel[] | undefined;
        try {
          if (isWorking(chat)) {
            throw Error('Wait for this reply before changing model settings.');
          }
          const loaded = await runPromise(models.models);
          if (isWorking(chat)) {
            throw Error('Wait for this reply before changing model settings.');
          }
          const selected = chooseChatModel(loaded, input.model, input.effort);
          // The chat keeps its agent session: the agent replays each message's
          // provider-native data only to the model that wrote it.
          chat.modelSettings = selected;
          chat.modelError = undefined;
          available = loaded;
        } catch (error) {
          chat.modelError = errorMessage(error);
        } finally {
          chat.modelRequestId = requestId;
          const modelCatalog = available;
          runFork(session.update((state) => (modelCatalog ? { ...state, modelCatalog } : state)));
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
        yield* session.commit;
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
      yield* session.commit;
      return;
    }
    if (packet.context) {
      const character = characterProfile(packet.context);
      if (character) {
        if (deps.adoptCharacter) yield* deps.adoptCharacter(character);
        if ((yield* session.get).currentCharacterKey !== character.key) {
          // A poll has no update at its end, so it tells the subscribers here.
          const store = packet.type === 'poll' ? session.update : session.stage;
          yield* store((state) => ({ ...state, currentCharacterKey: character.key }));
        }
      }
    }
    if (packet.type === 'routine_tick' || packet.type === 'routine_event') {
      const identity = characterIdentity(packet.context);
      const data = packet.data;
      if (!identity || Math.abs(Date.now() - packet.at * 1000) > 90000) {
        return;
      }
      const routinePresence = {
        identity,
        context: packet.context,
        ready: data?.ready === true,
        at: Date.now(),
        session: packet.session,
      };
      // For the routine scheduler; the snapshot does not show it.
      yield* session.stage((state) => ({ ...state, routinePresence }));
      if (
        packet.type === 'routine_event' &&
        (yield* capabilitySettings.enabled('tool:manage_routine'))
      ) {
        const event = decodeRoutineEvent({ event: data?.event, values: data?.values });
        if (Option.isSome(event)) {
          void routineStore
            .observe(identity, event.value)
            .then(() => {
              runFork(snapshot.invalidate);
            })
            .catch((error) =>
              runFork(
                Effect.logWarning('Routine event failed').pipe(
                  Effect.annotateLogs({
                    event: 'routine.event_failed',
                    error: errorMessage(error),
                  }),
                ),
              ),
            );
        }
      }
      return;
    }
    if (packet.type === 'routine_action') {
      const identity = characterIdentity(packet.context);
      const input = decodeRoutineAction(packet.data);
      if (
        identity &&
        Option.isSome(input) &&
        ['pause', 'resume', 'remove'].includes(input.value.operation)
      ) {
        void routineStore
          .mutate(identity, input.value)
          .then(() => {
            runFork(snapshot.invalidate);
          })
          .catch((error) =>
            runFork(
              Effect.logWarning('Routine action failed').pipe(
                Effect.annotateLogs({ event: 'routine.action_failed', error: errorMessage(error) }),
              ),
            ),
          );
      }
      return;
    }
    if (packet.type === 'dismiss_tip' && packet.chat) {
      const chat = chatFor(yield* session.get, packet.chat);
      if (chat?.proactive) {
        chat.dismissed = true;
        yield* session.commit;
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
      let chat = chatFor(yield* session.get, id);
      if (!chat) {
        chat = yield* createChat(id);
        chat.inline = true;
        chat.title = panel.title;
        chat.titleGenerated = true;
      }
      // Told before the turn starts, which tells them again in the same go.
      yield* session.update((state) => ({ ...state, inlineChat: id }));
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
      return;
    }
    if (packet.type === 'ui_action') {
      const current = yield* session.get;
      const chat = chatFor(current, packet.chat),
        message = chat?.messages.find((m) => m.id === packet.messageId);
      const node = message?.ui?.find((n) => n.id === packet.nodeId);
      if (
        !chat ||
        chat.owner !== current.activeTransport ||
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
          if (!(await runPromise(capabilitySettings.enabled('tool:' + tool)))) {
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
          runFork(session.commit);
          try {
            const result = await runPromise(
              session.get.pipe(
                Effect.flatMap((state) =>
                  request({
                    chat: chat.id,
                    session: state.activeTransport,
                    operation: { kind: 'act', action },
                  }),
                ),
              ),
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
            runFork(session.commit);
          }
        }
      })().catch((error) => {
        chat.messages.push({ role: 'system', text: error.message });
        runFork(session.commit);
      });
      return;
    }
    if (
      packet.type === 'inline_say' &&
      packet.chat &&
      typeof packet.text === 'string' &&
      packet.text.length <= 16000 &&
      !(yield* session.get).deletedChatIds.has(packet.chat)
    ) {
      let chat = chatFor(yield* session.get, packet.chat);
      if (!chat) {
        chat = yield* createChat(packet.chat);
        chat.inline = true;
        chat.title = 'Quick question';
        chat.titleGenerated = true;
      }
      if (!chat.inline) {
        return;
      }
      const id = chat.id;
      // Told before the turn starts, which tells them again in the same go.
      yield* session.update((state) => ({ ...state, inlineChat: id }));
      void run(chat, packet.text, packet.messageId, packet.context);
      return;
    }
    if (packet.type === 'promote_inline' && packet.chat) {
      const chat = chatFor(yield* session.get, packet.chat);
      if (chat?.inline) {
        promoteChat(chat);
        yield* session.update((state) => ({ ...state, activeChat: chat.id, inlineChat: '' }));
      }
      return;
    }
    if (packet.type === 'capability_set') {
      const transportSession = (yield* session.get).activeTransport;
      const requestId = packet.requestId;
      const sameTransport = (state: Session) => state.activeTransport === transportSession;
      const { key, enabled } = packet;
      void (async () => {
        if (typeof key !== 'string' || typeof enabled !== 'boolean') {
          throw new Error('Invalid capability setting');
        }
        await runPromise(setCapability(key, enabled));
        runFork(
          session.update((state) =>
            sameTransport(state)
              ? {
                  ...state,
                  capabilityAcks: { ...state.capabilityAcks, [key]: requestId || '' },
                  capabilityError: undefined,
                }
              : state,
          ),
        );
      })().catch((error) => {
        runFork(
          session.update((state) =>
            sameTransport(state)
              ? { ...state, capabilityError: { requestId, message: error.message } }
              : state,
          ),
        );
      });
      // What this packet staged shows now; the setting shows once it is saved.
      yield* session.commit;
      return;
    }
    if (['memory_list', 'memory_save', 'memory_remove'].includes(packet.type)) {
      const identity = characterIdentity(packet.context),
        transportSession = (yield* session.get).activeTransport;
      const requestId = packet.requestId;
      // A view is stored for the request it answers, on the transport that asked.
      const awaited = (state: Session) =>
        state.activeTransport === transportSession && state.memoryViewRequest === requestId;
      // Told before the request runs; its view is told when it arrives.
      yield* session.update((state) => ({ ...state, memoryViewRequest: requestId }));
      void (async () => {
        let readSnapshot = memorySnapshot(identity);
        if (packet.type !== 'memory_list') {
          if (packet.slot !== 'preferences' && packet.slot !== 'character') {
            throw new Error('Invalid memory scope');
          }
          const owner = packet.slot === 'preferences' ? 'local-player' : identity;
          if (!owner || typeof packet.key !== 'string') {
            throw new Error('A fresh character identity and memory key are required');
          }
          const scope = { slot: packet.slot, owner };
          const key = packet.key;
          let edit: MemoryEdit;
          if (packet.type === 'memory_save') {
            if (typeof packet.text !== 'string') throw new Error('Memory text is required');
            edit = { operation: 'save', key, text: packet.text };
          } else {
            edit = { operation: 'remove', key };
          }
          readSnapshot = Effect.andThen(memoryRepository.update(scope, edit), readSnapshot);
        }
        const view = await runPromise(readSnapshot);
        runFork(
          session.update((state) =>
            awaited(state) ? { ...state, memoryView: { ...view, requestId } } : state,
          ),
        );
      })().catch((error: unknown) => {
        runFork(
          session.update((state) =>
            awaited(state)
              ? {
                  ...state,
                  memoryView: { status: 'unavailable', error: errorMessage(error), requestId },
                }
              : state,
          ),
        );
      });
      return;
    }
    if (packet.type === 'delete' && packet.chat) {
      const deleted = packet.chat;
      const removed = chatFor(yield* session.get, deleted);
      if (removed) {
        interrupt(removed);
      }
      const nextChat = packet.nextChat;
      yield* session.update((state) => {
        const chats = state.chats.filter((c) => c.id !== deleted);
        return {
          ...state,
          deletedChatIds: new Set([...state.deletedChatIds, deleted]),
          chats,
          activeChat: resumeChat(chats, nextChat)?.id || '',
        };
      });
      endSession(engine, removed?.agentSession);
      return;
    }
    if (
      packet.chat &&
      (yield* session.get).deletedChatIds.has(packet.chat) &&
      packet.type !== 'hello'
    ) {
      yield* session.commit;
      return;
    }
    const chatId = packet.chat;
    if (packet.type === 'hello') {
      yield* session.stage((state) => ({
        ...state,
        activeChat: resumeChat(state.chats, chatId)?.id || '',
      }));
    } else if (chatId && ['new', 'say', 'select'].includes(packet.type)) {
      yield* session.stage((state) => ({
        ...state,
        chats: state.chats.filter((chat) => chat.id === chatId || !isEmptyDraft(chat)),
        activeChat: chatId,
      }));
    }
    if (['new', 'say'].includes(packet.type) && chatId && !chatFor(yield* session.get, chatId)) {
      yield* createChat(chatId);
    }
    if (
      packet.type === 'say' &&
      chatId &&
      typeof packet.text === 'string' &&
      packet.text.length <= 16000
    ) {
      const chat = chatFor(yield* session.get, chatId);
      if (chat) {
        if (chat.routineId && chat.status !== 'working') {
          chat.proactive = false;
          chat.dismissed = true;
        }
        void run(chat, packet.text, packet.messageId, packet.context);
      }
    }
    if (packet.type === 'retry') {
      const chat = chatFor(yield* session.get, chatId);
      const message = chat?.messages.findLast((entry) => entry.role === 'user');
      if (chat?.status === 'error' && message?.id) {
        void run(chat, message.text, message.id, packet.context);
      }
    }
    if (packet.type === 'select') {
      const chat = chatFor(yield* session.get, chatId);
      if (chat) {
        if (chat.status !== 'working') {
          openChat(chat);
        }
      }
    }
    if (packet.type === 'cancel') {
      const chat = chatFor(yield* session.get, chatId);
      if (chat) {
        (deps.cancel ?? interrupt)(chat);
      }
    }
    // Tells the subscribers what this packet staged and edited in its chats.
    if (packet.type !== 'poll') {
      yield* session.commit;
    }
  });
});
