import { Channel } from '@tauri-apps/api/core';
import { createStore } from 'zustand/vanilla';
import {
  desktop,
  native,
  bridge,
  call,
  type DesktopInfo,
  type Mcp,
  type Model,
  type Panel,
  type Status,
} from './api';
import { startBridgeLifecycle } from './bridge-lifecycle';

type Confirmation = { label: string; run: () => Promise<unknown> };
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
  logs: string;
  confirm: Confirmation | null;
  connectionError: string;
  modelsError: string;
  onboarding: boolean;
  /** The automatic addon update after an app update is running. */
  addonUpdating: boolean;
};

const onboardingKey = 'wisp:onboarding:v1';

function resumeOnboarding(configured: boolean) {
  try {
    const saved = localStorage.getItem(onboardingKey);
    const pending = saved === 'pending' || (!configured && saved !== 'complete');
    if (pending) localStorage.setItem(onboardingKey, 'pending');
    return pending;
  } catch {
    return !configured;
  }
}

const initialState: DesktopState = {
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
  logs: '',
  confirm: null,
  connectionError: '',
  modelsError: '',
  onboarding: false,
  addonUpdating: false,
};

export const desktopConnected = ({ status }: DesktopState) =>
  status?.modelConnected ?? status?.auth.status === 'connected';
export const desktopActive = ({ status }: DesktopState) => (status?.activeTurns ?? 0) > 0;
export const desktopLocked = (state: DesktopState) => !!state.busy || desktopActive(state);

export function desktopReadiness(
  state: DesktopState,
):
  | 'loading'
  | 'updating'
  | 'update'
  | 'starting'
  | 'unavailable'
  | 'setup'
  | 'account'
  | 'agent'
  | 'waiting'
  | 'ready' {
  const { loading, info, status, starting, addonUpdating } = state;
  if (loading) return 'loading';
  if (addonUpdating && info?.addonOutdated) return 'updating';
  if (info?.addonOutdated || info?.addonUpdateNotice === 'failed') return 'update';
  if (!status) return starting ? 'starting' : 'unavailable';
  if (!info?.configured) return 'setup';
  if (!desktopConnected(state)) return 'account';
  if (!status.ready) return 'agent';
  return status.gameConnected ? 'ready' : 'waiting';
}

