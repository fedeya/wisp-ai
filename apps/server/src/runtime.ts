import { characterLabel } from '@wisp/protocol/character-key';
import { Context, Effect, Exit, Fiber, Layer, Scope } from 'effect';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { releaseRuntimeResource, RuntimeResources } from './runtime-resources.ts';
import { UsageTelemetry } from './telemetry.ts';
import { ModelFailures } from './models/model-failures.ts';
import { startRoutineScheduler } from './routines/routine-scheduler.ts';
import { createPacketReceiver } from './game/packet-receiver.ts';
import { createCharacterAdoption } from './chat/character-adoption.ts';
import { readCharacterNames } from './db/character-keys.ts';
import { createSessionState } from './session-state.ts';
import { createDesktopApp } from './api/desktop-handler.ts';
import type { Status } from '@wisp/protocol/desktop';
import { readJson, writeJson } from './json-file.ts';
import { loadBridgeConfig } from './bridge-config.ts';
import { z } from 'zod';
import { createAgentHandler } from './agent/agent-server.ts';
import * as WowBridge from '@wisp/wow-bridge';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTransportConnection } from './game/transport-connection.ts';
import type { TransportConnection } from './game/transport-connection.ts';
import { ChatStore } from './chat/chat-store.ts';
import { applicationDatabaseFile } from './db/application-file.ts';
import { ApplicationDatabase } from './db/application-database.ts';
import { createTurnRunner } from './agent/turn-runner.ts';
import { errorMessage } from './errors.ts';
import { bridgeLogging } from './logger.ts';
import { MemoryStore } from './agent/memory-store.ts';
import { IntegrationState } from './integrations/integration-state.ts';
import { existsSync } from 'node:fs';
import { CapabilitySettings } from './integrations/capabilities.ts';
import { createMcpCapabilities } from './integrations/mcp/mcp-capabilities.ts';
import { PUBLISH_MIN_INTERVAL_MS } from './game/publish-scheduler.ts';
import { createSnapshotPublisher } from './game/snapshot-publisher.ts';
import type { SnapshotPublisher } from './game/snapshot-publisher.ts';
import { PanelStore } from './panels/panel-store.ts';
import { McpManager } from '@wisp/agent/mcp-manager';
import * as Everloot from '@wisp/agent/everloot';
import { NativeVault, type SecretVault } from './auth/secret-vault.ts';
import { startDesktopServer } from './api/desktop-server.ts';
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
import { addonVersionFromToc } from './game/addon-version.ts';
import { Features } from './features.ts';
import { featureChannel } from '@wisp/protocol/features';
import { setAgentHost } from '@wisp/agent/agent-host';
import { createAgentEngine } from '@wisp/agent/engine';
import { AgentHistory } from './agent/agent-history.ts';

const wowPlatform = Layer.merge(NodeFileSystem.layer, NodePath.layer);

