import { characterLabel } from '@wisp/protocol/character-key';
import {
  ConfigProvider,
  Context,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Redacted,
  Scope,
  Stream,
} from 'effect';
import { Headers as HttpHeaders, HttpClientRequest, HttpClientResponse } from 'effect/http';
import * as NodeChildProcessSpawner from '@effect/platform-node/NodeChildProcessSpawner';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import { releaseRuntimeResource, RuntimeResources } from './runtime-resources.ts';
import * as UsageTelemetry from './telemetry/index.ts';
import { ModelFailures } from './models/model-failures.ts';
import { startRoutineScheduler } from './routines/routine-scheduler.ts';
import { createPacketReceiver } from './game/packet-receiver.ts';
import { createCharacterAdoption } from './chat/character-adoption.ts';
import { readCharacterNames } from './chat/character-keys.ts';
import { createSessionState } from './session-state.ts';
import { createDesktopApp } from './api/desktop-handler.ts';
import type { Status } from '@wisp/protocol/desktop';
import { writeJson } from './json-file.ts';
import { createAgentHandler } from './agent/agent-server.ts';
import * as WowBridge from '@wisp/wow-bridge';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTransportConnection } from './game/transport-connection.ts';
import type { TransportConnection } from './game/transport-connection.ts';
import { ChatStore } from './chat/chat-store.ts';
import { applicationDatabaseFile } from '@wisp/db/application-file';
import { ApplicationDatabase } from './application-database.ts';
import { createTurnRunner } from './agent/turn-runner.ts';
import type { TurnTelemetry } from './agent/turn-runner.ts';
import { errorMessage } from './errors.ts';
import { bridgeLogging } from './logger.ts';
import * as MemoryRepository from './memory/repository.ts';
import * as AgentMemoryAccess from './memory/agent-access.ts';
import * as Sql from '@wisp/db/sql-database';
import { importProductData } from './migrations/product-json.ts';
import * as Capabilities from './capabilities/index.ts';
import { createMcpCapabilities } from './integrations/mcp/mcp-capabilities.ts';
import { PUBLISH_MIN_INTERVAL_MS } from './game/publish-scheduler.ts';
import { createSnapshotPublisher } from './game/snapshot-publisher.ts';
import type { SnapshotPublisher } from './game/snapshot-publisher.ts';
import { PanelStore } from './panels/panel-store.ts';
import { McpManager } from '@wisp/agent/mcp-manager';
import * as Everloot from '@wisp/agent/everloot';
import * as SecretVault from './platform/secret-vault.ts';
import { startDesktopServer } from './api/desktop-server.ts';
import { listenOnLoopback } from './loopback-server.ts';
import { RoutineStore } from './routines/routine-store.ts';
import * as ModelConnections from './models/connections.ts';
import * as ModelCatalog from './models/catalog.ts';
import { resolveDefaultModel } from './chat/chat-model.ts';
import { createAccountOperations } from './account-operations.ts';
import { WebSearch } from './integrations/search/web-search.ts';
import * as ChatGPTAuth from './auth/index.ts';
import * as Settings from './settings/index.ts';
import * as TheWoWDB from './integrations/thewowdb/index.ts';
import * as HttpClient from './platform/http-client.ts';
import * as Simulation from './integrations/simulation/simulator.ts';
import * as AppConfig from './platform/config.ts';
import * as AppVersion from './platform/app-version.ts';
import { addonVersionFromToc } from './game/addon-version.ts';
import * as Features from './features/index.ts';
import { setAgentHost } from '@wisp/agent/agent-host';
import * as Agent from '@wisp/agent/engine';
import * as AgentCapabilities from '@wisp/agent/capabilities';
import * as AgentMcp from '@wisp/agent/mcp-tools';
import * as Game from '@wisp/agent/game-access';
import * as Memory from '@wisp/agent/memory';
import * as AgentGameAccess from './game/agent-game-access.ts';
import { AgentHistory } from './agent/agent-history.ts';

const wowPlatform = Layer.merge(NodeFileSystem.layer, NodePath.layer);
const appVersion = AppVersion.layer.pipe(Layer.provide([AppConfig.layer, wowPlatform]));
// One Settings for the server and the services that save to it.
const settingsLayer = Settings.layer.pipe(
  Layer.provide([AppConfig.layer, wowPlatform, NodeCrypto.layerSecureRandom]),
);
const featuresLayer = Features.layer.pipe(
  Layer.provide([AppConfig.layer, appVersion, settingsLayer, NodeCrypto.layerSecureRandom]),
);
// One CapabilitySettings for the server and the integration state it records.
const capabilitySettingsLayer = Capabilities.settingsLayer.pipe(
  Layer.provide([AppConfig.layer, wowPlatform, featuresLayer, NodeCrypto.layerSecureRandom]),
);
// One ChatGPTAuth for the server and the model connections that use it.
const chatgptLayer = ChatGPTAuth.layer.pipe(
  Layer.provide([
    AppConfig.layer,
    wowPlatform,
    HttpClient.layer,
    NodeCrypto.layerDigest,
    NodeCrypto.layerSecureRandom,
    NodeCrypto.layerSignature,
  ]),
);
// One ModelConnections for the server and the catalog loaded from it.
const modelConnectionsLayer = ModelConnections.layer.pipe(
  Layer.provide([
    AppConfig.layer,
    wowPlatform,
    HttpClient.layer,
    NodeCrypto.layerSecureRandom,
    chatgptLayer,
  ]),
);