function createDesktopSession() {
  const getState = (): DesktopState => desktopStore.getState();
  let disposed = false;
  let refreshInFlight: Promise<void> | undefined;
  let loadedAccount = '';
  let startupDeadline = 0;
  let stopBridgeLifecycle: (() => void) | undefined;
  let appUpdate: string | null = null;
  let appUpdateSync: Promise<void> | undefined;

  function update(patch: Partial<DesktopState>) {
    if (!disposed) desktopStore.setState(patch);
  }

  function refresh() {
    if (!native || disposed) return Promise.resolve();
    refreshInFlight ??= readStatus().finally(() => {
      refreshInFlight = undefined;
    });
    return refreshInFlight;
  }

  async function refreshAfterWrite() {
    // A read started before the write completed may still contain the old values.
    await refreshInFlight;
    await refresh();
  }

  async function readStatus() {
    try {
      const status = await call(bridge.status.$get());
      if (disposed) return;
      update({ status, connectionError: '', starting: false });
      syncAppUpdate(status.appUpdate);
      const catalogRevision = JSON.stringify([
        status.auth.activeId,
        status.auth.status,
        status.auth.revision,
        status.connections,
      ]);
      if (catalogRevision !== loadedAccount && !desktopLocked(getState())) {
        loadedAccount = catalogRevision;
        try {
          await loadModels();
        } catch (error) {
          loadedAccount = '';
          update({ modelsError: String(error).replace(/^Error: /, '') });
        }
      }
    } catch (error) {
      loadedAccount = '';
      const starting = getState().starting && Date.now() < startupDeadline;
      update({
        status: null,
        starting,
        connectionError: starting ? '' : String(error).replace(/^Error: /, ''),
      });
    } finally {
      update({ loading: false });
    }
  }

  /**
   * Tell the bridge which app update the game should announce. Status reads
   * call this too, so a restarted bridge or a failed send catches up.
   */
  function syncAppUpdate(reported: string | null | undefined) {
    if (!native || disposed || reported === undefined || reported === appUpdate || appUpdateSync) {
      return;
    }
    appUpdateSync = call(bridge['app-update'].$post({ json: { version: appUpdate } }))
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        appUpdateSync = undefined;
      });
  }

  async function work(
    label: string,
    action: () => Promise<unknown>,
    success?: string | null,
    target = '',
  ) {
    if (disposed || getState().busy) return false;
    update({ busy: label, busyTarget: target, failed: false, feedback: '' });
    try {
      await action();
      if (success !== null) update({ feedback: success || getState().feedback || 'Done.' });
      return true;
    } catch (error) {
      update({ failed: true, feedback: String(error).replace(/^Error: /, '') });
      return false;
    } finally {
      update({ busy: '', busyTarget: '' });
      await refreshAfterWrite();
    }
  }

  async function loadModels() {
    update({ models: [] });
    const { models } = await call(bridge.auth.models.$get());
    update({ models, modelsError: '' });
  }

  /** Resolves false when the sign-in page could not be opened. */
  async function signIn(profileId?: string, add = false) {
    return work(
      'Opening sign-in',
      async () => {
        const { authorizationUrl } = await call(
          bridge.auth.start.$post({ json: { profileId: profileId || undefined, newAccount: add } }),
        );
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

  function expectService() {
    startupDeadline = Date.now() + 15_000;
    update({ starting: true, connectionError: '' });
  }

  async function launchBridge() {
    if (disposed) return;
    expectService();
    try {
      await desktop('start_bridge');
    } catch (error) {
      update({ starting: false });
      throw error;
    }
  }

  async function install() {
    if (getState().detectingGame) return;
    await work(
      'Installing addon',
      async () => {
        await desktop('install_addon', { wow: getState().wow });
        update({ info: await desktop<DesktopInfo>('desktop_info') });
      },
      'Addon installed. Restart WoW after the first installation; use /reload for updates.',
      'installation',
    );
  }

  async function importPrevious() {
    const source = await desktop<string | null>('pick_folder');
    if (!source || disposed) return;
    await work(
      'Importing previous installation',
      async () => {
        await desktop('import_legacy', { source });
        expectService();
        const info = await desktop<DesktopInfo>('desktop_info');
        loadedAccount = '';
        update({ info, wow: info.wow || '' });
      },
      'Imported chats, memory and protected credentials.',
    );
  }

  async function showLogs() {
    await work(
      'Reading logs',
      async () => update({ logs: await desktop<string>('read_logs') }),
      null,
    );
  }

  async function setIntegration(id: string, enabled: boolean) {
    await work(
      'Updating integration',
      () => call(bridge.integrations.set.$post({ json: { id, enabled } })),
      'Integration updated.',
      id,
    );
  }

  async function panelAction(panel: Panel, action: 'show' | 'hide' | 'remove') {
    await work(
      'Updating panel',
      () =>
        call(
          bridge.panels.action.$post({
            json: { action, id: panel.id, characterKey: panel.characterKey },
          }),
        ),
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
            () => call(bridge.mcps.remove.$post({ json: { name: server.name } })),
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
        const result = await call(bridge.mcps.test.$post({ json: { server } }));
        update({ feedback: `Connected. ${result.count} tools available.` });
      },
      undefined,
      'mcp:' + server.name,
    );
  }

  async function searchInstallations() {
    const state = getState();
    const { info, detectingGame, wow: previous } = state;
    if (!native || disposed || info?.configured || detectingGame || desktopLocked(state)) {
      return;
    }
    update({ detectingGame: true, detectionFailed: false, feedback: '', failed: false });
    const folders = new Set<string>();
    let accepting = true;
    const addFolder = (folder: string) => {
      if (accepting && !disposed && !getState().info?.configured) {
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
      if (!disposed) {
        const detectedFolders = [...folders];
        update({
          detectedFolders,
          wow: folders.has(previous) ? previous : detectedFolders[0] || '',
          detectingGame: false,
        });
      }
    }
  }

  return {
    dispose() {
      disposed = true;
      stopBridgeLifecycle?.();
    },
    mount() {
      if (!native) {
        update({ loading: false });
        return;
      }
      stopBridgeLifecycle = startBridgeLifecycle({
        onDesktopInfo(info) {
          update({ info, wow: info.wow || '', onboarding: resumeOnboarding(info.configured) });
          if (!info.configured) void searchInstallations();
        },
        onAddonUpdate({ wow, ...addon }) {
          const { info } = getState();
          if (info && info.wow === wow) update({ info: { ...info, ...addon } });
        },
        onAddonUpdating: (addonUpdating) => update({ addonUpdating }),
        launchBridge,
        refresh,
        onError: (feedback) => update({ failed: true, feedback }),
        onInitializationError: (feedback) => update({ failed: true, feedback, loading: false }),
      });
    },
    actions: {
      refresh,
      refreshAfterWrite,
      work,
      loadModels,
      signIn,
      searchInstallations,
      install,
      importPrevious,
      /** Remember setup as done while the wizard still shows its last screen. */
      markOnboardingComplete() {
        try {
          localStorage.setItem(onboardingKey, 'complete');
        } catch {
          // Setup can still finish when webview storage is unavailable.
        }
      },
      finishOnboarding() {
        try {
          localStorage.setItem(onboardingKey, 'complete');
        } catch {
          // Setup can still finish when webview storage is unavailable.
        }
        update({ onboarding: false });
      },
      showLogs,
      setIntegration,
      panelAction,
      removeMcp,
      testMcp,
      chooseFolder: () => work('Choosing folder', pickFolder, undefined, 'folder-picker'),
      selectFolder: (wow: string) => update({ wow }),
      dismissAddonReload: () => {
        const { info } = getState();
        if (info?.addonUpdateNotice === 'reload_required') {
          update({ info: { ...info, addonUpdateNotice: null } });
        }
      },
      setConfirmation: (confirm: Confirmation | null) => update({ confirm }),
      setBusy: (busy: string) => update({ busy }),
      /** The app update the updater found (null when none), announced in game. */
      setAppUpdate: (version: string | null) => {
        appUpdate = version;
        syncAppUpdate(getState().status?.appUpdate);
      },
      clearFeedback: () => update({ feedback: '' }),
    },
  };
}

let session = createDesktopSession();
export const desktopStore = createStore(() => ({ ...initialState, actions: session.actions }));

export function mountDesktop() {
  const mounted = session;
  mounted.mount();
  return () => {
    mounted.dispose();
    session = createDesktopSession();
    desktopStore.setState({ ...initialState, actions: session.actions }, true);
  };
}