export interface ServerOptions {
  resourceRoot?: string;
  dataDirectory?: string;
  agentPort?: number;
  desktopPort?: number;
  vault?: SecretVault;
  deferWowTransport?: boolean;
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
    const ROOT =
      options.resourceRoot ||
      process.env.WISP_RESOURCE_ROOT ||
      fileURLToPath(new URL('../../../', import.meta.url));
    const paths = appPaths(ROOT, options.dataDirectory);
    const [bridgeVersion, expectedAddonVersion] = yield* startup(() =>
      Promise.all([
        readJson(path.join(ROOT, 'package.json'), z.object({ version: z.string().min(1) }), () => ({
          version: 'unknown',
        }))
          .then((metadata) => metadata.version)
          .catch(() => 'unknown'),
        readFile(path.join(ROOT, 'addon/WispAI/WispAI.toc'), 'utf8').then(
          addonVersionFromToc,
          () => undefined,
        ),
      ]),
    );
    const runtime = paths.runtime;
    const simulator = new Simulator(ROOT, runtime);
    yield* startup(() => mkdir(runtime, { recursive: true }));
    const databaseFile = applicationDatabaseFile(runtime);
    const applicationDatabase = new ApplicationDatabase(databaseFile);
    yield* releaseRuntimeResource(() => applicationDatabase.close());
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
    const config = yield* startup(() => loadBridgeConfig(paths.config));
    const features = yield* startup(() =>
      Features.start({
        channel: featureChannel(bridgeVersion, process.env.WISP_RELEASE_BUILD === '1'),
        overrides: config.get().features ?? {},
        saveOverrides: (overrides) => config.update({ features: overrides }),
        onChange: () => featuresChanged(),
      }),
    );
    const mcpConfig = config.get().mcpConfig;
    const mcpFile = mcpConfig
      ? path.resolve(paths.dataRoot, mcpConfig)
      : path.join(runtime, 'mcp.json');
    const vault = options.vault || new NativeVault(paths.desktopExecutable);
    const mcpManager = McpManager.make(
      ROOT,
      {
        async readConfig() {
          try {
            return await readFile(mcpFile, 'utf8');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
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
    const telemetry = new UsageTelemetry(paths.dataRoot, bridgeVersion, {
      isCustomMcpConnection: (name) => Object.hasOwn(mcpManager.servers, name.replace(/-/g, '_')),
      enabledFeatures: () => features.enabledNames(),
    });
    yield* releaseRuntimeResource(() => telemetry.close());
    const auth = yield* ChatGPTAuth.make(runtime, vault);
    yield* startup(() => auth.load());
    const connections = new ModelConnections(path.join(runtime, 'connections.json'), vault, auth);
    yield* startup(() => connections.load());
    const modelFailures = new ModelFailures();
    const webSearch = new WebSearch(path.join(runtime, 'search.json'), vault, auth);
    yield* startup(() => webSearch.load());
    yield* releaseRuntimeResource(() => auth.cancel());
    const database = new TheWoWDB();
    const panelStore = new PanelStore(applicationDatabase);
    yield* startup(() => panelStore.load());
    const routineStore = new RoutineStore(applicationDatabase);
    yield* startup(() => routineStore.load());
    const capabilitySettings = new CapabilitySettings(path.join(runtime, 'capabilities.json'));
    yield* startup(() => capabilitySettings.load());
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
    yield* mcpCapabilities.applySavedSettings();
    yield* startup(() => capabilitySettings.publish());
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
          routinesAllowed: !!character && capabilitySettings.enabled('tool:manage_routine'),
          capabilities: capabilitySettings.snapshot(),
          features: features.values(),
        };
      },
    });
    yield* releaseRuntimeResource(() => publisher.stop());
    const bridge = Context.get(
      yield* Layer.build(WowBridge.layer.pipe(Layer.provide(wowPlatform))),
      WowBridge.WowBridge,
    );
    const token = randomBytes(32).toString('hex');
    // The agent runs in process; its model history lives next to the chats.
    const agentHistory = new AgentHistory(applicationDatabase, { wispVersion: bridgeVersion });
    let engineReady = false;
    const engine = createAgentEngine({
      origin: () => agentOrigin,
      token,
      history: agentHistory,
      capabilitiesFile: () => capabilitySettings.agentFile,
      mcp: {
        manager: mcpManager,
        allowed: (server, tool) =>
          capabilitySettings.enabled('mcp:' + server) &&
          (!tool || capabilitySettings.enabled('mcp_tool:' + server + ':' + tool)),
        readOnly: (session) =>
          state.chats.some(
            (chat) => chat.agentSession === session && chat.proactive && chat.status === 'working',
          ),
      },
      logging: bridgeLogging,
    });
    async function readSimulationCharacter(chat = 'desktop-simulation'): Promise<unknown> {
      if (!state.activeTransport || !capabilitySettings.enabled('tool:query_character')) {
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
    const run = yield* createTurnRunner({
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
    });
    yield* releaseRuntimeResource(async () => {
      state.chats.forEach(run.interrupt);
      await run.drain();
    });
    const stopRoutineScheduler = yield* startRoutineScheduler({
      state,
      routineStore,
      capabilitySettings,
      run,
      changed,
      isStopping: () => shutdownRequested,
      isReady: () => engineReady,
    });
    yield* releaseRuntimeResource(stopRoutineScheduler);
    const adoptCharacter = createCharacterAdoption({
      database: applicationDatabase,
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
      models: connections,
      routineStore,
      panelStore,
      memoryStore,
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
    });
    const receive: typeof receivePacket = (packet) => {
      const previousSession = state.activeTransport;
      observeGameConnection();
      receivePacket(packet);
      if (state.activeTransport !== previousSession) {
        telemetry.gameConnectionStarted();
      }
    };
    const transport: TransportConnection = yield* createTransportConnection({
      state,
      bridge,
      integrationState,
      capabilitySettings,
      receive,
      saveWow: (wow) => config.update({ wow }),
      changed,
      isStopping: () => shutdownRequested,
    }).pipe(Effect.provide(wowPlatform));
    yield* Effect.addFinalizer(() => transport.serialize(transport.disconnect));
    const server = createServer(
      yield* createAgentHandler({
        telemetry,
        modelFailures,
        token,
        auth,
        connections,
        webSearch,
        mcpManager,
        capabilitySettings,
        routineStore,
        panelStore,
        memoryStore,
        requestGame: transport.request,
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
    yield* releaseRuntimeResource(() => closeServer(server));
    yield* releaseRuntimeResource(() => engine.close());
    const agentPort = yield* startup(() => listenOnLoopback(server, options.agentPort ?? 43187));
    const agentOrigin = 'http://127.0.0.1:' + agentPort;
    yield* startup(() => writeFile(path.join(runtime, 'bridge.pid'), String(process.pid)));
    setAgentHost({ origin: agentOrigin, token });
    yield* releaseRuntimeResource(() => accounts.drain());
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
    function observeGameConnection() {
      telemetry.gameConnectionProgress(
        transport.gameConnected(),
        transport.current()?.status().readyPublished ?? false,
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
    let desktopStopTimer: ReturnType<typeof setTimeout> | undefined;
    const desktopApp = yield* createDesktopApp({
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
              yield* transport.connect(input.wow ?? config.get().wow, input.wow !== undefined);
            }
          }),
        ),
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
        // Let the desktop response reach the caller before we close its listener.
        desktopStopTimer ??= setTimeout(requestStop, 200);
      },
    });
    const desktopServer = yield* startup(() =>
      startDesktopServer(runtime, desktopApp, options.desktopPort),
    );
    yield* releaseRuntimeResource(() => closeServer(desktopServer));
    const transportStartup = yield* (
      options.deferWowTransport || process.env.WISP_DEFER_WOW_TRANSPORT === '1'
        ? Effect.void
        : transport.serialize(transport.connect(config.get().wow)).pipe(
            Effect.catchDefect((error) => Effect.fail(error)),
            Effect.catch((error) => Effect.sync(() => transport.logError(error))),
          )
    ).pipe(Effect.forkChild());
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
    yield* releaseRuntimeResource(() => clearInterval(integrationHealth));
    // Snapshots publish from changed(); this tick only polls what has no event:
    // the addon's acknowledged revision, and a publish that is still dirty
    // because the transport was missing or its last write failed.
    const publish = setInterval(() => {
      observeGameConnection();
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
    return { state, receive };
  },
  // The existing Promise-based acquisitions cannot be interrupted safely.
  Effect.uninterruptible,
  Effect.catchDefect((error) => Effect.fail(error)),
);

function startup<A>(operation: () => Promise<A>) {
  return Effect.tryPromise({ try: operation, catch: (error) => error });
}

export function startServer(options: ServerOptions = {}) {
  return Effect.runPromise(startServerEffect(options).pipe(Effect.provide(bridgeLogging)));
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
