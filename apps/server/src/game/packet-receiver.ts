import type { GameEvent } from '@wisp/wow-bridge';
import type { SessionState } from '../session-state.ts';
import type { IntegrationState } from '../integrations/integration-state.ts';
import type { CapabilitySettings } from '../integrations/capabilities.ts';
import type * as AddonRoutines from '../routines/addon-events.ts';
import * as AddonMemory from '../memory/addon-access.ts';
import * as InlineDiagnostics from './inline-diagnostics.ts';
import * as AddonConversations from '../chat/addon-conversations.ts';
import { characterProfile, TurnContextCache } from '../chat/context.ts';
import type { CharacterProfile } from '../chat/context.ts';
import { errorMessage } from '../errors.ts';
import type { UsageTelemetry } from '../telemetry.ts';
import { Clock, Context, Effect, Layer, Scope } from 'effect';

interface ReceiverDependencies {
  telemetry?: Pick<UsageTelemetry, 'game'>;
  state: SessionState;
  integrationState: IntegrationState;
  capabilitySettings: CapabilitySettings;
  routines: ReturnType<typeof AddonRoutines.make>;
  refreshModelCatalog: () => Promise<void>;
  setCapability: (id: string, enabled: boolean) => Effect.Effect<void, unknown>;
  invalidateAddonView: () => void;
  /** Records a character's name and moves its pre-GUID data before the packet is handled. */
  adoptCharacter?: (character: CharacterProfile) => Effect.Effect<boolean>;
}

export class Service extends Context.Service<
  Service,
  { receive: (packet: GameEvent) => Effect.Effect<void> }
>()('@wisp/server/game/PacketReceiver') {}

export const layer = (deps: ReceiverDependencies) =>
  Layer.effect(
    Service,
    Effect.map(make(deps), (receive) => Service.of({ receive })),
  );

