import { characterLabel } from '@wisp/protocol/character-key';
import { onMount } from 'svelte';
import { listen } from '@tauri-apps/api/event';
import { Channel } from '@tauri-apps/api/core';
import {
  desktop,
  request,
  native,
  type Status,
  type DesktopInfo,
  type Model,
  type Mcp,
  type Panel,
} from './api';

export function createDesktopController() {
  const pages = [
    {
      name: 'Overview',
      icon: 'home',
      title: 'Wisp status',
      caption: 'Check your game connection, addon and AI provider.',
    },
    {
      name: 'Connections',
      icon: 'link',
      title: 'AI connections',
      caption: 'Connect AI providers and choose your default model.',
    },
    {
      name: 'Integrations',
      icon: 'tools',
      title: 'Integrations',
      caption: 'Choose which addons, data sources and tools Wisp can use.',
    },
    {
      name: 'Memory',
      icon: 'logs',
      title: 'Memory',
      caption: 'Control saved preferences and character plans.',
    },
    {
      name: 'Panels',
      icon: 'panel',
      title: 'Panels',
      caption: 'Manage your in-game trackers.',
    },
    {
      name: 'Routines',
      icon: 'spark',
      title: 'Routines',
      caption: 'Manage routines created in chat and review their runs.',
    },
    {
      name: 'Settings',
      icon: 'refresh',
      title: 'Settings',
      caption: 'Updates and preferences for the desktop app.',
    },
    {
      name: 'Diagnostics',
      icon: 'logs',
      title: 'Diagnostics',
      caption: 'View connection details and logs.',
    },
  ];
  let page = $state('Overview');
  let current = $derived(pages.find((p) => p.name === page)!);
  let status = $state<Status | null>(null);
  let info = $state<DesktopInfo | null>(null);
  let loading = $state(true);
  let starting = $state(false);
  let busy = $state('');
  let busyTarget = $state('');
  let feedback = $state('');
  let failed = $state(false);
  let wow = $state('');
  let detectedFolders = $state<string[]>([]);
  let detectingGame = $state(false);
  let detectionFailed = $state(false);
  let disposed = false;
  let models = $state<Model[]>([]);
  let model = $state('');
  let account = $state('');
  let loadedAccount = '';
  let logs = $state('');
  let dialog = $state(false);
  let editing = $state<Mcp | null>(null);
  let confirm = $state<{ label: string; run: () => Promise<void> } | null>(null);
  let polling = false;
  let connectionError = $state('');
  let modelsError = $state('');
  const connected = $derived(status?.modelConnected ?? status?.auth.status === 'connected');
  const active = $derived((status?.activeTurns || 0) > 0);
  const locked = $derived(!!busy || active);
  async function refresh() {
    if (!native || polling) {
      return;
    }
    polling = true;
    try {
      const next = await request<Status>('/status');
      status = next;
      connectionError = '';
      if (next.ready) {
        starting = false;
      }
      if (!account || !next.auth.profiles.some((p) => p.id === account)) {
        account = next.auth.activeId || '';
      }
      if (!model) {
        model = next.model;
      }
      const catalogRevision = JSON.stringify([
        next.auth.activeId,
        next.auth.status,
        next.auth.revision,
        next.connections,
      ]);
      if (catalogRevision !== loadedAccount && !active && !busy) {
        loadedAccount = catalogRevision;
        try {
          await loadModels();
        } catch (error) {
          loadedAccount = '';
          modelsError = String(error).replace(/^Error: /, '');
        }
      }
    } catch (error) {
      status = null;
      connectionError = String(error).replace(/^Error: /, '');
    } finally {
      loading = false;
      polling = false;
    }
  }
  async function work(
    label: string,
    action: () => Promise<unknown>,
    success?: string,
    target = '',
  ) {
    if (busy) {
      return;
    }
    busyTarget = target;
    busy = label;
    failed = false;
    feedback = '';
    try {
      await action();
      feedback = success || feedback || 'Done.';
    } catch (e) {
      failed = true;
      feedback = String(e).replace(/^Error: /, '');
    } finally {
      busy = '';
      busyTarget = '';
      await refresh();
    }
  }
  async function loadModels() {
    models = [];
    const result = await request<{ models: Model[] }>('/auth/models');
    models = result.models;
    modelsError = '';
    if (!models.some((m) => m.slug === model)) {
      model = status?.model || models[0]?.slug || '';
    }
  }
  async function signIn(add = false) {
    await work(
      'Opening sign-in',
      async () => {
        const result = await request<{ authorizationUrl: string }>('/auth/start', {
          profileId: add ? undefined : account || undefined,
          newAccount: add,
        });
        await desktop('open_sign_in', { url: result.authorizationUrl });
      },
      'Continue in your browser. Wisp will update when sign-in completes.',
    );
  }
  async function chooseFolder() {
    if (detectingGame) {
      return;
    }
    const folder = await desktop<string | null>('pick_folder');
    if (folder) {
      wow = folder;
    }
  }
  async function launchBridge() {
    starting = true;
    try {
      await desktop('start_bridge');
    } catch (error) {
      starting = false;
      throw error;
    }
  }
  async function start() {
    starting = true;
    await work('Starting Wisp', () => launchBridge(), 'Wisp is starting.');
    if (failed) {
      starting = false;
    }
  }
  async function install() {
    if (detectingGame) {
      return;
    }
    await work(
      'Installing addon',
      async () => {
        feedback = await desktop<string>('install_addon', { wow });
        info = await desktop<DesktopInfo>('desktop_info');
        await launchBridge();
      },
      'Addon installed. Restart WoW after the first installation; use /reload for updates.',
      'installation',
    );
  }
  async function importPrevious() {
    const source = await desktop<string | null>('pick_folder');
    if (!source) {
      return;
    }
    await work(
      'Importing previous installation',
      async () => {
        await desktop('import_legacy', { source });
        info = await desktop<DesktopInfo>('desktop_info');
        wow = info.wow || '';
        await launchBridge();
      },
      'Imported chats, memory and protected credentials. Wisp is starting.',
    );
  }
  async function showLogs() {
    page = 'Diagnostics';
    await work(
      'Reading logs',
      async () => {
        logs = await desktop<string>('read_logs');
      },
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
  function edit(server: Mcp | null) {
    editing = server;
    dialog = true;
  }
  async function panelAction(panel: Panel, action: string) {
    await work(
      'Updating panel',
      () =>
        request('/panels/action', {
          action,
          id: panel.id,
          characterKey: panel.characterKey,
        }),
      'Panel updated.',
      panel.id,
    );
  }
  function removeMcp(server: Mcp) {
    confirm = {
      label: `Remove “${server.name}”?`,
      run: () =>
        work(
          'Removing connection',
          () => request('/mcps/remove', { name: server.name }),
          'Connection removed.',
          'mcp:' + server.name,
        ),
    };
  }
  async function searchInstallations() {
    if (!native || disposed || info?.configured || detectingGame || locked) {
      return;
    }
    detectingGame = true;
    detectionFailed = false;
    feedback = '';
    failed = false;
    const previous = wow;
    const folders = new Set<string>();
    let accepting = true;
    const addFolder = (folder: string) => {
      if (accepting && !disposed && !info?.configured) {
        folders.add(folder);
      }
    };
    try {
      const onFound = new Channel<string>();
      onFound.onmessage = addFolder;
      (await desktop<string[]>('detect_game_folders', { onFound })).forEach(addFolder);
    } catch {
      detectionFailed = true;
    } finally {
      accepting = false;
      if (!disposed) {
        detectedFolders = [...folders];
        wow = folders.has(previous) ? previous : detectedFolders[0] || '';
        detectingGame = false;
        if (detectedFolders.length && !busy && !feedback) {
          failed = false;
          feedback =
            detectedFolders.length === 1
              ? 'WoW Forever found.'
              : `Found ${detectedFolders.length} WoW Forever installations.`;
        }
      }
    }
  }
  onMount(() => {
    let unsubscribe: (() => void) | undefined;
    if (!native) {
      loading = false;
      return;
    }
    void (async () => {
      info = await desktop<DesktopInfo>('desktop_info');
      if (disposed) {
        return;
      }
      wow = info.wow || '';
      if (!info.configured) {
        void searchInstallations();
      }
      if (info.configured) {
        starting = true;
        try {
          await launchBridge();
        } catch (e) {
          starting = false;
          failed = true;
          feedback = String(e);
        }
      }
      await refresh();
      if (disposed) {
        return;
      }
      const stop = await listen<string>('desktop-error', (event) => {
        failed = true;
        feedback = event.payload;
      });
      if (disposed) {
        stop();
      } else {
        unsubscribe = stop;
      }
    })().catch((e) => {
      failed = true;
      feedback = String(e);
      loading = false;
    });
    const timer = setInterval(() => {
      void refresh();
    }, 3000);
    return () => {
      disposed = true;
      clearInterval(timer);
      unsubscribe?.();
    };
  });

  return {
    get connectionError() {
      return connectionError;
    },
    get modelsError() {
      return modelsError;
    },
    get pages() {
      return pages;
    },
    get page() {
      return page;
    },
    set page(value: typeof page) {
      page = value;
    },
    get current() {
      return current;
    },
    get status() {
      return status;
    },
    set status(value: typeof status) {
      status = value;
    },
    get info() {
      return info;
    },
    set info(value: typeof info) {
      info = value;
    },
    get loading() {
      return loading;
    },
    set loading(value: typeof loading) {
      loading = value;
    },
    get starting() {
      return starting;
    },
    set starting(value: typeof starting) {
      starting = value;
    },
    get busyTarget() {
      return busyTarget;
    },
    get busy() {
      return busy;
    },
    set busy(value: typeof busy) {
      busy = value;
    },
    get feedback() {
      return feedback;
    },
    set feedback(value: typeof feedback) {
      feedback = value;
    },
    get failed() {
      return failed;
    },
    set failed(value: typeof failed) {
      failed = value;
    },
    get wow() {
      return wow;
    },
    set wow(value: typeof wow) {
      wow = value;
    },
    get detectedFolders() {
      return detectedFolders;
    },
    get detectingGame() {
      return detectingGame;
    },
    get detectionFailed() {
      return detectionFailed;
    },
    get models() {
      return models;
    },
    set models(value: typeof models) {
      models = value;
    },
    get model() {
      return model;
    },
    set model(value: typeof model) {
      model = value;
    },
    get account() {
      return account;
    },
    set account(value: typeof account) {
      account = value;
    },
    get logs() {
      return logs;
    },
    set logs(value: typeof logs) {
      logs = value;
    },
    get dialog() {
      return dialog;
    },
    set dialog(value: typeof dialog) {
      dialog = value;
    },
    get editing() {
      return editing;
    },
    set editing(value: typeof editing) {
      editing = value;
    },
    get confirm() {
      return confirm;
    },
    set confirm(value: typeof confirm) {
      confirm = value;
    },
    get connected() {
      return connected;
    },
    get active() {
      return active;
    },
    get locked() {
      return locked;
    },
    characterLabel,
    refresh,
    work,
    loadModels,
    signIn,
    chooseFolder,
    searchInstallations,
    start,
    install,
    importPrevious,
    showLogs,
    setIntegration,
    edit,
    panelAction,
    removeMcp,
  };
}
export type DesktopController = ReturnType<typeof createDesktopController>;
