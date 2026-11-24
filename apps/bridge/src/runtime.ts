import { characterLabel } from '@wisp/protocol/character-key';
import { Cause, Duration, Effect } from 'effect';
import { RuntimeResources } from './runtime-resources.ts';
import { makeAppRuntime } from './app-runtime.ts';
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
import { ChatStore } from './chat/chat-store.ts';
import { applicationDatabaseFile } from './db/application-file.ts';
import { ApplicationDatabase } from './db/application-database.ts';
import { createTurnRunner } from './agent/turn-runner.ts';
import { errorMessage } from './errors.ts';
import { bridgeLogger as logger } from './logger.ts';
import { MemoryStore } from './agent/memory-store.ts';
import { IntegrationState } from './integrations/integration-state.ts';
import { existsSync } from 'node:fs';
import { CapabilitySettings } from './integrations/capabilities.ts';
import { createMcpCapabilities } from './integrations/mcp/mcp-capabilities.ts';
import { SnapshotGate } from './addon/snapshots.ts';
import { PUBLISH_MIN_INTERVAL_MS } from './addon/publish-scheduler.ts';
import { createSnapshotPublisher } from './addon/snapshot-publisher.ts';
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
export async function startBridge(options: BridgeOptions = {}) {
  const resources = new RuntimeResources();
  // Effect code runs on one runtime built from AppLayer; it is released last.
  const appRuntime = makeAppRuntime();
  resources.defer(() => appRuntime.dispose());
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
    const auth = new ChatGPTAuth(runtime, vault);
    await auth.load();
    const connections = new ModelConnections(path.join(runtime, 'connections.json'), vault, auth);
    await connections.load();
    const modelFailures = new ModelFailures();
    const webSearch = new WebSearch(path.join(runtime, 'search.json'), vault, auth, appRuntime);
    await webSearch.load();
    resources.defer(() => auth.cancel());
    const database = {
      query: (input: Parameters<TheWoWDB['Service']['query']>[0], signal?: AbortSignal) =>
        appRuntime.runPromise(
          TheWoWDB.use((db) => db.query(input)),
          signal ? { signal } : undefined,
        ),
    };
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
      logger.error(
        { event: 'chat.save_failed', error: errorMessage(error) },
        'Conversation save failed',
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
    const publisher = createSnapshotPublisher({
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
      logger,
    });
    resources.defer(() => publisher.stop());
    const pending = new GameRequests(changed, {
      onTimeout: (timeout) =>
        logger.warn({ event: 'game.request_timeout', ...timeout }, 'WoW did not answer a request'),
    });
    resources.defer(() => pending.cancelAll('Bridge stopped'));
    const token = randomBytes(32).toString('hex');
    // The agent runs in process; its model history lives next to the chats.
    const agentHistory = new AgentHistory(applicationDatabase);
    let engineReady = false;
    const engine = createAgentEngine({
      origin: () => agentOrigin,
      token,
      history: agentHistory,
      mcpConfigFile: () => mcpFile,
      logger,
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
          logger.warn(
            { event: 'features.publish_failed', error: errorMessage(error) },
            'Feature flags could not reach the agent',
          ),
        );
      changed();
    }
    const run = createTurnRunner({
      telemetry,
      modelFailures,
      modelProvider: (model) => connections.provider(model),
      engine,
      models: connections,
      capabilitySettings,
      changed,
      logger,
      currentTransport: () => state.activeTransport,
      activeChat: () => state.activeChat,
      defaultModel,
      isReady: () => engineReady,
      isStopping: () => shutdownRequested,
      accountBusy: accounts.busy,
      hasProvider: () => connections.hasProvider(),
      isCurrent: (chat) => state.chats.includes(chat),
      flushSnapshot: publisher.flush,
    });
    resources.defer(async () => {
      state.chats.forEach(run.interrupt);
      await run.drain();
    });
    const stopRoutineScheduler = startRoutineScheduler({
      state,
      routineStore,
      capabilitySettings,
      run,
      changed,
      logger,
      isStopping: () => shutdownRequested,
      isReady: () => engineReady,
    });
    resources.defer(stopRoutineScheduler);
    const adoptCharacter = createCharacterAdoption({
      database: applicationDatabase,
      panelStore,
      chats: () => state.chats,
      changed,
      logger,
    });
    const receivePacket = createPacketReceiver({
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
      logger,
    });
    const receive: typeof receivePacket = (packet) => {
      const previousSession = state.activeTransport;
      observeGameConnection();
      receivePacket(packet);
      if (state.activeTransport !== previousSession) {
        telemetry.gameConnectionStarted();
      }
    };
    const transport = createTransportConnection({
      state,
      pending,
      integrationState,
      snapshots,
      capabilitySettings,
      receive,
      saveWow: (wow) => config.update({ wow }),
      changed,
      isStopping: () => shutdownRequested,
      logger,
    });
    resources.defer(() => transport.serialize(transport.disconnect));
    const server = createServer(
      createAgentHandler({
        logger,
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
    ]).catch((error) =>
      logger.warn(
        { event: 'agent.legacy_engine_cleanup_failed', error: errorMessage(error) },
        'Could not remove the old Eve engine folder',
      ),
    );
    // Histories no conversation refers to belong to deleted chats or reset sessions.
    await agentHistory
      .prune()
      .catch((error) =>
        logger.warn(
          { event: 'agent.history_prune_failed', error: errorMessage(error) },
          'Could not prune agent history',
        ),
      );
    const engineStartup = engine.preload().then(
      () => {
        engineReady = true;
        changed();
      },
      (error) =>
        logger.error(
          { event: 'agent.preload_failed', error: errorMessage(error) },
          'Agent failed to load',
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
              logger.error(
                { event: 'bridge.shutdown_failed', error: errorMessage(error) },
                'Bridge shutdown failed',
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
    // Background ticks run as fibers in the bridge scope, which interrupts them on
    // stop. A failing tick is logged and the next one still runs.
    const every = (interval: Duration.Input, tick: () => void) =>
      resources.fork(
        appRuntime,
        Effect.forever(
          Effect.sleep(interval).pipe(
            Effect.andThen(Effect.sync(tick)),
            Effect.catchCause((cause) =>
              Effect.logError('Background tick failed').pipe(
                Effect.annotateLogs({ event: 'bridge.tick_failed', error: Cause.pretty(cause) }),
              ),
            ),
          ),
        ),
      );
    every('30 seconds', () => {
      const before = JSON.stringify(capabilitySettings.snapshot());
      integrationState.refresh();
      if (JSON.stringify(capabilitySettings.snapshot()) !== before) {
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
    });
    // Snapshots publish from changed(); this tick only polls what has no event:
    // the addon's acknowledged revision, and a publish that is still dirty
    // because the transport was missing or its last write failed.
    every(PUBLISH_MIN_INTERVAL_MS, () => {
      observeGameConnection();
      publisher.retry();
    });
    logger.info(
      { event: 'bridge.started', version: bridgeVersion, channel: features.channel },
      'Wisp started',
    );
    function stop() {
      shutdownRequested = true;
      pending.cancelAll('Bridge stopped');
      state.chats.forEach(run.interrupt);
      return resources.close();
    }
    await Promise.all([engineStartup, transportStartup]);
    return { state, receive, stop };
  } catch (error) {
    await resources
      .close()
      .catch((cleanupError) =>
        logger.error(
          { event: 'bridge.cleanup_failed', error: errorMessage(cleanupError) },
          'Bridge cleanup failed',
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