/**
 * The migrated services `makeServer` receives from its caller, on the
 * `SecretVault` the caller provides. Each migrated adapter adds its layer
 * here; `ServerLayer` provides the native vault.
 */
export const ServerServices = Layer.mergeAll(
  AppConfig.layer,
  wowPlatform,
  Simulation.layer.pipe(
    Layer.provide(NodeChildProcessSpawner.layer.pipe(Layer.provide(wowPlatform))),
    Layer.provide([AppConfig.layer, wowPlatform, NodeCrypto.layerDigest]),
  ),
  TheWoWDB.layer.pipe(Layer.provide(HttpClient.layer)),
  chatgptLayer,
  modelConnectionsLayer,
  ModelCatalog.layer.pipe(Layer.provide(modelConnectionsLayer)),
  settingsLayer,
  appVersion,
  featuresLayer,
  UsageTelemetry.layer.pipe(
    Layer.provide([AppConfig.layer, appVersion, wowPlatform, featuresLayer]),
  ),
  capabilitySettingsLayer,
  Capabilities.integrationsLayer.pipe(Layer.provide(capabilitySettingsLayer)),
);

/** The migrated services; `main.ts` and `startServer` provide it. */
export const ServerLayer = ServerServices.pipe(
  Layer.provideMerge(
    SecretVault.layer.pipe(
      Layer.provide(AppConfig.layer),
      Layer.provide(NodeChildProcessSpawner.layer.pipe(Layer.provide(wowPlatform))),
    ),
  ),
);

export interface ServerOptions {
  agentPort?: number;
  desktopPort?: number;
  /**
   * Replaces the environment as the source of the `WISP_*` configuration in
   * `startServer`. Effect callers provide a `ConfigProvider` instead.
   */
  configProvider?: ConfigProvider.ConfigProvider;
}
/**
 * Composition root of the Wisp server: loads stores and settings, wires the
 * in-process agent, the WoW bridge and the HTTP listeners, and returns
 * `{ state, receive }` in the caller's scope.
 *
 * Cleanup is registered on the scope and runs in reverse (LIFO), so
 * the registration order below is the shutdown order read bottom-up. Orderings
 * that matter:
 * - The publish and integration timers and the desktop server stop first,
 *   so nothing new starts.
 * - Pending account work settles before the agent engine closes its MCP
 *   connections.
 * - The agent server closes and the transport disconnects before turns
 *   drain, and turns drain before the publisher stops, chats are flushed and
 *   the database closes (last).
 */
