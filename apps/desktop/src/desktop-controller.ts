import { Channel } from '@tauri-apps/api/core';
import { createStore } from 'zustand/vanilla';
import {
  desktop,
  native,
  request,
  type DesktopInfo,
  type Mcp,
  type Model,
  type Panel,
  type Status,
} from './api';
import { startBridgeLifecycle } from './bridge-lifecycle';

type Confirmation = { label: string; run: () => Promise<void> };
type DesktopState = {
  status: Status | null;
  info: DesktopInfo | null;
  loading: boolean;
  starting: boolean;
  busy: string;
  busyTarget: string;
  feedback: string;
  failed: boolean;
  wow: string;
  detectedFolders: string[];
  detectingGame: boolean;
  detectionFailed: boolean;
  models: Model[];
  model: string;
  account: string;
  logs: string;
  confirm: Confirmation | null;
  connectionError: string;
  modelsError: string;
  connected: boolean;
  active: boolean;
  locked: boolean;
};

export function createDesktopController() {
  const store = createStore<DesktopState>()(() => ({
    status: null,
    info: null,
    loading: true,
    starting: false,
    busy: '',
    busyTarget: '',
    feedback: '',
    failed: false,
    wow: '',
    detectedFolders: [],
    detectingGame: false,
    detectionFailed: false,
    models: [],
    model: '',
    account: '',
    logs: '',
    confirm: null,
    connectionError: '',
    modelsError: '',
    connected: false,
    active: false,
    locked: false,
  }));
  const { getState } = store;
  let polling = false;
  let loadedAccount = '';
  let bridgeLifecycle: ReturnType<typeof startBridgeLifecycle> | undefined;

  function update(patch: Partial<DesktopState>) {
    store.setState((state) => {
      const next = { ...state, ...patch };
      next.connected = next.status?.modelConnected ?? next.status?.auth.status === 'connected';
      next.active = (next.status?.activeTurns || 0) > 0;
      next.locked = !!next.busy || next.active;
      return next;
    });
  }

  async function refresh() {
    if (!native || polling) return;
    polling = true;
    try {
      const status = await request<Status>('/status');
      const { account, model, starting } = getState();
      update({
        status,
        connectionError: '',
        starting: starting && !status.ready,
        account:
          account && status.auth.profiles.some((profile) => profile.id === account)
            ? account
            : status.auth.activeId || '',
        model: model || status.model,
      });
      const catalogRevision = JSON.stringify([
        status.auth.activeId,
        status.auth.status,
        status.auth.revision,
        status.connections,
      ]);
      if (catalogRevision !== loadedAccount && !getState().active && !getState().busy) {
        loadedAccount = catalogRevision;
        try {
          await loadModels();
        } catch (error) {
          loadedAccount = '';
          update({ modelsError: String(error).replace(/^Error: /, '') });
        }
      }
    } catch (error) {
      update({ status: null, connectionError: String(error).replace(/^Error: /, '') });
    } finally {
      polling = false;
      update({ loading: false });
    }
  }

  async function work(
    label: string,
    action: () => Promise<unknown>,
    success?: string,
    target = '',
  ) {
    if (getState().busy) return;
    update({ busy: label, busyTarget: target, failed: false, feedback: '' });
    try {
      await action();
      update({ feedback: success || getState().feedback || 'Done.' });
    } catch (error) {
      update({ failed: true, feedback: String(error).replace(/^Error: /, '') });
    } finally {
      update({ busy: '', busyTarget: '' });
      await refresh();
    }
  }

  async function loadModels() {
    update({ models: [] });
    const { models } = await request<{ models: Model[] }>('/auth/models');
    const { model, status } = getState();
    update({
      models,
      modelsError: '',
      model: models.some((item) => item.slug === model)
        ? model
        : status?.model || models[0]?.slug || '',
    });
  }

  async function signIn(add = false) {
    await work(
      'Opening sign-in',
      async () => {
        const { authorizationUrl } = await request<{ authorizationUrl: string }>('/auth/start', {
          profileId: add ? undefined : getState().account || undefined,
          newAccount: add,
        });
        await desktop('open_sign_in', { url: authorizationUrl });
      },
      'Continue in your browser. Wisp will update when sign-in completes.',
    );
  }

  async function pickFolder() {
    if (getState().detectingGame) return;
    const folder = await desktop<string | null>('pick_folder');
    if (folder) update({ wow: folder });
  }

  async function launchBridge() {
    update({ starting: true });
    try {
      await desktop('start_bridge');
    } catch (error) {
      update({ starting: false });
      throw error;
    }
  }

  async function start() {
    update({ starting: true });
    await work('Starting Wisp', launchBridge, 'Wisp is starting.');
    if (getState().failed) update({ starting: false });
  }

  async function install() {
    if (getState().detectingGame) return;
    await work(
      'Installing addon',
      async () => {
        const feedback = await desktop<string>('install_addon', { wow: getState().wow });
        update({ feedback });
        update({ info: await desktop<DesktopInfo>('desktop_info') });
        await launchBridge();
      },
      'Addon installed. Restart WoW after the first installation; use /reload for updates.',
      'installation',
    );
  }

  async function importPrevious() {
    const source = await desktop<string | null>('pick_folder');
    if (!source) return;
    await work(
      'Importing previous installation',
      async () => {
        await desktop('import_legacy', { source });
        const info = await desktop<DesktopInfo>('desktop_info');
        update({ info, wow: info.wow || '' });
        await launchBridge();
      },
      'Imported chats, memory and protected credentials. Wisp is starting.',
    );
  }

  async function showLogs() {
    await work(
      'Reading logs',
      async () => update({ logs: await desktop<string>('read_logs') }),
      'Local logs loaded.',
    );
  }

  async function setIntegration(id: string, enabled: boolean) {
    await work(
      'Updating integration',
      () => request('/integrations/set', { id, enabled }),
      'Integration updated.',
      id,
    );
  }

  async function panelAction(panel: Panel, action: 'show' | 'hide' | 'remove') {
    await work(
      'Updating panel',
      () => request('/panels/action', { action, id: panel.id, characterKey: panel.characterKey }),
      'Panel updated.',
      panel.id,
    );
  }

  function removeMcp(server: Mcp) {
    update({
      confirm: {
        label: `Remove “${server.name}”?`,
        run: () =>
          work(
            'Removing connection',
            () => request('/mcps/remove', { name: server.name }),
            'Connection removed.',
            'mcp:' + server.name,
          ),
      },
    });
  }

  async function testMcp(server: Mcp) {
    await work(
      'Testing ' + server.name,
      async () => {
        const result = await request<{ count: number }>('/mcps/test', { server });
        update({ feedback: `Connected. ${result.count} tools available.` });
      },
      undefined,
      'mcp:' + server.name,
    );
  }

  async function searchInstallations() {
    const { info, detectingGame, locked, wow: previous } = getState();
    if (!native || bridgeLifecycle?.disposed || info?.configured || detectingGame || locked) return;
    update({ detectingGame: true, detectionFailed: false, feedback: '', failed: false });
    const folders = new Set<string>();
    let accepting = true;
    const addFolder = (folder: string) => {
      if (accepting && !bridgeLifecycle?.disposed && !getState().info?.configured) {
        folders.add(folder);
      }
    };
    try {
      const onFound = new Channel<string>();
      onFound.onmessage = addFolder;
      (await desktop<string[]>('detect_game_folders', { onFound })).forEach(addFolder);
    } catch {
      update({ detectionFailed: true });
    } finally {
      accepting = false;
      if (!bridgeLifecycle?.disposed) {
        const detectedFolders = [...folders];
        update({
          detectedFolders,
          wow: folders.has(previous) ? previous : detectedFolders[0] || '',
          detectingGame: false,
          ...(detectedFolders.length && !getState().busy && !getState().feedback
            ? {
                failed: false,
                feedback:
                  detectedFolders.length === 1
                    ? 'WoW Forever found.'
                    : `Found ${detectedFolders.length} WoW Forever installations.`,
              }
            : {}),
        });
      }
    }
  }

  return {
    store,
    mount() {
      if (!native) {
        update({ loading: false });
        return;
      }
      bridgeLifecycle = startBridgeLifecycle({
        onDesktopInfo(info) {
          update({ info, wow: info.wow || '' });
          if (!info.configured) void searchInstallations();
        },
        launchBridge,
        refresh,
        onError: (feedback) => update({ failed: true, feedback }),
        onInitializationError: (feedback) => update({ failed: true, feedback, loading: false }),
      });
      return bridgeLifecycle.dispose;
    },
    actions: {
      refresh,
      work,
      loadModels,
      signIn,
      searchInstallations,
      start,
      install,
      importPrevious,
      showLogs,
      setIntegration,
      panelAction,
      removeMcp,
      testMcp,
      chooseFolder: () => work('Choosing folder', pickFolder, undefined, 'folder-picker'),
      stop: () =>
        work(
          'Stopping Wisp',
          async () => {
            await desktop('stop_bridge');
            update({ starting: false });
          },
          'Wisp stopped.',
        ),
      selectFolder: (wow: string) => update({ wow }),
      chooseAccount: (account: string) => update({ account }),
      chooseModel: (model: string) => update({ model }),
      setConfirmation: (confirm: Confirmation | null) => update({ confirm }),
      setBusy: (busy: string) => update({ busy }),
      clearFeedback: () => update({ feedback: '' }),
    },
  };
}

export type DesktopController = ReturnType<typeof createDesktopController>;