export const make = Effect.fnUntraced(function* (deps: ReceiverDependencies) {
  const scope = yield* Scope.Scope;
  const diagnostics = yield* InlineDiagnostics.Service;
  const memory = yield* AddonMemory.Service;
  const conversations = yield* AddonConversations.Service;
  const background = Effect.forkIn(scope, { startImmediately: true });
  const {
    state,
    integrationState,
    capabilitySettings,
    routines,
    refreshModelCatalog,
    setCapability,
    invalidateAddonView,
  } = deps;
  let contextCache = new TurnContextCache();
  let lastDelivery = '';
  let activeSeenAt = 0;
  return Effect.fnUntraced(function* receive(packet: GameEvent) {
    const receivedAt = yield* Clock.currentTimeMillis;
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
      yield* Effect.logInfo('Game window connected').pipe(
        Effect.annotateLogs({
          event: 'transport.session_changed',
          reason: packet.takeover ? 'takeover' : packet.heartbeat ? 'heartbeat' : packet.type,
          previousIdleMs: state.activeTransport ? receivedAt - activeSeenAt : undefined,
        }),
      );
      activeSeenAt = receivedAt;
      contextCache = new TurnContextCache();
      lastDelivery = '';
      conversations.leaveWindow();
      state.activeTransport = packet.session;
      state.currentCharacterKey = undefined;
      state.inlineChat = '';
      state.panelCommand = undefined;
      state.routineCommand = undefined;
      state.routinePresence = undefined;
      integrationState.reset();
      conversations.resume(packet.chat);
      memory.reset();
      yield* Effect.promise(refreshModelCatalog).pipe(background);
    }
    packet = { ...packet, context: contextCache.resolve(packet.context) };
    const contextChanged =
      (state.questRevision ?? 0) !== contextCache.revision ||
      (state.characterRevision ?? 0) !== contextCache.characterRevision;
    state.questRevision = contextCache.revision;
    state.characterRevision = contextCache.characterRevision;
    if (integrationState.receive(packet.integrations) && integrationState.report) {
      deps.telemetry?.game(integrationState.report.version);
    }
    const integrationsChanged =
      JSON.stringify(capabilitySettings.snapshot()) !== beforeIntegrations;
    if (integrationsChanged) {
      yield* Effect.tryPromise({
        try: () => capabilitySettings.publish(),
        catch: errorMessage,
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning('Integration update failed').pipe(
            Effect.annotateLogs({
              event: 'integration.update_failed',
              error,
            }),
          ),
        ),
        background,
      );
    }
    const heartbeatOnly = packet.heartbeat && !newTransport;
    const delivery = packet.transport?.delivery;
    if (!heartbeatOnly && delivery && delivery.messageId !== lastDelivery) {
      lastDelivery = delivery.messageId;
      yield* Effect.logInfo('Message delivery').pipe(
        Effect.annotateLogs({ event: 'transport.message_delivery', ...delivery }),
      );
    }
    const previousCharacter = state.currentCharacterKey;
    let adoptedCharacterData = false;
    if (
      !heartbeatOnly &&
      packet.type !== 'model_catalog' &&
      packet.type !== 'chat_model_set' &&
      packet.type !== 'inline_status'
    ) {
      const character = characterProfile(packet.context);
      if (character) {
        if (deps.adoptCharacter) adoptedCharacterData = yield* deps.adoptCharacter(character);
        state.currentCharacterKey = character.key;
      }
    }
    const activeChatChanged =
      !heartbeatOnly &&
      packet.type === 'hello' &&
      !newTransport &&
      conversations.resume(packet.chat);
    if (
      newTransport ||
      contextChanged ||
      integrationsChanged ||
      adoptedCharacterData ||
      previousCharacter !== state.currentCharacterKey ||
      activeChatChanged ||
      (!heartbeatOnly && packet.type === 'capabilities_list')
    ) {
      invalidateAddonView();
    }
    if (heartbeatOnly) return;
    if (packet.type === 'model_catalog') {
      yield* Effect.promise(refreshModelCatalog).pipe(background);
      return;
    }
    if (packet.type === 'chat_model_set') {
      yield* conversations.changeModel(packet).pipe(background);
      return;
    }
    if (packet.type === 'inline_status') {
      yield* diagnostics.record(packet).pipe(background);
      return;
    }
    if (packet.type === 'routine_tick' || packet.type === 'routine_event') {
      yield* routines.presence(packet).pipe(background);
      return;
    }
    if (packet.type === 'routine_action') {
      yield* routines.action(packet).pipe(background);
      return;
    }
    if (packet.type === 'panel_ask') return yield* conversations.panelQuestion(packet);
    if (packet.type === 'ui_action') {
      yield* conversations.replyAction(packet).pipe(background);
      return;
    }
    if (packet.type === 'capability_set') {
      yield* Effect.gen(function* () {
        yield* setCapability(packet.key, packet.enabled);
        if (state.activeTransport === packet.session) {
          state.capabilityAcks[packet.key] = packet.requestId || '';
          state.capabilityError = undefined;
          invalidateAddonView();
        }
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            if (state.activeTransport !== packet.session) return;
            state.capabilityError = { requestId: packet.requestId, message: errorMessage(error) };
            invalidateAddonView();
          }),
        ),
        background,
      );
      return;
    }
    if (
      packet.type === 'memory_list' ||
      packet.type === 'memory_save' ||
      packet.type === 'memory_remove'
    ) {
      yield* memory.handle({ ...packet, type: packet.type }).pipe(background);
      return;
    }
    switch (packet.type) {
      case 'new':
      case 'say':
      case 'inline_say':
      case 'select':
      case 'delete':
      case 'cancel':
      case 'retry':
      case 'dismiss_tip':
      case 'promote_inline':
        conversations.handle(packet);
        break;
      case 'hello':
      case 'poll':
      case 'capabilities_list':
      case 'quest_sync':
        break;
    }
  });
});