export const makeServer = Effect.fn('Server.make')(
  function* (options: ServerOptions, requestStop: () => void) {
    const context = yield* Effect.context<never>();
    const runFork = Effect.runForkWith(context);
    const runPromise = Effect.runPromiseWith(context);
    // Checked by everything that starts work, so nothing new begins while resources close.
    let shutdownRequested = false;
    // Migrated: the unmigrated consumers below receive plain values read from it.
    const appConfig = yield* AppConfig.AppConfig;
    const { paths } = appConfig;
    const ROOT = paths.root;
    const { version: bridgeVersion } = yield* AppVersion.AppVersion;
    const expectedAddonVersion = yield* startup(() =>
      readFile(path.join(ROOT, 'addon/WispAI/WispAI.toc'), 'utf8').then(
        addonVersionFromToc,
        () => undefined,
      ),
    );
    const runtime = paths.runtime;
    const simulator = yield* Simulation.Simulator;
    yield* startup(() => mkdir(runtime, { recursive: true }));
    const databaseFile = applicationDatabaseFile(runtime);
    const applicationDatabase = new ApplicationDatabase(databaseFile);
    yield* releaseRuntimeResource(() => applicationDatabase.close());
    // Adapters for unmigrated consumers, which take Promise interfaces built
    // here from migrated services. Remove each one when its consumers migrate.
    // For the synchronous readers of the settings below.
    const runSync = Effect.runSyncWith(context);
    const settings = yield* Settings.Settings;
    // Rejects with what Node's file system failed with, as the consumers saw before.
    const saveSettings = (patch: Partial<Settings.SettingsValues>) =>
      runPromise(
        settings.update(patch).pipe(
          Effect.asVoid,
          Effect.catchTag('PlatformError', (error) => Effect.fail(error.cause ?? error)),
        ),
      );
    const secretVault = yield* SecretVault.SecretVault;
    const vault: SecretVault.PromiseSecretVault = {
      read: (key) => runPromise(secretVault.read(key).pipe(Effect.map(Redacted.value))),
      write: (key, value) => runPromise(secretVault.write(key, Redacted.make(value))),
    };
    const chatgpt = yield* ChatGPTAuth.ChatGPTAuth;
    const auth = promiseChatGPTAuth(chatgpt, context);
    const modelConnections = yield* ModelConnections.ModelConnections;
    const modelCatalog = yield* ModelCatalog.ModelCatalog;
    // For the turn runner and the agent server.
    const connections = promiseModelConnections(modelConnections, context);
    // For the synchronous readers: the turn runner and the desktop status.
    const connectionReads = {
      list: () => runSync(modelConnections.list),
      hasProvider: () => runSync(modelConnections.hasProvider),
      connected: (model: string) => runSync(modelConnections.connected(model)),
      provider: (model: string) => runSync(modelConnections.provider(model)),
    };
    const telemetry = yield* UsageTelemetry.UsageTelemetry;
    const searchTelemetry = {
      webSearch: (search: UsageTelemetry.WebSearchTelemetry) => {
        runFork(telemetry.webSearch(search));
      },
    };
    // The turn runner observes stream events synchronously.
    const turnTelemetry = (
      isCustomMcpConnection: (connection: string) => boolean,
    ): TurnTelemetry => ({
      chat: (mode, outcome, duration, errorCode, firstTextMs, usage, details = {}) => {
        runFork(
          telemetry.chat({ mode, outcome, duration, errorCode, firstTextMs, usage, ...details }),
        );
      },
      toolObserver: () => {
        const observer = runSync(telemetry.toolObserver(isCustomMcpConnection));
        return (event) => runSync(observer.observe(event));
      },
      usageObserver: () => {
        const observer = runSync(telemetry.usageObserver);
        return {
          observe: (event) => runSync(observer.observe(event)),
          usage: () => runSync(observer.usage),
        };
      },
    });
    const features = yield* Features.Features;
    // Rejects as `saveSettings` does when the override cannot be saved.
    const setFeature = (id: string, enabled: boolean | null) =>
      runPromise(
        features
          .set(id, enabled)
          .pipe(Effect.catchTag('PlatformError', (error) => Effect.fail(error.cause ?? error))),
      );
    const capabilitySettings = yield* Capabilities.CapabilitySettings;
    const integrationState = yield* Capabilities.IntegrationState;
    // For the synchronous readers of the capabilities: the agent server, the
    // agent's game access, the routine scheduler and the status and snapshot.
    const capabilityReads = {
      enabled: (id: string) => runSync(capabilitySettings.enabled(id)),
      snapshot: () => runSync(capabilitySettings.snapshot),
    };
    // The turn runner also publishes them before each turn.
    const turnCapabilities = {
      ...capabilityReads,
      publish: () => runPromise(capabilitySettings.publish),
    };
    // End of adapters.
    const { mcpConfig } = yield* settings.get;
    const mcpFile = mcpConfig
      ? path.resolve(paths.dataRoot, mcpConfig)
      : path.join(runtime, 'mcp.json');
    const mcpManager = McpManager.make(
      ROOT,
      {
        async readConfig() {
          try {
            return await readFile(mcpFile, 'utf8');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            return undefined;
          }
        },
        writeConfig: (servers) => writeJson(mcpFile, { servers }),
        readSecret: (key) => vault.read(key),
        writeSecret: (key, value) => vault.write(key, value),
      },
      [Everloot.profile],
    );
    yield* Effect.addFinalizer(() => mcpManager.close());
    yield* mcpManager.load();
    const modelFailures = new ModelFailures();
    const webSearch = new WebSearch(path.join(runtime, 'search.json'), vault, auth);
    yield* startup(() => webSearch.load());
    yield* Effect.addFinalizer(() => chatgpt.cancel);
    const database = yield* TheWoWDB.TheWoWDB;
    const storage = yield* Layer.build(
      MemoryRepository.layer.pipe(Layer.provideMerge(Sql.layer(databaseFile))),
    );
    const { db: sql } = Context.get(storage, Sql.SqlDatabase);
    yield* importProductData(databaseFile, sql);
    const memoryRepository = Context.get(storage, MemoryRepository.MemoryRepository);
    const memorySnapshot = Effect.fn('Memory.snapshot')(function* (identity: string | undefined) {
      const preferences = yield* memoryRepository.read({
        slot: 'preferences',
        owner: 'local-player',
      });
      const character = identity
        ? yield* memoryRepository.read({ slot: 'character', owner: identity })
        : [];
      return {
        status: 'available',
        entries: [
          ...preferences.map((entry) => ({ ...entry, slot: 'preferences' })),
          ...character.map((entry) => ({ ...entry, slot: 'character' })),
        ],
      };
    });
    const panelStore = new PanelStore(applicationDatabase);
    yield* startup(() => panelStore.load());
    const routineStore = new RoutineStore(applicationDatabase);
    yield* startup(() => routineStore.load());
    const simulatorAvailable = yield* simulator.available;
    yield* capabilitySettings.setAvailability({
      'integration:wowsims': {
        available: simulatorAvailable,
        status: simulatorAvailable ? 'ready' : 'missing',
        reason: 'Experimental local mage engine, levels 1–60.',
      },
    });
    const mcpCapabilities = createMcpCapabilities(mcpManager, capabilitySettings);
    yield* mcpCapabilities.refreshCatalog;
    yield* mcpCapabilities.applySavedSettings();
    yield* capabilitySettings.publish;
    const chatStore = new ChatStore(applicationDatabase, (error) =>
      runFork(
        Effect.logError('Conversation save failed').pipe(
          Effect.annotateLogs({ event: 'chat.save_failed', error: errorMessage(error) }),
        ),
      ),
    );
    const state = createSessionState(yield* startup(() => chatStore.load()));
    yield* releaseRuntimeResource(async () => {
      try {
        await chatStore.flush(state.chats);
      } finally {
        await chatStore.close();
      }
    });
    const refreshModelCatalog = () => {
      runFork(modelCatalog.refresh);
    };
    // The default follows the providers the player connected, not one vendor's model.
    const defaultModel = () => resolveDefaultModel(runSync(settings.get).model, state.modelCatalog);
    const accounts = createAccountOperations({
      isStopping: () => shutdownRequested,
      hasActiveTurn: () => state.chats.some((c) => c.status === 'working'),
      afterOperation: refreshModelCatalog,
    });
    // The app update the desktop last reported; the desktop resends it after a restart.
    let appUpdateVersion: string | null = null;
    const publisher: SnapshotPublisher = yield* createSnapshotPublisher({
      state,
      transport: () => transport.current(),
      inputs: () => {
        const character = state.currentCharacterKey;
        return {
          connected: engineReady,
          bridgeVersion,
          expectedAddonVersion,
          appUpdateVersion,
          contextWindowTokens: state.modelCatalog.find((m) => m.slug === defaultModel())
            ?.contextWindow,
          defaultModel: defaultModel(),
          panels: character ? panelStore.list(character) : [],
          routines: character ? routineStore.list(character) : [],
          routineRuns: character
            ? routineStore.history({ characterKey: character, includeSilent: false, limit: 50 })
            : [],
          routinesAllowed: !!character && capabilityReads.enabled('tool:manage_routine'),
          capabilities: capabilityReads.snapshot(),
          features: runSync(features.values),
        };
      },
    });
    yield* releaseRuntimeResource(() => publisher.stop());
    // Adapter for SessionState, which is not migrated: each catalog a refresh
    // loads is copied into it, once `changed()` can publish it. Subscribed
    // before the first refresh starts, so its catalog is not missed.
    yield* modelCatalog.changes.pipe(
      Stream.runForEach(({ models, error }) =>
        Effect.sync(() => {
          state.modelCatalog = [...models];
          state.modelCatalogError = Option.getOrUndefined(error);
          changed();
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
    // End of adapter.
    if (yield* modelConnections.hasProvider) refreshModelCatalog();
    const bridge = Context.get(
      yield* Layer.build(WowBridge.layer.pipe(Layer.provide(wowPlatform))),
      WowBridge.WowBridge,
    );
    const token = randomBytes(32).toString('hex');
    // The agent runs in process; its model history lives next to the chats.
    const agentHistory = new AgentHistory(applicationDatabase, { wispVersion: bridgeVersion });
    const memoryAccess = AgentMemoryAccess.make({
      repository: memoryRepository,
      chats: () => state.chats,
      currentTransport: () => state.activeTransport,
      capabilities: capabilitySettings,
      snapshot: memorySnapshot,
      setView: (view) => {
        state.memoryView = view;
      },
      changed,
    });
    let engineReady = false;
    const gameAccess = AgentGameAccess.make({
      getChats: () => state.chats,
      currentTransport: () => state.activeTransport,
      requestGame: (call) => transport.request(call),
      capabilitySettings: capabilityReads,
      mcpManager,
    });
    const agentConfig = Agent.EngineConfig.of({
      origin: () => agentOrigin,
      token,
    });
    const agentMcp = AgentMcp.layerFromManager(mcpManager, {
      allowed: (server, tool) =>
        capabilityReads.enabled('mcp:' + server) &&
        (!tool || capabilityReads.enabled('mcp_tool:' + server + ':' + tool)),
      readOnly: (session) =>
        state.chats.some(
          (chat) => chat.agentSession === session && chat.proactive && chat.status === 'working',
        ),
    });
    const agentLayer = Agent.layer.pipe(
      Layer.provide(agentMcp),
      Layer.provide(AgentCapabilities.layerFromFile(() => capabilitySettings.agentFile)),
      Layer.provide(NodeFileSystem.layer),
      Layer.provide(Agent.SessionHistory.layer(agentHistory)),
      Layer.provide(Layer.succeed(Agent.EngineConfig, agentConfig)),
      Layer.provide(Layer.succeed(Game.Service, gameAccess)),
      Layer.provide(Layer.succeed(Memory.Service, memoryAccess)),
      Layer.provideMerge(bridgeLogging),
    );
    const engine = Agent.make(agentLayer);
    async function readSimulationCharacter(chat = 'desktop-simulation'): Promise<unknown> {
      if (!state.activeTransport || !capabilityReads.enabled('tool:query_character')) {
        throw Error('Connect WoW and enable Character readings first.');
      }
      return runPromise(
        transport.request({
          chat,
          session: state.activeTransport,
          operation: { kind: 'read', sections: ['character', 'talents', 'spells', 'gear'] },
        }),
      );
    }
    function changed() {
      publisher.changed();
      if (!shutdownRequested) {
        chatStore.schedule(() => state.chats);
      }
    }
    // A saved override changed a flag: the agent reads it on its next turn, the
    // addon on its next snapshot and the desktop on its next status poll. The
    // capabilities read the flags from `Features`, so they only need publishing.
    const featuresChanged = capabilitySettings.publish.pipe(
      Effect.catch((error) =>
        Effect.logWarning('Feature flags could not reach the agent').pipe(
          Effect.annotateLogs({ event: 'features.publish_failed', error: errorMessage(error) }),
        ),
      ),
      Effect.andThen(Effect.sync(changed)),
    );
    // Subscribed before this returns, so no saved override is missed.
    yield* features.changes.pipe(
      Stream.runForEach(() => featuresChanged),
      Effect.forkScoped({ startImmediately: true }),
    );
    const run = yield* createTurnRunner({
      // Tools of the MCP connections the player added stay generic.
      telemetry: turnTelemetry((name) =>
        Object.hasOwn(mcpManager.servers, name.replace(/-/g, '_')),
      ),
      modelFailures,
      modelProvider: connectionReads.provider,
      engine,
      models: connections,
      capabilitySettings: turnCapabilities,
      changed,
      currentTransport: () => state.activeTransport,
      activeChat: () => state.activeChat,
      defaultModel,
      isReady: () => engineReady,
      isStopping: () => shutdownRequested,
      accountBusy: accounts.busy,
      hasProvider: connectionReads.hasProvider,
      isCurrent: (chat) => state.chats.includes(chat),
      flushSnapshot: publisher.flush,
    });
    yield* releaseRuntimeResource(async () => {
      state.chats.forEach(run.interrupt);
      await run.drain();
    });
    const stopRoutineScheduler = yield* startRoutineScheduler({
      state,
      routineStore,
      capabilitySettings: capabilityReads,
      run,
      changed,
      isStopping: () => shutdownRequested,
      isReady: () => engineReady,
    });
    yield* releaseRuntimeResource(stopRoutineScheduler);
    const adoptCharacter = createCharacterAdoption({
      db: sql,
      panelStore,
      chats: () => state.chats,
      changed,
    });
    const receivePacket = yield* createPacketReceiver({
      telemetry,
      state,
      engine,
      request: (call) => transport.request(call),
      integrationState,
      capabilitySettings,
      models: modelConnections,
      routineStore,
      panelStore,
      memoryRepository,
      catalog: modelCatalog,
      setCapability: mcpCapabilities.setCapability,
      memorySnapshot,
      run,
      adoptCharacter,
      interrupt: run.interrupt,
      cancel: run.cancel,
      runtime,
      changed,
    });
    const observeGameConnection = Effect.suspend(() =>
      telemetry.gameConnectionProgress({
        connected: transport.gameConnected(),
        hasReadySnapshot: transport.current()?.status().readyPublished ?? false,
      }),
    );
    const receive = Effect.fnUntraced(function* (packet: Parameters<typeof receivePacket>[0]) {
      const previousSession = state.activeTransport;
      yield* observeGameConnection;
      yield* receivePacket(packet);
      if (state.activeTransport !== previousSession) {
        yield* telemetry.gameConnectionStarted;
      }
    });
    const transport: TransportConnection = yield* createTransportConnection({
      state,
      bridge,
      integrationState,
      capabilitySettings,
      receive,
      saveWow: (wow) => saveSettings({ wow }),
      changed,
      isStopping: () => shutdownRequested,
    }).pipe(Effect.provide(wowPlatform));
    yield* Effect.addFinalizer(() => transport.serialize(transport.disconnect));
    const server = createServer(
      yield* createAgentHandler({
        telemetry: searchTelemetry,
        modelFailures,
        token,
        auth,
        connections,
        webSearch,
        capabilitySettings: capabilityReads,
        routineStore,
        panelStore,
        database,
        simulator,
        getChats: () => state.chats,
        currentTransport: () => state.activeTransport,
        defaultModel,
        readSimulationCharacter,
        presentReply: run.present,
        changed,
      }),
    );
    yield* releaseRuntimeResource(() => closeServer(server));
    yield* releaseRuntimeResource(() => engine.close());
    const agentPort = yield* startup(() => listenOnLoopback(server, options.agentPort ?? 43187));
    const agentOrigin = 'http://127.0.0.1:' + agentPort;
    yield* startup(() => writeFile(path.join(runtime, 'bridge.pid'), String(process.pid)));
    setAgentHost({ origin: agentOrigin, token });
    yield* releaseRuntimeResource(() => accounts.drain());
    const fs = yield* FileSystem.FileSystem;
    yield* Effect.all(
      [
        AppConfig.retireLegacyEngine(paths.legacyEngine),
        fs.remove(path.join(runtime, 'eve.log'), { force: true }),
      ],
      { concurrency: 'unbounded', discard: true },
    ).pipe(
      Effect.catch((error) =>
        Effect.logWarning('Could not remove the old Eve engine folder').pipe(
          Effect.annotateLogs({
            event: 'agent.legacy_engine_cleanup_failed',
            error: errorMessage(error),
          }),
        ),
      ),
      Effect.forkDetach,
    );
    // Histories no conversation refers to belong to deleted chats or reset sessions.
    yield* startup(() => agentHistory.prune()).pipe(
      Effect.catch((error) =>
        Effect.logWarning('Could not prune agent history').pipe(
          Effect.annotateLogs({
            event: 'agent.history_prune_failed',
            error: errorMessage(error),
          }),
        ),
      ),
    );
    const engineStartup = engine.preload().then(
      () => {
        engineReady = true;
        changed();
      },
      (error: unknown) =>
        runFork(
          Effect.logError('Agent failed to load').pipe(
            Effect.annotateLogs({ event: 'agent.preload_failed', error: errorMessage(error) }),
          ),
        ),
    );
    function desktopStatus(): Status {
      const characters = readCharacterNames(applicationDatabase.orm);
      return {
        ready: engineReady,
        gameConnected: transport.gameConnected(),
        auth: auth.state(),
        connections: connectionReads.list(),
        modelConnected: connectionReads.connected(defaultModel()),
        search: webSearch.state(),
        model: defaultModel(),
        activeTurns: state.chats.filter((c) => c.status === 'working').length,
        integrations: capabilityReads.snapshot(),
        mcps: mcpManager.list().map((s) => ({
          ...s,
          enabled: s.enabled && capabilityReads.enabled('mcp:' + s.name),
        })),
        panels: panelStore.panels.map((p) => ({
          ...p,
          character: characterLabel(p.characterKey, characters, ' - '),
        })),
        routines: routineStore.list(),
        routineRuns: routineStore.history({ includeSilent: false, limit: 200 }),
        characters,
        appUpdate: appUpdateVersion,
        features: runSync(features.state),
      };
    }
    let desktopStopTimer: ReturnType<typeof setTimeout> | undefined;
    const desktopApp = yield* createDesktopApp({
      auth,
      connections: modelConnections,
      webSearch,
      capabilitySettings,
      mcpManager,
      panelStore,
      routineStore,
      accountOperation: accounts.run,
      readSimulationCharacter,
      setCapability: mcpCapabilities.setCapability,
      refreshMcpCatalog: mcpCapabilities.refreshCatalog,
      changed,
      setWowTransport: (input) =>
        transport.serialize(
          Effect.gen(function* () {
            if (shutdownRequested) return yield* Effect.fail(Error('Wisp is stopping.'));
            if (input.action === 'pause') {
              if (state.chats.some((chat) => chat.status === 'working')) {
                return yield* Effect.fail(
                  Error('Wait for the active turn before installing the addon.'),
                );
              }
              yield* transport.disconnect;
            } else {
              yield* transport.connect(
                input.wow ?? (yield* settings.get).wow,
                input.wow !== undefined,
              );
            }
          }),
        ),
      setFeature,
      setAppUpdate: (version) => {
        appUpdateVersion = version;
      },
      getStatus: desktopStatus,
      getChats: () => state.chats,
      currentCharacterKey: () => state.currentCharacterKey,
      sendPanelCommand: (command) => {
        state.panelCommand = command;
      },
      openRoutine: (id) => {
        state.activeChat = id;
        state.routineCommand = { seq: Date.now(), id };
      },
      updateModel: async (model) => {
        if (shutdownRequested) {
          throw Error('Wisp is stopping.');
        }
        await saveSettings({ model });
      },
      requestStop: () => {
        shutdownRequested = true;
        // Let the desktop response reach the caller before we close its listener.
        desktopStopTimer ??= setTimeout(requestStop, 200);
      },
    });
    const desktopServer = yield* startup(() =>
      startDesktopServer(runtime, desktopApp, options.desktopPort),
    );
    yield* releaseRuntimeResource(() => closeServer(desktopServer));
    const transportStartup = yield* (
      appConfig.deferWowTransport
        ? Effect.void
        : transport.serialize(transport.connect((yield* settings.get).wow)).pipe(
            Effect.catchDefect((error) => Effect.fail(error)),
            Effect.catch((error) => Effect.sync(() => transport.logError(error))),
          )
    ).pipe(Effect.forkChild());
    // A report that stopped counting changes what the addon and the desktop see.
    yield* integrationState.healthChecks.pipe(
      Stream.runForEach(() => Effect.sync(changed)),
      Effect.forkScoped,
    );
    // Snapshots publish from changed(); this tick only polls what has no event:
    // the addon's acknowledged revision, and a publish that is still dirty
    // because the transport was missing or its last write failed.
    const publish = setInterval(() => {
      runFork(observeGameConnection);
      publisher.retry();
    }, PUBLISH_MIN_INTERVAL_MS);
    yield* Effect.logInfo('Wisp started').pipe(
      Effect.annotateLogs({
        event: 'bridge.started',
        version: bridgeVersion,
        channel: features.channel,
      }),
    );
    yield* releaseRuntimeResource(() => clearInterval(publish));
    // Prevent new work before draining resources on shutdown.
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        shutdownRequested = true;
        clearTimeout(desktopStopTimer);
        state.chats.forEach(run.interrupt);
      }),
    );
    yield* startup(() => engineStartup);
    yield* Fiber.join(transportStartup);
    return {
      state,
      receive: (packet: Parameters<typeof receive>[0]) => runPromise(receive(packet)),
    };
  },
  // The existing Promise-based acquisitions cannot be interrupted safely.
  Effect.uninterruptible,
  Effect.catchDefect((error) => Effect.fail(error)),
);

function startup<A>(operation: () => Promise<A>) {
  return Effect.tryPromise({ try: operation, catch: (error) => error });
}

// Adapter for unmigrated consumers: `makeServer` and the eval bridge build it.
// Remove it when the consumers of `PromiseChatGPTAuth` migrate.
/**
 * Runs `ChatGPTAuth` with `context` behind the Promise interface its
 * unmigrated consumers take. Their checks see the rejections they saw before:
 * a `ChatGPTAuthError` or vault error as is, a failed request as what `fetch`
 * failed with, and an aborted `authorized` call as its signal's reason.
 */
export function promiseChatGPTAuth(
  auth: ChatGPTAuth.ChatGPTAuth['Service'],
  context: Context.Context<never>,
): ChatGPTAuth.PromiseChatGPTAuth {
  const runPromise = Effect.runPromiseWith(context);
  const runSync = Effect.runSyncWith(context);
  const run = <A>(
    effect: Effect.Effect<
      A,
      ChatGPTAuth.ChatGPTAuthError | ChatGPTAuth.ChatGPTRequestError | SecretVault.SecretVaultError
    >,
  ) =>
    runPromise(
      effect.pipe(Effect.catchTag('ChatGPTRequestError', (error) => Effect.fail(error.cause))),
    );
  const authorized = (url: string, init: ChatGPTAuth.ChatGPTRequestInit) => {
    const base = HttpClientRequest.make(init.method)(url, { headers: init.headers });
    const request =
      init.body === undefined
        ? base
        : HttpClientRequest.bodyText(
            base,
            init.body,
            new Headers(init.headers).get('content-type') ?? undefined,
          );
    return promiseResponse(
      auth
        .authorized(request)
        .pipe(Effect.catchTag('ChatGPTRequestError', (error) => Effect.fail(error.cause))),
      init.signal,
      context,
    );
  };
  return {
    state: () => runSync(auth.state),
    get pending() {
      return runSync(auth.state).status === 'authorizing';
    },
    beginSignIn: (profileId, newAccount) => run(auth.beginSignIn({ profileId, newAccount })),
    cancel: () => runPromise(auth.cancel),
    select: (id) => run(auth.select(id)),
    accessToken: () => run(auth.accessToken.pipe(Effect.map(Redacted.value))),
    disconnect: () => run(auth.disconnect),
    models: () => run(auth.models),
    authorized,
  };
}

/** Rejects like `fetch`: with the signal's reason once it aborted, else with `error`. */
const rejectLikeFetch = (signal: AbortSignal | undefined) => (error: unknown) => {
  throw signal?.aborted ? signal.reason : error;
};

/**
 * Runs `effect` with `context` as a fetch-like call: the response body stays
 * open in the effect's scope until it ends or `signal` aborts, and like a
 * fetch body it fails with the signal's reason when the signal aborts.
 */
function promiseResponse<E>(
  effect: Effect.Effect<HttpClientResponse.HttpClientResponse, E, Scope.Scope>,
  signal: AbortSignal | undefined,
  context: Context.Context<never>,
): Promise<Response> {
  const runFork = Effect.runForkWith(context);
  return Effect.runPromiseWith(context)(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const release = () => {
        runFork(Scope.close(scope, Exit.void));
      };
      signal?.addEventListener('abort', release, { once: true });
      const response = yield* effect.pipe(
        Scope.provide(scope),
        Effect.onError(() => Scope.close(scope, Exit.void)),
      );
      const web = Option.getOrElse(
        HttpClientResponse.toWeb(response),
        () =>
          new Response(Stream.toReadableStream(response.stream), {
            status: response.status,
            headers: response.headers,
          }),
      );
      if (!web.body) {
        release();
        return web;
      }
      const body = web.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({ flush: release }),
        signal ? { signal } : {},
      );
      return new Response(body, web);
    }),
    { signal },
  ).catch(rejectLikeFetch(signal));
}

