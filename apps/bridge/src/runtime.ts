import { characterLabel } from '@wisp/protocol/character-key';
import { RuntimeResources } from './runtime-resources.ts';
import { UsageTelemetry } from './telemetry.ts';
import { ModelFailures } from './models/model-failures.ts';
import { startRoutineScheduler } from './routines/routine-scheduler.ts';
import { createPacketReceiver } from './addon/packet-receiver.ts';
import { createCharacterAdoption } from './chat/character-adoption.ts';
import { readCharacterNames } from './db/character-keys.ts';
import { createSessionState } from './session-state.ts';
import { createDesktopApp } from './desktop/desktop-handler.ts';
import type { Status } from '@wisp/protocol/desktop';
import { readJson } from './json-file.ts';
import { loadBridgeConfig } from './bridge-config.ts';
import { z } from 'zod';
import { createAgentHandler } from './agent/agent-server.ts';
import { GameRequests } from './addon/game-requests.ts';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTransportConnection } from './addon/transport-connection.ts';
import type { TransportConnection } from './addon/transport-connection.ts';
import { ChatStore } from './chat/chat-store.ts';
import { applicationDatabaseFile } from './db/application-file.ts';
import { ApplicationDatabase } from './db/application-database.ts';
import { createTurnRunner } from './agent/turn-runner.ts';
import { errorMessage } from './errors.ts';
import { Effect } from 'effect';
import type { Context } from 'effect';
import { bridgeLogging } from './logger.ts';
import { MemoryStore } from './agent/memory-store.ts';
import { IntegrationState } from './integrations/integration-state.ts';
import { existsSync } from 'node:fs';
import { CapabilitySettings } from './integrations/capabilities.ts';
import { createMcpCapabilities } from './integrations/mcp/mcp-capabilities.ts';
import { SnapshotGate } from './addon/snapshots.ts';
import { PUBLISH_MIN_INTERVAL_MS } from './addon/publish-scheduler.ts';
import { createSnapshotPublisher } from './addon/snapshot-publisher.ts';
import type { SnapshotPublisher } from './addon/snapshot-publisher.ts';
import { PanelStore } from './addon/panels.ts';
import { McpManager } from './integrations/mcp/mcp-manager.ts';
import { McpRelay } from './integrations/mcp/mcp-relay.ts';
import { NativeVault, type SecretVault } from './auth/secret-vault.ts';
import { startDesktopServer } from './desktop/desktop-server.ts';
import { listenOnLoopback } from './loopback-server.ts';
import { RoutineStore } from './routines/routine-store.ts';
import { ModelConnections } from './models/model-connections.ts';
import { createModelCatalogRefresh } from './models/model-catalog.ts';
import { resolveDefaultModel } from './chat/chat-model.ts';
import { createAccountOperations } from './account-operations.ts';
import { WebSearch } from './integrations/search/web-search.ts';
import { ChatGPTAuth } from './auth/chatgpt-auth.ts';
import { TheWoWDB } from './integrations/thewowdb.ts';
import { Simulator } from './integrations/simulation/simulator.ts';
import { appPaths, retireLegacyEngine } from './app-paths.ts';
import { addonVersionFromToc } from './addon/addon-version.ts';
import { Features } from './features.ts';
import { featureChannel } from '@wisp/protocol/features';
import { setAgentHost } from '@wisp/agent/agent-host';
import { createAgentEngine } from '@wisp/agent/engine';
import { AgentHistory } from './agent/agent-history.ts';
export interface BridgeOptions {
  resourceRoot?: string;
  dataDirectory?: string;
  agentPort?: number;
  desktopPort?: number;
  vault?: SecretVault;
  deferWowTransport?: boolean;
}
/**
 * Composition root of the bridge: loads stores and settings, wires the
 * in-process agent engine, the addon transport, the agent and desktop servers, and returns
 * `{ state, receive, stop }`.
 *
 * Cleanup is registered with `resources.defer` and runs in reverse (LIFO), so
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
export function startBridge(options: BridgeOptions = {}) {
  return Effect.runPromise(startBridgeEffect(options).pipe(Effect.provide(bridgeLogging)));
}

export const startBridgeEffect = Effect.fnUntraced(function* (options: BridgeOptions = {}) {
  const context = yield* Effect.context<never>();
  return yield* Effect.tryPromise({
    try: () => openBridge(options, context),
    catch: (error) => error,
  });
});

async function openBridge(options: BridgeOptions, context: Context.Context<never>) {
  const runSync = Effect.runSyncWith(context);
  const runFork = Effect.runForkWith(context);
  const resources = new RuntimeResources();
  // Set by stop() or a desktop stop request; checked by everything that
  // starts work, so nothing new begins while resources close.
  let shutdownRequested = false;
  try {
    const ROOT =
      options.resourceRoot ||
      process.env.WISP_RESOURCE_ROOT ||
      fileURLToPath(new URL('../../../', import.meta.url));
    const paths = appPaths(ROOT, options.dataDirectory);
    const [bridgeVersion, expectedAddonVersion] = await Promise.all([
      readJson(path.join(ROOT, 'package.json'), z.object({ version: z.string().min(1) }), () => ({
        version: 'unknown',
      }))
        .then((metadata) => metadata.version)
        .catch(() => 'unknown'),
      readFile(path.join(ROOT, 'addon/WispAI/WispAI.toc'), 'utf8').then(
        addonVersionFromToc,
        () => undefined,
      ),
    ]);
    const runtime = paths.runtime;
    const simulator = new Simulator(ROOT, runtime);
    await mkdir(runtime, { recursive: true });
    const databaseFile = applicationDatabaseFile(runtime);
    const applicationDatabase = new ApplicationDatabase(databaseFile);
    resources.defer(() => applicationDatabase.close());
    const memoryStore = new MemoryStore(applicationDatabase);
    async function memorySnapshot(identity: string | undefined) {
      const preferences = (await memoryStore.read('preferences', 'local-player')).map((entry) => ({
        ...entry,
        slot: 'preferences',
      }));
      const character = identity
        ? (await memoryStore.read('character', identity)).map((entry) => ({
            ...entry,
            slot: 'character',
          }))
        : [];
      return { status: 'available', entries: [...preferences, ...character] };
    }
    const config = await loadBridgeConfig(paths.config);
    const features = await Features.start({
      channel: featureChannel(bridgeVersion, process.env.WISP_RELEASE_BUILD === '1'),
      overrides: config.get().features ?? {},
      saveOverrides: (overrides) => config.update({ features: overrides }),
      onChange: () => featuresChanged(),
    });
    const mcpConfig = config.get().mcpConfig;
    const mcpFile = mcpConfig
      ? path.resolve(paths.dataRoot, mcpConfig)
      : path.join(runtime, 'mcp.json');
    const vault = options.vault || new NativeVault(paths.desktopExecutable);
    const mcpManager = new McpManager(mcpFile, ROOT, vault);
    await mcpManager.load();
    resources.defer(() => mcpManager.close());
    const telemetry = new UsageTelemetry(paths.dataRoot, bridgeVersion, {
      isCustomMcpConnection: (name) => Object.hasOwn(mcpManager.servers, name.replace(/-/g, '_')),
      enabledFeatures: () => features.enabledNames(),
    });
    resources.defer(() => telemetry.close());
    const auth = runSync(ChatGPTAuth.make(runtime, vault));
    await auth.load();
    const connections = new ModelConnections(path.join(runtime, 'connections.json'), vault, auth);
    await connections.load();
    const modelFailures = new ModelFailures();
    const webSearch = new WebSearch(path.join(runtime, 'search.json'), vault, auth);
    await webSearch.load();
    resources.defer(() => auth.cancel());
    const database = new TheWoWDB();
    const panelStore = new PanelStore(applicationDatabase);
    await panelStore.load();
    const routineStore = new RoutineStore(applicationDatabase);
    await routineStore.load();
    const capabilitySettings = new CapabilitySettings(path.join(runtime, 'capabilities.json'));
    await capabilitySettings.load();
    capabilitySettings.agentFile = path.join(runtime, 'agent-capabilities.json');
    capabilitySettings.features = features.values();
    const integrationState = new IntegrationState(capabilitySettings);
    const simulatorAvailable = existsSync(paths.simulatorExecutable);
    capabilitySettings.availability.set('integration:wowsims', {
      available: simulatorAvailable,
      status: simulatorAvailable ? 'ready' : 'missing',
      reason: 'Experimental local mage engine, levels 1–60.',
    });
    const mcpCapabilities = createMcpCapabilities(mcpManager, capabilitySettings);
    mcpCapabilities.refreshCatalog();
    await mcpCapabilities.applySavedSettings();
    await capabilitySettings.publish();
    const mcpRelay = new McpRelay(
      mcpManager,
      (name, tool) =>
        capabilitySettings.enabled('mcp:' + name) &&
        (!tool || capabilitySettings.enabled('mcp_tool:' + name + ':' + tool)),
    );
    resources.defer(() => mcpRelay.close());
    const chatStore = new ChatStore(applicationDatabase, (error) =>
      runFork(
        Effect.logError('Conversation save failed').pipe(
          Effect.annotateLogs({ event: 'chat.save_failed', error: errorMessage(error) }),
        ),
      ),
    );
    const state = createSessionState(await chatStore.load());
    resources.defer(async () => {
      try {
        await chatStore.flush(state.chats);
      } finally {
        await chatStore.close();
      }
    });
    const refreshModelCatalog = createModelCatalogRefresh({ state, connections, changed });
    // The default follows the providers the player connected, not one vendor's model.
    const defaultModel = () => resolveDefaultModel(config.get().model, state.modelCatalog);
    if (connections.hasProvider()) void refreshModelCatalog();
    const accounts = createAccountOperations({
      isStopping: () => shutdownRequested,
      hasActiveTurn: () => state.chats.some((c) => c.status === 'working'),
      afterOperation: () => void refreshModelCatalog(),
    });
    // The app update the desktop last reported; the desktop resends it after a restart.
    let appUpdateVersion: string | null = null;
    const snapshots = new SnapshotGate();
    const publisher: SnapshotPublisher = runSync(
      createSnapshotPublisher({
        state,
        snapshots,
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
            routinesAllowed: !!character && capabilitySettings.enabled('tool:manage_routine'),
            capabilities: capabilitySettings.snapshot(),
            features: features.values(),
            requests: pending.snapshot(),
          };
        },
      }),
    );
    resources.defer(() => publisher.stop());
    const pending = new GameRequests(changed, {
      onTimeout: (timeout) =>
        runFork(
          Effect.logWarning('WoW did not answer a request').pipe(
            Effect.annotateLogs({ event: 'game.request_timeout', ...timeout }),
          ),
        ),
    });
    resources.defer(() => pending.cancelAll('Bridge stopped'));
    const token = randomBytes(32).toString('hex');
    // The agent runs in process; its model history lives next to the chats.
    const agentHistory = new AgentHistory(applicationDatabase, { wispVersion: bridgeVersion });
    let engineReady = false;
    const engine = createAgentEngine({
      origin: () => agentOrigin,
      token,
      history: agentHistory,
      mcpConfigFile: () => mcpFile,
      logging: bridgeLogging,
    });
    async function readSimulationCharacter(chat = 'desktop-simulation'): Promise<unknown> {
      if (!state.activeTransport || !capabilitySettings.enabled('tool:query_character')) {
        throw Error('Connect WoW and enable Character readings first.');
      }
      return pending.request({
        chat,
        session: state.activeTransport,
        sections: ['character', 'talents', 'spells', 'gear'],
      });
    }
    mcpRelay.readOnlyMode = () => state.chats.some((c) => c.proactive && c.status === 'working');
    function changed() {
      publisher.changed();
      if (!shutdownRequested) {
        chatStore.schedule(() => state.chats);
      }
    }
    // A saved override changed a flag: the agent reads it on its next turn, the
    // addon on its next snapshot and the desktop on its next status poll.
    function featuresChanged() {
      capabilitySettings.features = features.values();
      void capabilitySettings
        .publish()
        .catch((error) =>
          runFork(
            Effect.logWarning('Feature flags could not reach the agent').pipe(
              Effect.annotateLogs({ event: 'features.publish_failed', error: errorMessage(error) }),
            ),
          ),
        );
      changed();
    }
    const run = runSync(
      createTurnRunner({
        telemetry,
        modelFailures,
        modelProvider: (model) => connections.provider(model),
        engine,
        models: connections,
        capabilitySettings,
        changed,
        currentTransport: () => state.activeTransport,
        activeChat: () => state.activeChat,
        defaultModel,
        isReady: () => engineReady,
        isStopping: () => shutdownRequested,
        accountBusy: accounts.busy,
        hasProvider: () => connections.hasProvider(),
        isCurrent: (chat) => state.chats.includes(chat),
        flushSnapshot: publisher.flush,
      }),
    );
    resources.defer(async () => {
      state.chats.forEach(run.interrupt);
      await run.drain();
    });
    const stopRoutineScheduler = runSync(
      startRoutineScheduler({
        state,
        routineStore,
        capabilitySettings,
        run,
        changed,
        isStopping: () => shutdownRequested,
        isReady: () => engineReady,
      }),
    );
    resources.defer(stopRoutineScheduler);
    const adoptCharacter = createCharacterAdoption({
      database: applicationDatabase,
      panelStore,
      chats: () => state.chats,
      changed,
    });
    const receivePacket = runSync(
      createPacketReceiver({
        telemetry,
        state,
        engine,
        pending,
        integrationState,
        capabilitySettings,
        models: connections,
        routineStore,
        panelStore,
        memoryStore,
        transport: () => transport.current(),
        refreshModelCatalog,
        setCapability: mcpCapabilities.setCapability,
        memorySnapshot,
        run,
        flushAcknowledgment: publisher.flush,
        adoptCharacter,
        interrupt: run.interrupt,
        cancel: run.cancel,
        runtime,
        changed,
      }),
    );
    const receive: typeof receivePacket = (packet) => {
      const previousSession = state.activeTransport;
      observeGameConnection();
      receivePacket(packet);
      if (state.activeTransport !== previousSession) {
        telemetry.gameConnectionStarted();
      }
    };
    const transport: TransportConnection = runSync(
      createTransportConnection({
        state,
        pending,
        integrationState,
        snapshots,
        capabilitySettings,
        receive,
        saveWow: (wow) => config.update({ wow }),
        changed,
        isStopping: () => shutdownRequested,
      }),
    );
    resources.defer(() => transport.serialize(transport.disconnect));
    const server = createServer(
      runSync(
        createAgentHandler({
          telemetry,
          modelFailures,
          token,
          auth,
          connections,
          webSearch,
          mcpRelay,
          capabilitySettings,
          routineStore,
          panelStore,
          memoryStore,
          pending,
          database,
          simulator,
          getChats: () => state.chats,
          currentTransport: () => state.activeTransport,
          defaultModel,
          readSimulationCharacter,
          memorySnapshot,
          presentReply: run.present,
          setMemoryView: (view) => {
            state.memoryView = view;
          },
          changed,
        }),
      ),
    );
    resources.defer(() => closeServer(server));
    const agentPort = await listenOnLoopback(server, options.agentPort ?? 43187);
    const agentOrigin = 'http://127.0.0.1:' + agentPort;
    await writeFile(path.join(runtime, 'bridge.pid'), String(process.pid));
    setAgentHost({ origin: agentOrigin, token, capabilitiesFile: capabilitySettings.agentFile });
    resources.defer(() => engine.close());
    resources.defer(() => accounts.drain());
    void Promise.all([
      retireLegacyEngine(paths.legacyEngine),
      rm(path.join(runtime, 'eve.log'), { force: true }),
    ]).catch((error: unknown) =>
      runFork(
        Effect.logWarning('Could not remove the old Eve engine folder').pipe(
          Effect.annotateLogs({
            event: 'agent.legacy_engine_cleanup_failed',
            error: errorMessage(error),
          }),
        ),
      ),
    );
    // Histories no conversation refers to belong to deleted chats or reset sessions.
    await agentHistory.prune().catch((error: unknown) =>
      runFork(
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
    function observeGameConnection() {
      telemetry.gameConnectionProgress(
        transport.gameConnected(),
        Boolean(state.firstReadyRevision),
      );
    }
    function desktopStatus(): Status {
      const characters = readCharacterNames(applicationDatabase.orm);
      return {
        ready: engineReady,
        gameConnected: transport.gameConnected(),
        auth: auth.state(),
        connections: connections.list(),
        modelConnected: connections.connected(defaultModel()),
        search: webSearch.state(),
        model: defaultModel(),
        activeTurns: state.chats.filter((c) => c.status === 'working').length,
        integrations: capabilitySettings.snapshot(),
        mcps: mcpManager.list().map((s) => ({
          ...s,
          enabled: s.enabled && capabilitySettings.enabled('mcp:' + s.name),
        })),
        panels: panelStore.panels.map((p) => ({
          ...p,
          character: characterLabel(p.characterKey, characters, ' - '),
        })),
        routines: routineStore.list(),
        routineRuns: routineStore.history({ includeSilent: false, limit: 200 }),
        characters,
        appUpdate: appUpdateVersion,
        features: features.state(),
      };
    }
    const desktopApp = createDesktopApp({
      auth,
      connections,
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
        transport.serialize(async () => {
          if (shutdownRequested) throw Error('Wisp is stopping.');
          if (input.action === 'pause') {
            if (state.chats.some((chat) => chat.status === 'working')) {
              throw Error('Wait for the active turn before installing the addon.');
            }
            await transport.disconnect();
          } else {
            await transport.connect(input.wow ?? config.get().wow, input.wow !== undefined);
          }
        }),
      setFeature: (id, enabled) => features.set(id, enabled),
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
        await config.update({ model });
      },
      requestStop: () => {
        shutdownRequested = true;
        setTimeout(
          () =>
            void stop().catch((error) =>
              runFork(
                Effect.logError('Bridge shutdown failed').pipe(
                  Effect.annotateLogs({
                    event: 'bridge.shutdown_failed',
                    error: errorMessage(error),
                  }),
                ),
              ),
            ),
          200,
        );
      },
    });
    const desktopServer = await startDesktopServer(runtime, desktopApp, options.desktopPort);
    resources.defer(() => closeServer(desktopServer));
    const transportStartup =
      options.deferWowTransport || process.env.WISP_DEFER_WOW_TRANSPORT === '1'
        ? Promise.resolve()
        : transport.serialize(() => transport.connect(config.get().wow)).catch(transport.logError);
    const integrationHealth = setInterval(() => {
      const before = JSON.stringify(capabilitySettings.snapshot());
      integrationState.refresh();
      if (JSON.stringify(capabilitySettings.snapshot()) !== before) {
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
    }, 30000);
    resources.defer(() => clearInterval(integrationHealth));
    // Snapshots publish from changed(); this tick only polls what has no event:
    // the addon's acknowledged revision, and a publish that is still dirty
    // because the transport was missing or its last write failed.
    const publish = setInterval(() => {
      observeGameConnection();
      publisher.retry();
    }, PUBLISH_MIN_INTERVAL_MS);
    runFork(
      Effect.logInfo('Wisp started').pipe(
        Effect.annotateLogs({
          event: 'bridge.started',
          version: bridgeVersion,
          channel: features.channel,
        }),
      ),
    );
    resources.defer(() => clearInterval(publish));
    function stop() {
      shutdownRequested = true;
      pending.cancelAll('Bridge stopped');
      state.chats.forEach(run.interrupt);
      return resources.close();
    }
    await Promise.all([engineStartup, transportStartup]);
    return { state, receive, stop };
  } catch (error) {
    await resources.close().catch((cleanupError) =>
      runFork(
        Effect.logError('Bridge cleanup failed').pipe(
          Effect.annotateLogs({
            event: 'bridge.cleanup_failed',
            error: errorMessage(cleanupError),
          }),
        ),
      ),
    );
    throw error;
  }
}
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
