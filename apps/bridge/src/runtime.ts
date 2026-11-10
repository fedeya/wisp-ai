import { characterLabel } from '@wisp/protocol/character-key';
import { RuntimeResources } from './runtime-resources.ts';
import { projectChats } from './chat-projection.ts';
import { startRoutineScheduler } from './routine-scheduler.ts';
import { createPacketReceiver } from './packet-receiver.ts';
import { createSessionState } from './session-state.ts';
import { createDesktopHandler } from './desktop-handler.ts';
import type { Status } from '@wisp/protocol/desktop';
import { writeJson, readJson } from './json-file.ts';
import { z } from 'zod';
import { createAgentHandler } from './agent-server.ts';
import { GameRequests } from './game-requests.ts';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { startEveProcess, stopEveProcess } from './agent-process.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'eve/client';
import { COMPACTION_THRESHOLD } from '@wisp/protocol/context-usage';
import { DiskTransport } from './transport.ts';
import { ChatStore } from './chat-store.ts';
import { createTurnRunner } from './turn-runner.ts';
import { errorMessage } from './errors.ts';
import { MemoryStore } from './memory-store.ts';
import { IntegrationState } from './integration-state.ts';
import { existsSync, closeSync } from 'node:fs';
import { CapabilitySettings } from './capabilities.ts';
import { defaultCapabilities } from '@wisp/protocol/capabilities';
import { SnapshotGate } from './snapshots.ts';
import { PanelStore } from './panels.ts';
import { McpManager } from './mcp-manager.ts';
import { McpRelay } from './mcp-relay.ts';
import { NativeVault, type SecretVault } from './secret-vault.ts';
import { startDesktopServer } from './desktop-server.ts';
import { RoutineStore } from './routines.ts';
import { routineEvents } from '@wisp/protocol/routines';
import { ModelConnections } from './model-connections.ts';
import { WebSearch } from './web-search.ts';
import { ChatGPTAuth } from './chatgpt-auth.ts';
import { safeErrorMessage } from '@wisp/protocol/model-errors';
import { TheWoWDB } from './thewowdb.ts';
import { Simulator } from './simulation.ts';
import { appPaths, prepareEngine } from './app-paths.ts';
export interface BridgeOptions {
  resourceRoot?: string;
  dataDirectory?: string;
  agentPort?: number;
  desktopPort?: number;
  vault?: SecretVault;
  client?: Pick<Client, 'sessions' | 'health' | 'info'>;
  startAgent?: typeof startEveProcess;
}
export async function startBridge(options: BridgeOptions = {}) {
  const resources = new RuntimeResources();
  try {
    const ROOT =
      options.resourceRoot ||
      process.env.WISP_RESOURCE_ROOT ||
      fileURLToPath(new URL('../../../', import.meta.url));
    const paths = appPaths(ROOT, options.dataDirectory);
    const bridgeVersion = await readJson(
      path.join(ROOT, 'package.json'),
      z.object({ version: z.string().min(1) }),
      () => ({ version: 'unknown' }),
    )
      .then((metadata) => metadata.version)
      .catch(() => 'unknown');
    const runtime = paths.runtime;
    const simulator = new Simulator(ROOT, runtime);
    await prepareEngine(paths.agent, paths.engine);
    await mkdir(runtime, { recursive: true });
    const memoryStore = new MemoryStore(path.join(runtime, 'memory'));
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
    let config = await readJson(
      paths.config,
      z.object({
        wow: z.string().min(1),
        // Earlier installers saved an empty string before model selection.
        model: z.preprocess(
          (value) => (value === '' ? undefined : value),
          z.string().min(1).optional(),
        ),
        mcpConfig: z.string().min(1).optional(),
      }),
      () => {
        throw Error('Choose a WoW folder and install the addon first.');
      },
    );
    const mcpFile = config.mcpConfig
      ? path.resolve(paths.dataRoot, config.mcpConfig)
      : path.join(runtime, 'mcp.json');
    const vault =
      options.vault ||
      new NativeVault(
        process.env.WISP_DESKTOP_EXE ||
          path.join(
            ROOT,
            'apps',
            'desktop',
            'src-tauri',
            'target',
            'release',
            process.platform === 'win32' ? 'wisp.exe' : 'wisp',
          ),
      );
    const mcpManager = new McpManager(mcpFile, ROOT, vault);
    await mcpManager.load();
    resources.defer(() => mcpManager.close());
    const auth = new ChatGPTAuth(runtime, vault);
    await auth.load();
    const connections = new ModelConnections(path.join(runtime, 'connections.json'), vault, auth);
    await connections.load();
    const webSearch = new WebSearch(path.join(runtime, 'search.json'), vault, auth);
    await webSearch.load();
    resources.defer(() => auth.cancel());
    let modelCatalogLoad: Promise<void> | undefined;
    function refreshModelCatalog() {
      return (modelCatalogLoad ??= (async () => {
        try {
          state.modelCatalog = await connections.models();
          state.modelCatalogError = undefined;
        } catch (error) {
          state.modelCatalog = [];
          state.modelCatalogError = safeErrorMessage(
            error instanceof Error ? error.message : String(error),
          );
        } finally {
          modelCatalogLoad = undefined;
          changed();
        }
      })());
    }
    const database = new TheWoWDB();
    const panelStore = new PanelStore(path.join(runtime, 'panels.json'));
    await panelStore.load();
    const routineStore = new RoutineStore(path.join(runtime, 'routines.json'));
    await routineStore.load();
    const capabilitySettings = new CapabilitySettings(path.join(runtime, 'capabilities.json'));
    await capabilitySettings.load();
    capabilitySettings.agentFile = path.join(runtime, 'agent-capabilities.json');
    const integrationState = new IntegrationState(capabilitySettings);
    capabilitySettings.availability.set('integration:wowsims', {
      available: existsSync(path.join(ROOT, 'simulator', 'wowsimcli.exe')),
      status: existsSync(path.join(ROOT, 'simulator', 'wowsimcli.exe')) ? 'ready' : 'missing',
      reason: 'Experimental local mage engine, levels 1–60.',
    });
    function refreshMcpCatalog() {
      const catalog = defaultCapabilities();
      for (const server of mcpManager.list()) {
        const url = server.url ? new URL(server.url) : undefined;
        if (url) {
          url.username = '';
          url.password = '';
          url.search = '';
          url.hash = '';
        }
        catalog.push({
          id: 'mcp:' + server.name,
          kind: 'mcp',
          name: server.name,
          group: 'integrations',
          defaultEnabled: server.enabled,
          description:
            (server.description || server.name) + ' - ' + (url?.toString() || 'Local stdio server'),
        });
        for (const tool of server.tools || []) {
          catalog.push({
            id: 'mcp_tool:' + server.name + ':' + tool.name,
            name: tool.name,
            group: 'integrations',
            parent: 'mcp:' + server.name,
            description: (tool.description || tool.name).slice(0, 500),
          });
        }
      }
      capabilitySettings.catalog = catalog;
    }
    refreshMcpCatalog();
    for (const server of mcpManager.list()) {
      await mcpManager.setEnabled(server.name, capabilitySettings.configured('mcp:' + server.name));
    }
    async function setCapability(id: string, enabled: boolean) {
      const server = id.startsWith('mcp:')
        ? mcpManager.list().find((server) => id === 'mcp:' + server.name)
        : undefined;
      if (server) {
        await mcpManager.setEnabled(server.name, enabled);
      }
      try {
        await capabilitySettings.set(id, enabled);
      } catch (error) {
        if (server) {
          await mcpManager.setEnabled(server.name, server.enabled);
        }
        throw error;
      }
    }
    await capabilitySettings.publish();
    const mcpRelay = new McpRelay(
      mcpManager,
      (name, tool) =>
        capabilitySettings.enabled('mcp:' + name) &&
        (!tool || capabilitySettings.enabled('mcp_tool:' + name + ':' + tool)),
    );
    resources.defer(() => mcpRelay.close());
    const chatStore = new ChatStore(path.join(runtime, 'chats.sqlite'), (error) =>
      log('Conversation save failed: ' + errorMessage(error)),
    );
    const state = createSessionState(await chatStore.load());
    resources.defer(async () => {
      try {
        await chatStore.flush(state.chats);
      } finally {
        await chatStore.close();
      }
    });
    const snapshots = new SnapshotGate();
    let eveReady = false;
    let contextWindowTokens: number | undefined;
    let dirty = true;
    const pending = new GameRequests(changed);
    resources.defer(() => pending.cancelAll('Bridge stopped'));
    const token = randomBytes(32).toString('hex');
    const client =
      options.client ||
      new Client({
        baseUrl: 'http://127.0.0.1:43186',
        auth: { bearer: () => token },
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
    function log(message: string) {
      console.log(new Date().toISOString(), message);
    }
    function changed() {
      dirty = true;
      if (!shutdownRequested) {
        chatStore.schedule(() => state.chats);
      }
    }
    function chatFor(id: string | undefined) {
      return state.chats.find((c) => c.id === id);
    }
    let shutdownRequested = false;
    const run = createTurnRunner({
      client,
      models: connections,
      capabilitySettings,
      changed,
      log,
      currentTransport: () => state.activeTransport,
      activeChat: () => state.activeChat,
      defaultModel: () => config.model || 'gpt-6-luna',
      isReady: () => eveReady,
      isStopping: () => shutdownRequested,
      accountBusy: () => accountBusy,
      isCurrent: (chat) => state.chats.includes(chat),
      flushFirstText: () =>
        queueMicrotask(() => {
          dirty = true;
          publishSnapshot();
        }),
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
      log,
      isStopping: () => shutdownRequested,
      isReady: () => eveReady,
    });
    resources.defer(stopRoutineScheduler);
    const receive = createPacketReceiver({
      state,
      client,
      pending,
      integrationState,
      capabilitySettings,
      models: connections,
      routineStore,
      panelStore,
      memoryStore,
      transport: () => transport,
      refreshModelCatalog,
      setCapability,
      memorySnapshot,
      run,
      flushAcknowledgment: () =>
        queueMicrotask(() => {
          dirty = true;
          publishSnapshot();
        }),
      interrupt: run.interrupt,
      runtime,
      changed,
      log,
    });
    const transport = new DiskTransport(config.wow, receive, (error) =>
      log('Game transport failed: ' + errorMessage(error)),
    );
    resources.defer(() => transport.stop());
    const server = createServer(
      createAgentHandler({
        log,
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
        defaultModel: () => config.model || 'gpt-6-luna',
        readSimulationCharacter,
        memorySnapshot,
        setMemoryView: (view) => {
          state.memoryView = view;
        },
        changed,
      }),
    );
    resources.defer(() => closeServer(server));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.agentPort ?? 43187, '127.0.0.1', resolve);
    });
    const agentOrigin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
    await writeFile(path.join(runtime, 'bridge.pid'), String(process.pid));
    await transport.start();
    const eveLog = await import('node:fs').then((fs) =>
      fs.openSync(path.join(runtime, 'eve.log'), 'a'),
    );
    resources.defer(() => closeSync(eveLog));
    function startEve() {
      return (options.startAgent || startEveProcess)({
        root: paths.engine,
        logFile: eveLog,
        environment: {
          ...process.env,
          WOW_BRIDGE_TOKEN: token,
          WOW_BRIDGE_URL: agentOrigin,
          WOW_CAPABILITIES_FILE: capabilitySettings.agentFile,
          WOW_MCP_CONFIG: mcpFile,
          ...(config.model ? { WOW_MODEL: config.model } : {}),
          DO_NOT_TRACK: '1',
        },
        onError: (error) => log('Could not start Eve: ' + error.message),
        onExit: (code) => {
          eveReady = false;
          changed();
          log('Eve exited: ' + code);
        },
      });
    }
    let eve = startEve();
    resources.defer(() => killEve());
    async function killEve() {
      await stopEveProcess(eve);
      eveReady = false;
    }
    let accountBusy = false;
    let accountWork: Promise<unknown> | undefined;
    resources.defer(async () => {
      await accountWork;
    });
    async function accountOperation<T>(operation: () => Promise<T>) {
      if (shutdownRequested || accountBusy || state.chats.some((c) => c.status === 'working')) {
        throw Error('Wait for the active operation to finish.');
      }
      accountBusy = true;
      try {
        const work = operation();
        accountWork = work;
        return await work;
      } finally {
        accountBusy = false;
        accountWork = undefined;
        if (!shutdownRequested) {
          void refreshModelCatalog();
        }
      }
    }
    const health = setInterval(
      () =>
        void client
          .health()
          .then(async () => {
            if (!eveReady) {
              contextWindowTokens = undefined;
              try {
                const info = await client.info();
                const window = info.agent.model?.contextWindowTokens;
                if (typeof window === 'number' && Number.isSafeInteger(window) && window > 0) {
                  contextWindowTokens = window;
                }
              } catch {
                // Unknown capacity is displayed as unknown, never a made-up limit.
              }
              eveReady = true;
              changed();
              log('Eve ready.');
            }
          })
          .catch(() => {
            if (eveReady) {
              eveReady = false;
              changed();
            }
          }),
      3000,
    );
    resources.defer(() => clearInterval(health));
    function desktopStatus(): Status {
      return {
        ready: eveReady,
        gameConnected: Boolean(
          state.activeTransport &&
          state.firstReadyRevision &&
          transport.peerRevision >= state.firstReadyRevision,
        ),
        auth: auth.state(),
        connections: connections.list(),
        modelConnected: connections.connected(config.model || ''),
        search: webSearch.state(),
        model: config.model || 'gpt-6-luna',
        activeTurns: state.chats.filter((c) => c.status === 'working').length,
        integrations: capabilitySettings.snapshot(),
        mcps: mcpManager.list().map((s) => ({
          ...s,
          enabled: s.enabled && capabilitySettings.enabled('mcp:' + s.name),
        })),
        panels: panelStore.panels.map((p) => ({
          ...p,
          character: characterLabel(p.characterKey, ' - '),
        })),
        routines: routineStore.routines,
        routineRuns: routineStore.runs.filter((r) => r.status !== 'no_tip').slice(-200),
      };
    }
    const desktopServer = await startDesktopServer(
      runtime,
      createDesktopHandler({
        auth,
        connections,
        webSearch,
        capabilitySettings,
        mcpManager,
        panelStore,
        routineStore,
        accountOperation,
        readSimulationCharacter,
        setCapability,
        refreshMcpCatalog,
        changed,
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
          const updated = { ...config, model };
          await writeJson(paths.config, updated);
          config = updated;
          await killEve();
          if (shutdownRequested) {
            return;
          }
          eve = startEve();
          changed();
        },
        requestStop: () => {
          shutdownRequested = true;
          setTimeout(() => void stop().catch((error) => log(errorMessage(error))), 200);
        },
      }),
      options.desktopPort,
    );
    resources.defer(() => closeServer(desktopServer));
    const integrationHealth = setInterval(() => {
      const before = JSON.stringify(capabilitySettings.snapshot());
      integrationState.refresh();
      if (JSON.stringify(capabilitySettings.snapshot()) !== before) {
        void capabilitySettings
          .publish()
          .catch((error) => log('Integration update failed: ' + error.message));
        changed();
      }
    }, 30000);
    resources.defer(() => clearInterval(integrationHealth));
    function publishSnapshot() {
      if (!dirty || !state.activeTransport) {
        return;
      }
      dirty = false;
      const snapshot = snapshots.next({
        v: 1,
        session: state.activeTransport,
        connected: eveReady,
        bridgeVersion,
        contextPolicy: {
          windowTokens:
            state.modelCatalog.find(
              (m) => m.slug === chatFor(state.activeChat)?.modelSettings?.model,
            )?.contextWindow || contextWindowTokens,
          compactAt: COMPACTION_THRESHOLD,
        },
        modelCatalog: {
          models: state.modelCatalog,
          defaultModel: config.model || 'gpt-6-luna',
          error: state.modelCatalogError,
        },
        acks: state.acknowledgments,
        questRevision: state.questRevision || 0,
        characterRevision: state.characterRevision || 0,
        activeChat: state.activeChat,
        ...projectChats(state),
        panels: state.currentCharacterKey ? panelStore.list(state.currentCharacterKey) : [],
        panelCommand: state.panelCommand,
        routineCommand: state.routineCommand,
        routines: state.currentCharacterKey
          ? routineStore
              .list(state.currentCharacterKey)
              .map((r) => ({ id: r.id, title: r.title, enabled: r.enabled }))
          : [],
        routineRuns: state.currentCharacterKey
          ? routineStore.runs
              .filter((r) => r.characterKey === state.currentCharacterKey && r.status !== 'no_tip')
              .slice(-50)
              .map(({ summary: _summary, ...r }) => r)
          : [],
        routineSubscriptions:
          state.currentCharacterKey && capabilitySettings.enabled('tool:manage_routine')
            ? [
                ...new Set(
                  routineStore
                    .list(state.currentCharacterKey)
                    .filter((r) => r.enabled)
                    .flatMap((r) =>
                      r.triggers.filter((t) => t.kind === 'event').map((t) => t.event),
                    ),
                ),
              ].map((event) => ({ event, native: routineEvents[event].native }))
            : [],
        routinesEnabled:
          !!state.currentCharacterKey &&
          capabilitySettings.enabled('tool:manage_routine') &&
          routineStore.list(state.currentCharacterKey).some((r) => r.enabled),
        memory: state.memoryView,
        capabilities: {
          entries: capabilitySettings.snapshot(),
          acks: state.capabilityAcks,
          error: state.capabilityError,
        },
        requests: pending.snapshot(),
      });
      if (snapshot && eveReady && !state.firstReadyRevision) {
        state.firstReadyRevision = snapshot.rev;
      }
      if (snapshot) {
        void transport.publish(snapshot).catch((error) => {
          snapshots.invalidate();
          dirty = true;
          log('Failed to publish reply: ' + error.message);
        });
      }
    }
    const publish = setInterval(publishSnapshot, 400);
    log('Wisp started. WoW: ' + config.wow);
    resources.defer(() => clearInterval(publish));
    function stop() {
      shutdownRequested = true;
      pending.cancelAll('Bridge stopped');
      state.chats.forEach(run.interrupt);
      return resources.close();
    }
    return { state, receive, stop };
  } catch (error) {
    await resources.close().catch((cleanupError) => console.error(errorMessage(cleanupError)));
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