/**
 * Runs `ModelConnections` with `context` behind the Promise interface its
 * unmigrated consumers take. They see the rejections they saw before: Wisp's
 * and the provider's refusals, ChatGPT and vault errors as they are, a failed
 * request as what `fetch` or the AI SDK failed with, and an aborted call as
 * its signal's reason.
 */
export function promiseModelConnections(
  connections: ModelConnections.ModelConnections['Service'],
  context: Context.Context<never>,
): ModelConnections.PromiseModelConnections {
  const runPromise = Effect.runPromiseWith(context);
  return {
    models: () =>
      runPromise(
        connections.models.pipe(
          Effect.catchTag('ChatGPTRequestError', (error) => Effect.fail(error.cause)),
        ),
      ),
    prepare: (model) => runPromise(connections.prepare(model)),
    complete: (model, instructions, text, signal) =>
      runPromise(
        connections.complete(model, instructions, text).pipe(
          Effect.catchTags({
            ChatGPTRequestError: (error) => Effect.fail(error.cause),
            ModelRequestError: (error) => Effect.fail(error.cause),
          }),
        ),
        { signal },
      ).catch(rejectLikeFetch(signal)),
    selection: (model) =>
      runPromise(connections.selection(model).pipe(Effect.map(Option.getOrElse(() => ({}))))),
    forward: (id, suffix, body, headers, signal) =>
      promiseResponse(
        connections
          .forward({ connection: id, path: suffix, body, headers: HttpHeaders.fromInput(headers) })
          .pipe(Effect.catchTag('ModelRequestError', (error) => Effect.fail(error.cause))),
        signal,
        context,
      ),
  };
}
// End of adapter.

export function startServer(options: ServerOptions = {}) {
  const server = startServerEffect(options).pipe(
    Effect.provide(Layer.merge(ServerLayer, bridgeLogging)),
  );
  return Effect.runPromise(
    options.configProvider
      ? server.pipe(Effect.provideService(ConfigProvider.ConfigProvider, options.configProvider))
      : server,
  );
}

export const startServerEffect = Effect.fnUntraced(function* (options: ServerOptions = {}) {
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const resources = new RuntimeResources();
  const stop = () => resources.close();
  const server = yield* makeServer(options, () => {
    void stop().catch((error: unknown) =>
      runFork(
        Effect.logError('Bridge shutdown failed').pipe(
          Effect.annotateLogs({ event: 'bridge.shutdown_failed', error: errorMessage(error) }),
        ),
      ),
    );
  }).pipe(
    Scope.provide(resources.scope),
    Effect.onExit((exit) =>
      Exit.isFailure(exit)
        ? startup(() => resources.close(exit)).pipe(
            Effect.catch((error) =>
              Effect.logError('Bridge cleanup failed').pipe(
                Effect.annotateLogs({ event: 'bridge.cleanup_failed', error: errorMessage(error) }),
              ),
            ),
          )
        : Effect.void,
    ),
  );
  return { ...server, stop };
});

function closeServer(server: import('node:http').Server) {
  return new Promise<void>((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}
