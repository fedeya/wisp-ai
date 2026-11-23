import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';

import App, { createDesktopRouter } from './App';
import { desktopStore } from './desktop-controller';
import { desktop, type Status } from './api';
import { bridgeRequest as request } from './api/bridge-request';
import { listen } from '@tauri-apps/api/event';
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks';
import { chooseOption, openSelect } from './select-test-helpers';
vi.mock('./api/desktop', () => ({ native: true, desktop: vi.fn() }));
vi.mock('./api/bridge-request', () => ({ bridgeRequest: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}));
let status: Status;
const routers: ReturnType<typeof createDesktopRouter>[] = [];

function renderApp(reactStrictMode = false) {
  const router = createDesktopRouter();
  routers.push(router);
  render(<App router={router} />, { reactStrictMode });
  return router;
}
beforeEach(() => {
  mockIPC(() => null);
  localStorage.clear();
  vi.clearAllMocks();
  vi.mocked(listen).mockResolvedValue(() => {});
  status = {
    ready: true,
    gameConnected: true,
    activeTurns: 0,
    connections: [],
    model: 'luna',
    auth: {
      status: 'connected',
      revision: 1,
      activeId: 'first',
      account: 'Player',
      profiles: [{ id: 'first', label: 'First account', connected: true }],
    },
    mcps: [],
    integrations: [],
    panels: [],
    routines: [],
    routineRuns: [],
    characters: {},
    appUpdate: null,
  };
  vi.mocked(desktop).mockImplementation(async (command) => {
    if (command === 'detect_game_folders') {
      return [] as never;
    }
    if (command === 'desktop_info') {
      return {
        configured: true,
        wow: 'E:\\WoW',
        version: '0.0.1',
        platform: 'windows',
        dataDirectory: 'userdata',
      } as never;
    }
    return undefined as never;
  });
  vi.mocked(request).mockImplementation(async (route) => {
    if (route === '/status') {
      return status as never;
    }
    if (route === '/auth/models') {
      return {
        models: [
          { slug: 'luna', displayName: 'Luna', efforts: ['low', 'medium'] },
          { slug: 'sol', displayName: 'Sol', efforts: ['low', 'high'] },
        ],
      } as never;
    }
    if (route === '/auth/start') {
      return {
        authorizationUrl: 'https://auth.openai.com/authorize?test=1',
      } as never;
    }
    return { ok: true, count: 3 } as never;
  });
});

test('AI Providers stays available while the addon updates and the reload reminder can be dismissed', async () => {
  const fallback = vi.mocked(desktop).getMockImplementation()!;
  let finishUpdate!: () => void;
  const updating = new Promise<void>((resolve) => {
    finishUpdate = resolve;
  });
  vi.mocked(desktop).mockImplementation(async (command, args) => {
    if (command === 'auto_update_addon') {
      await updating;
      return {
        wow: 'E:\\WoW',
        addonOutdated: false,
        addonUpdateNotice: 'reload_required',
      } as never;
    }
    return fallback(command, args);
  });
  const router = renderApp();
  await screen.findByRole('heading', { name: 'Wisp is ready' });
  expect(desktop).toHaveBeenNthCalledWith(1, 'start_bridge');
  await openConnections();
  expect(screen.getByRole('button', { name: 'Add provider' })).toBeTruthy();

  await act(async () => finishUpdate());
  await act(() => router.navigate('/'));
  const reminder = 'Wisp updated the addon. Type /reload in WoW to finish updating.';
  expect(await screen.findByText(reminder)).toBeTruthy();
  await act(() => router.navigate('/settings'));
  await act(() => router.navigate('/'));
  expect(await screen.findByText(reminder)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
  expect(screen.queryByText(reminder)).toBeNull();
});

test('Overview shows the automatic addon update in progress instead of the update button', async () => {
  const fallback = vi.mocked(desktop).getMockImplementation()!;
  let finishUpdate!: () => void;
  const updating = new Promise<void>((resolve) => {
    finishUpdate = resolve;
  });
  vi.mocked(desktop).mockImplementation(async (command, args) => {
    if (command === 'desktop_info') {
      const info = await fallback(command, args);
      return { ...(info as object), addonOutdated: true, addonUpdatePending: true } as never;
    }
    if (command === 'auto_update_addon') {
      await updating;
      return {
        wow: 'E:\\WoW',
        addonOutdated: false,
        addonUpdateNotice: 'reload_required',
        addonUpdatePending: false,
      } as never;
    }
    return fallback(command, args);
  });
  renderApp();
  await screen.findByRole('heading', { name: 'Updating your Wisp addon' });
  expect(screen.getByText('Updating addon')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Update addon' })).toBeNull();
  // The header and the addon check show the progress; no extra progress line repeats it.
  expect(document.querySelector('main .action-progress')).toBeNull();

  await act(async () => finishUpdate());
  await screen.findByRole('heading', { name: 'Wisp is ready' });
  expect(
    screen.getByText('Wisp updated the addon. Type /reload in WoW to finish updating.'),
  ).toBeTruthy();
});

test('an app update found by the updater is reported to the bridge until it holds', async () => {
  const fallback = vi.mocked(desktop).getMockImplementation()!;
  vi.mocked(desktop).mockImplementation(async (command, args) => {
    if (command === 'update_channel') return 'stable' as never;
    if (command === 'check_update') {
      return { supported: true, update: { version: '0.0.9', notes: null } } as never;
    }
    return fallback(command, args);
  });
  const reports = () => vi.mocked(request).mock.calls.filter(([route]) => route === '/app-update');
  renderApp();
  expect(await screen.findByText('Wisp 0.0.9 is available.')).toBeTruthy();
  await waitFor(() => expect(reports()).toEqual([['/app-update', { version: '0.0.9' }]]));

  // The bridge holds it now, so status reads send nothing more.
  status = { ...status, appUpdate: '0.0.9' };
  await act(() => desktopStore.getState().actions.refresh());
  expect(reports()).toHaveLength(1);

  // A restarted bridge forgot it; the next status read resends it.
  status = { ...status, appUpdate: null };
  await act(() => desktopStore.getState().actions.refresh());
  await waitFor(() => expect(reports()).toHaveLength(2));
  expect(reports()[1]).toEqual(['/app-update', { version: '0.0.9' }]);
});

test('an automatic addon update failure still starts Wisp and offers a manual retry', async () => {
  const fallback = vi.mocked(desktop).getMockImplementation()!;
  vi.mocked(desktop).mockImplementation(async (command, args) =>
    command === 'auto_update_addon'
      ? ({ wow: 'E:\\WoW', addonOutdated: false, addonUpdateNotice: 'failed' } as never)
      : fallback(command, args),
  );
  renderApp();
  expect(await screen.findByText(/couldn’t update the addon automatically/)).toBeTruthy();
  expect(desktop).toHaveBeenCalledWith('start_bridge');
  fireEvent.click(screen.getByRole('button', { name: 'Update addon' }));
  expect(await screen.findByText(/Addon installed\. Restart WoW/)).toBeTruthy();
  expect(screen.queryByText(/couldn’t update the addon automatically/)).toBeNull();
});
afterEach(() => {
  cleanup();
  for (const router of routers.splice(0)) router.dispose();
  clearMocks();
});

async function openConnections() {
  await fireEvent.click(screen.getByRole('link', { name: 'AI Providers' }));
  await screen.findByRole('heading', { name: 'AI Providers', level: 1 });
}

async function openProviderPicker() {
  await fireEvent.click(screen.getByRole('button', { name: 'Add provider' }));
  return screen.findByRole('dialog', { name: 'Add provider' });
}

async function openProvider(action: string, provider: string) {
  await fireEvent.click(screen.getByRole('link', { name: action }));
  await screen.findByRole('heading', { level: 1, name: provider });
  expect(screen.getByRole('link', { name: 'AI Providers', current: 'page' })).toBeTruthy();
}

async function openSearchSettings() {
  await fireEvent.click(screen.getByRole('link', { name: 'Integrations' }));
  await fireEvent.click(await screen.findByRole('link', { name: 'Configure Web search' }));
}

test.each([
  { failed: false, duration: 5000 },
  { failed: true, duration: 10000 },
])('notifications expire after $duration ms (failed: $failed)', async ({ failed, duration }) => {
  renderApp();
  await screen.findByRole('heading', { name: 'Wisp is ready' });
  await openSearchSettings();
  if (failed) {
    vi.mocked(request).mockRejectedValueOnce(new Error('Could not save settings'));
  }
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    await fireEvent.click(screen.getByRole('button', { name: 'Save search settings' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.queryByRole('button', { name: 'Dismiss notification' })).toBeTruthy();
    await vi.advanceTimersByTimeAsync(duration - 1);
    expect(screen.queryByRole('button', { name: 'Dismiss notification' })).toBeTruthy();
    await vi.advanceTimersByTimeAsync(1);
    expect(screen.queryByRole('button', { name: 'Dismiss notification' })).toBeNull();
  } finally {
    cleanup();
    vi.useRealTimers();
  }
});

/** First run opens on the welcome screen; continue to the addon step. */
async function startSetup() {
  await fireEvent.click(await screen.findByRole('button', { name: 'Get started' }));
}

function mockUnconfiguredDetection(result: Promise<string[]>) {
  const fallback = vi.mocked(desktop).getMockImplementation()!;
  vi.mocked(desktop).mockImplementation(async (command, args) => {
    if (command === 'desktop_info') {
      return { configured: false, wow: null } as never;
    }
    if (command === 'detect_game_folders') {
      return (await result) as never;
    }
    if (command === 'pick_folder') {
      return 'F:\\My Games\\Forever' as never;
    }
    return fallback(command, args);
  });
}

test('detects a single Forever installation without installing or saving it', async () => {
  mockUnconfiguredDetection(Promise.resolve(['E:\\Blizzard\\World of Warcraft\\_forever_']));
  renderApp();
  await startSetup();
  const input = (await screen.findByLabelText('WoW client folder')) as HTMLInputElement;
  await waitFor(() => expect(input.value).toBe('E:\\Blizzard\\World of Warcraft\\_forever_'));
  expect(desktop).not.toHaveBeenCalledWith('install_addon', expect.anything());
  expect(input.readOnly).toBe(true);
  expect(screen.getByText('WoW Forever found.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Choose folder' })).toBeTruthy();
  await fireEvent.click(input);
  await waitFor(() => expect(desktop).toHaveBeenCalledWith('pick_folder'));
  await waitFor(() => expect(input.value).toBe('F:\\My Games\\Forever'));
});

test('additional installations keep the first selection and offer alternatives', async () => {
  mockUnconfiguredDetection(Promise.resolve(['D:\\Forever', 'E:\\Forever']));
  renderApp();
  await startSetup();
  const choices = await screen.findByLabelText('Detected Forever installations');
  expect(screen.getByText('Found 2 WoW Forever installations.')).toBeTruthy();
  expect(choices.textContent).toBe('D:\\Forever');
  await chooseOption(choices, 'E:\\Forever');
  expect(choices.textContent).toBe('E:\\Forever');
});

test('search hides selection until all results are ready', async () => {
  let finish!: (folders: string[]) => void;
  mockUnconfiguredDetection(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  renderApp();
  await startSetup();
  await screen.findByText('Finding WoW Forever…');
  await waitFor(() =>
    expect(desktop).toHaveBeenCalledWith('detect_game_folders', expect.anything()),
  );
  const args = vi.mocked(desktop).mock.calls.find(([name]) => name === 'detect_game_folders')![1]!;
  const progress = args.onFound as { onmessage: (folder: string) => void };
  progress.onmessage('E:\\Forever');
  expect(screen.queryByLabelText('WoW client folder')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Choose folder' })).toBeNull();
  expect((screen.getByRole('button', { name: 'Search again' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect(screen.queryByRole('button', { name: 'Install addon' })).toBeNull();
  progress.onmessage('D:\\Forever');
  finish(['E:\\Forever', 'D:\\Forever']);
  const choices = await screen.findByRole('combobox', { name: 'Detected Forever installations' });
  expect(choices.textContent).toBe('E:\\Forever');
  expect((screen.getByRole('button', { name: 'Search again' }) as HTMLButtonElement).disabled).toBe(
    false,
  );
  expect(
    within(await openSelect(choices)).getAllByRole('option', { name: 'E:\\Forever' }),
  ).toHaveLength(1);
});

test('unsuccessful search enables manual selection and can be retried', async () => {
  let finish!: (folders: string[]) => void;
  mockUnconfiguredDetection(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  renderApp();
  await startSetup();
  await screen.findByText('Finding WoW Forever…');
  finish([]);
  await fireEvent.click(await screen.findByRole('button', { name: 'Choose folder' }));
  const input = screen.getByLabelText('WoW client folder') as HTMLInputElement;
  await waitFor(() => expect(input.value).toBe('F:\\My Games\\Forever'));
  expect(input.value).toBe('F:\\My Games\\Forever');
  await fireEvent.click(screen.getByRole('button', { name: 'Search again' }));
  await waitFor(() =>
    expect(
      vi.mocked(desktop).mock.calls.filter(([name]) => name === 'detect_game_folders'),
    ).toHaveLength(2),
  );
  await waitFor(() => {
    expect((screen.getByLabelText('WoW client folder') as HTMLInputElement).value).toBe('');
  });
});

test('configured installations skip detection', async () => {
  renderApp();
  await screen.findByRole('heading', { name: 'Wisp is ready' });
  expect(desktop).not.toHaveBeenCalledWith('detect_game_folders', expect.anything());
});

test('search again waits for fresh results and ignores updates from the previous search', async () => {
  mockUnconfiguredDetection(Promise.resolve([]));
  renderApp();
  await startSetup();
  await screen.findByText(/No WoW Forever installation found/);
  const previous = vi
    .mocked(desktop)
    .mock.calls.find(([name]) => name === 'detect_game_folders')![1]!.onFound as {
    onmessage: (folder: string) => void;
  };
  let finish!: (folders: string[]) => void;
  const result = new Promise<string[]>((resolve) => {
    finish = resolve;
  });
  const fallback = vi.mocked(desktop).getMockImplementation()!;
  vi.mocked(desktop).mockImplementation(async (command, args) => {
    if (command === 'detect_game_folders') {
      return (await result) as never;
    }
    return fallback(command, args);
  });
  await fireEvent.click(screen.getByRole('button', { name: 'Search again' }));
  await screen.findByText('Finding WoW Forever…');
  expect(screen.queryByLabelText('WoW client folder')).toBeNull();
  previous.onmessage('D:\\Stale');
  finish(['E:\\Forever']);
  const folder = (await screen.findByLabelText('WoW client folder')) as HTMLInputElement;
  expect(folder.value).toBe('E:\\Forever');
  expect(folder.readOnly).toBe(true);
  expect(screen.queryByLabelText('Detected Forever installations')).toBeNull();
});

test('AI Providers links directly to web search settings without exposing saved keys', async () => {
  status.search = { provider: 'auto', hasExaKey: true };
  renderApp();
  await screen.findByRole('heading', { name: 'Wisp is ready' });
  await openConnections();
  expect(screen.getByRole('heading', { name: 'ChatGPT' })).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Claude' })).toBeNull();
  expect(await screen.findByRole('heading', { name: 'Default model' })).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Web search' })).toBeNull();
  await fireEvent.click(screen.getByRole('link', { name: 'Configure web search in Integrations' }));
  await screen.findByRole('heading', { name: 'Web search', level: 1 });
  expect(screen.getByRole('link', { name: 'Integrations' }).getAttribute('aria-current')).toBe(
    'page',
  );
  const key = screen.getByLabelText(
    'Exa API key (optional) (leave blank to keep saved key)',
  ) as HTMLInputElement;
  expect(key.value).toBe('');
  expect(key.type).toBe('password');
  const service = screen.getByRole<HTMLButtonElement>('combobox', { name: 'Search service' });
  await chooseOption(service, 'Exa for all chats');
  status.search = { provider: 'chatgpt', hasExaKey: true };
  await fireEvent.click(screen.getByRole('button', { name: 'Test Exa' }));
  await screen.findByText('Exa accepted the test search. Results depend on source coverage.');
  await waitFor(() => expect(service.disabled).toBe(false));
  expect(service.textContent).toBe('Exa for all chats');
  await fireEvent.click(screen.getByRole('button', { name: 'Save search settings' }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('/search/save', { provider: 'exa', apiKey: undefined }),
  );
  expect(request).not.toHaveBeenCalledWith('/connections/save', expect.anything());
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Get Exa key' }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  await fireEvent.click(screen.getByRole('button', { name: 'Get Exa key' }));
  await waitFor(() => expect(desktop).toHaveBeenCalledWith('open_exa_dashboard'));
});

test('saving search settings queues a fresh status read behind an in-flight poll', async () => {
  const oldSearch = { provider: 'auto', hasExaKey: false } as const;
  const newSearch = { provider: 'exa', hasExaKey: true } as const;
  status.search = oldSearch;
  renderApp();
  await screen.findByRole('heading', { name: 'Wisp is ready' });
  await openSearchSettings();
  const refresh = desktopStore.getState().actions.refresh;
  await act(refresh);

  let finishStale!: (value: Status) => void;
  let finishFresh!: (value: Status) => void;
  const stale = new Promise<Status>((resolve) => {
    finishStale = resolve;
  });
  const fresh = new Promise<Status>((resolve) => {
    finishFresh = resolve;
  });
  const freshStarted = vi.fn();
  const original = vi.mocked(request).getMockImplementation()!;
  let saveCompleted = false;
  vi.mocked(request).mockImplementation(async (route, body) => {
    if (route === '/search/save') {
      saveCompleted = true;
    }
    if (route === '/status') {
      if (!saveCompleted) return stale as never;
      freshStarted();
      return fresh as never;
    }
    return original(route, body);
  });

  const unfinishedPoll = refresh();
  const provider = screen.getByRole('combobox', { name: 'Search service' });
  const key = screen.getByLabelText<HTMLInputElement>('Exa API key (optional)');
  await chooseOption(provider, 'Exa for all chats');
  fireEvent.input(key, { target: { value: 'test-key' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save search settings' }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('/search/save', { provider: 'exa', apiKey: 'test-key' }),
  );
  expect(freshStarted).not.toHaveBeenCalled();

  await act(async () => {
    finishStale({ ...status, search: oldSearch });
    await unfinishedPoll;
  });
  await waitFor(() => expect(freshStarted).toHaveBeenCalledTimes(1));
  expect(provider.textContent).toBe('Exa for all chats');

  await act(async () => {
    finishFresh({ ...status, search: newSearch });
  });
  await screen.findByText('Search settings saved.');
  expect(provider.textContent).toBe('Exa for all chats');
  expect(key.value).toBe('');
  expect(freshStarted).toHaveBeenCalledTimes(1);
});

test('Exa testing is available without a key and saving clears the password field', async () => {
  status.search = { provider: 'auto', hasExaKey: false };
  renderApp();
  await screen.findByRole('heading', { name: 'Wisp is ready' });
  await openSearchSettings();
  expect((screen.getByRole('button', { name: 'Test Exa' }) as HTMLButtonElement).disabled).toBe(
    false,
  );
  await fireEvent.input(screen.getByLabelText('Exa API key (optional)'), {
    target: { value: 'exa-test-key' },
  });
  await fireEvent.click(screen.getByRole('button', { name: 'Test Exa' }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('/search/test', {
      provider: 'auto',
      apiKey: 'exa-test-key',
    }),
  );
  const save = screen.getByRole('button', { name: 'Save search settings' }) as HTMLButtonElement;
  await waitFor(() => expect(save.disabled).toBe(false));
  await fireEvent.click(save);
  await waitFor(() =>
    expect((screen.getByLabelText('Exa API key (optional)') as HTMLInputElement).value).toBe(''),
  );
});
test('the provider directory exposes the registry and preserves manual model setup', async () => {
  renderApp();
  await screen.findByRole('heading', { name: 'Wisp is ready' });
  await openConnections();
  const providers = within(await openProviderPicker());
  expect(providers.getAllByRole('link')).toHaveLength(19);
  expect(providers.getByRole('link', { name: 'Gemini' })).toBeTruthy();
  expect(providers.getByRole('link', { name: 'OpenRouter' })).toBeTruthy();
  expect(providers.queryByRole('link', { name: 'ChatGPT' })).toBeNull();
  expect(providers.queryByRole('link', { name: /Bedrock/ })).toBeNull();
  const providerSearch = providers.getByRole('searchbox', { name: 'Search providers' });
  await fireEvent.input(providerSearch, {
    target: { value: 'vercel' },
  });
  expect(screen.getByRole('link', { name: 'Vercel AI Gateway' })).toBeTruthy();
  expect(screen.queryByRole('link', { name: 'OpenRouter' })).toBeNull();
  await fireEvent.input(providerSearch, { target: { value: 'anthropic' } });
  await openProvider('Claude', 'Claude');
  expect(screen.queryByRole('combobox', { name: 'Provider' })).toBeNull();
  expect(screen.queryByLabelText('Connection name')).toBeNull();
  const key = screen.getByLabelText('API key');
  expect(key.getAttribute('type')).toBe('password');
  await fireEvent.input(key, { target: { value: 'test-api-key' } });
  await fireEvent.click(screen.getByRole('button', { name: 'Add a model manually' }));
  const draftModel = screen.getByLabelText('Model ID');
  const addModel = screen.getByRole('button', { name: 'Add model' });
  await fireEvent.input(draftModel, { target: { value: 'discarded-model' } });
  await fireEvent.click(addModel);
  await fireEvent.input(screen.getByLabelText('Model ID'), {
    target: { value: 'claude-test' },
  });
  await fireEvent.input(screen.getByLabelText('Context window in tokens'), {
    target: { value: '200000' },
  });
  await fireEvent.click(addModel);
  await fireEvent.click(screen.getByRole('button', { name: 'Selected model settings' }));
  await fireEvent.click(await screen.findByRole('button', { name: 'Remove discarded-model' }));
  const contextWindow = (await screen.findByLabelText(
    'Context window for claude-test',
  )) as HTMLInputElement;
  expect(contextWindow.value).toBe('200000');
  const save = screen.getByRole('button', { name: 'Save connection' }) as HTMLButtonElement;
  // Blank means automatic: the bridge fills in the known window.
  await fireEvent.input(contextWindow, { target: { value: '' } });
  await waitFor(() => expect(save.disabled).toBe(false));
  for (const value of ['-1', '1.5', '100000001']) {
    fireEvent.input(contextWindow, { target: { value } });
    expect(save.disabled).toBe(true);
    expect(contextWindow.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('Enter a whole number between 1 and 100,000,000.')).toBeTruthy();
    fireEvent.submit(contextWindow.form!);
  }
  expect(request).not.toHaveBeenCalledWith('/connections/save', expect.anything());
  await fireEvent.input(contextWindow, { target: { value: '200000' } });
  await fireEvent.click(save);
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('/connections/save', {
      id: undefined,
      provider: 'anthropic',
      name: undefined,
      apiKey: 'test-api-key',
      baseURL: undefined,
      models: [{ id: 'claude-test', contextWindow: 200000 }],
    }),
  );
  await waitFor(() => expect(screen.queryByLabelText('API key')).toBeNull());
});

test.each([
  {
    provider: 'openrouter' as const,
    name: 'OpenRouter',
    existingDefault: true,
    selection: 'Luna',
    overview: 'Wisp is ready',
  },
  {
    provider: 'gateway' as const,
    name: 'Vercel AI Gateway',
    existingDefault: false,
    selection: 'Choose a model',
    overview: 'Connect your AI account',
  },
])(
  '$name saves every usable model on connect and keeps the default at $selection',
  async ({ provider, name, existingDefault, selection, overview }) => {
    if (!existingDefault) {
      status.auth = { status: 'signed_out', revision: 1, profiles: [] };
      status.model = '';
    }
    const sonnet = { id: 'anthropic/claude-sonnet', name: 'Claude Sonnet', contextWindow: 200000 };
    const haiku = { id: 'anthropic/claude-haiku', name: 'Claude Haiku', contextWindow: 200000 };
    const catalog = [
      { ...sonnet, supportsTools: true },
      { ...haiku, supportsTools: true },
      { id: 'example/text-only', supportsTools: false },
      { id: 'example/unknown' },
    ];
    const id = '35302f8c-128a-48fb-98a1-9eb03bb71f72';
    const original = vi.mocked(request).getMockImplementation()!;
    vi.mocked(request).mockImplementation(async (route, body) => {
      if (route === '/connections/discover') {
        return { models: catalog } as never;
      }
      if (route === '/connections/save') {
        status.connections = [
          {
            id,
            provider,
            name,
            hasKey: true,
            models: (body as { models: (typeof sonnet)[] }).models,
          },
        ];
      }
      if (route === '/auth/models') {
        return {
          models: [
            ...(existingDefault ? [{ slug: 'luna', displayName: 'Luna', efforts: ['low'] }] : []),
            ...status.connections.flatMap((connection) =>
              connection.models.map((model) => ({
                slug: `connection:${id}:${model.id}`,
                displayName: model.name,
                efforts: [],
              })),
            ),
          ],
        } as never;
      }
      return original(route, body);
    });
    renderApp();
    await screen.findByRole('heading', { name: overview });
    await openConnections();
    if (!existingDefault) {
      expect(screen.getByRole('heading', { name: 'Connect your first provider' })).toBeTruthy();
      expect(screen.getAllByRole('button', { name: 'Add provider' })).toHaveLength(1);
      expect(screen.queryByRole('heading', { name: 'Default model' })).toBeNull();
    }
    await openProviderPicker();
    await openProvider(name, name);
    await fireEvent.input(screen.getByLabelText('API key'), { target: { value: 'test-api-key' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('/connections/save', {
        id: undefined,
        provider,
        name: undefined,
        apiKey: 'test-api-key',
        baseURL: undefined,
        models: [sonnet, haiku],
      }),
    );
    expect(screen.queryByRole('searchbox', { name: 'Search provider models' })).toBeNull();
    expect(request).not.toHaveBeenCalledWith('/auth/model', expect.anything());
    await fireEvent.click(screen.getByRole('link', { name: 'Back to AI Providers' }));
    await screen.findByRole('link', { name: `Manage ${name}` });
    expect(screen.queryByRole('heading', { name: 'Connect your first provider' })).toBeNull();
    const selector = await screen.findByRole('combobox', { name: 'Default model for new chats' });
    await waitFor(() => expect(selector.textContent).toBe(selection));
    const choices = within(await openSelect(selector));
    expect(choices.getByRole('option', { name: 'Claude Sonnet' })).toBeTruthy();
    expect(choices.getByRole('option', { name: 'Claude Haiku' })).toBeTruthy();
  },
);

test('connecting keeps models the player already chose instead of saving suggestions', async () => {
  const original = vi.mocked(request).getMockImplementation()!;
  vi.mocked(request).mockImplementation(async (route, body) => {
    if (route === '/connections/discover') {
      return {
        models: [{ id: 'claude-suggested', contextWindow: 200000, supportsTools: true }],
      } as never;
    }
    return original(route, body);
  });
  renderApp();
  await screen.findByRole('heading', { name: 'Wisp is ready' });
  await openConnections();
  await openProviderPicker();
  await openProvider('Claude', 'Claude');
  await fireEvent.input(screen.getByLabelText('API key'), { target: { value: 'wrong-key' } });
  await fireEvent.click(screen.getByRole('button', { name: 'Add a model manually' }));
  await fireEvent.input(screen.getByLabelText('Model ID'), { target: { value: 'claude-mine' } });
  await fireEvent.click(screen.getByRole('button', { name: 'Add model' }));
  await screen.findByText('1 model selected for Wisp');
  await fireEvent.click(screen.getByRole('button', { name: 'Back to API key' }));
  await fireEvent.input(screen.getByLabelText('API key'), { target: { value: 'right-key' } });
  await fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
  await screen.findByRole('searchbox', { name: 'Search provider models' });
  expect(request).not.toHaveBeenCalledWith('/connections/save', expect.anything());
  expect(screen.getByText('1 model selected for Wisp')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Add claude-suggested' })).toBeTruthy();
});

test('a catalog too large to add whole lets the player pick models', async () => {
  const model = { id: 'lab/model-0', name: 'Model 0', contextWindow: 128000 };
  const catalog = Array.from({ length: 41 }, (_, index) => ({
    id: `lab/model-${index}`,
    name: `Model ${index}`,
    contextWindow: 128000,
    supportsTools: true,
  }));
  let discoveryCalls = 0;
  const original = vi.mocked(request).getMockImplementation()!;
  vi.mocked(request).mockImplementation(async (route, body) => {
    if (route === '/connections/discover') {
      discoveryCalls += 1;
      return { models: discoveryCalls === 1 ? catalog : catalog.slice(1) } as never;
    }
    return original(route, body);
  });
  renderApp();
  await screen.findByRole('heading', { name: 'Wisp is ready' });
  await openConnections();
  await openProviderPicker();
  await openProvider('OpenRouter', 'OpenRouter');
  await fireEvent.input(screen.getByLabelText('API key'), { target: { value: 'test-api-key' } });
  await fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
  const search = await screen.findByRole('searchbox', { name: 'Search provider models' });
  expect(request).not.toHaveBeenCalledWith('/connections/save', expect.anything());
  const save = screen.getByRole<HTMLButtonElement>('button', { name: 'Save connection' });
  expect(save.disabled).toBe(true);
  expect(screen.getByText('41 models')).toBeTruthy();
  await fireEvent.input(search, { target: { value: 'model 0' } });
  await fireEvent.click(screen.getByRole('button', { name: `Add ${model.id}` }));
  await screen.findByText('1 model selected for Wisp');
  await fireEvent.click(screen.getByRole('button', { name: 'Selected model settings' }));
  await fireEvent.click(screen.getByRole('button', { name: `Test ${model.id}` }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      '/connections/test',
      expect.objectContaining({ models: [model] }),
    ),
  );
  const refresh = screen.getByRole<HTMLButtonElement>('button', { name: 'Refresh models' });
  await waitFor(() => expect(refresh.disabled).toBe(false));
  await fireEvent.click(refresh);
  await screen.findByText('No models match your search.');
  expect(screen.getByText('1 model selected for Wisp')).toBeTruthy();
  await waitFor(() => expect(save.disabled).toBe(false));
  await fireEvent.click(save);
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      '/connections/save',
      expect.objectContaining({ models: [model] }),
    ),
  );
});

test('an API default enables the workspace while ChatGPT stays disconnected', async () => {
  status.auth.status = 'signed_out';
  status.modelConnected = true;
  status.connections = [
    {
      id: '35302f8c-128a-48fb-98a1-9eb03bb71f72',
      provider: 'anthropic',
      name: 'My Claude',
      hasKey: true,
      models: [{ id: 'claude-test', contextWindow: 200000 }],
    },
    {
      id: 'a5f4f84f-e053-410a-955f-b59a22b3a201',
      provider: 'gateway',
      name: 'My Gateway',
      hasKey: false,
      models: [{ id: 'gateway-test', contextWindow: 200000 }],
    },
  ];
  renderApp();
  await screen.findByRole('heading', { name: 'Wisp is ready' });
  await openConnections();
  expect(
    within(screen.getByRole('listitem', { name: 'Claude' })).getByText('Key saved'),
  ).toBeTruthy();
  expect(screen.queryByRole('listitem', { name: 'Gemini' })).toBeNull();
  expect(
    within(screen.getByRole('listitem', { name: 'Vercel AI Gateway' })).getByText(
      'API key missing',
    ),
  ).toBeTruthy();
  expect(
    within(screen.getByRole('listitem', { name: 'ChatGPT' })).getByText('Reconnect needed'),
  ).toBeTruthy();
  await openProvider('Reconnect ChatGPT', 'ChatGPT');
  expect(screen.getByRole('button', { name: 'Continue with ChatGPT' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'OpenAI API' })).toBeTruthy();
  expect(screen.queryByText('My Claude')).toBeNull();
  await fireEvent.click(screen.getByRole('link', { name: 'Back to AI Providers' }));
  await openProvider('Manage Claude', 'Claude');
  expect(screen.getByText('My Claude')).toBeTruthy();
  await fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  expect(
    ((await screen.findByLabelText('API key (leave blank to keep saved key)')) as HTMLInputElement)
      .value,
  ).toBe('');
  expect(screen.queryByRole('combobox', { name: 'Provider' })).toBeNull();
});
test('an event listener that finishes registering after unmount is immediately removed', async () => {
  let finish: ((stop: () => void) => void) | undefined;
  vi.mocked(listen).mockImplementation((event) =>
    event === 'desktop-error'
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Promise.resolve(() => {}),
  );
  renderApp();
  await waitFor(() => expect(finish).toBeDefined());
  cleanup();
  const stop = vi.fn();
  finish!(stop);
  await waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
});

test('routines replace suggestion toggles and expose run history with character-scoped actions', async () => {
  status.routines = [
    {
      id: 'mage-review',
      title: 'Mage review',
      instruction: 'Review current learned spells.',
      characterKey: '["Forever","Realm","Mage"]',
      enabled: true,
      updatedAt: 1000000,
      nextAt: 9999999,
      triggers: [
        {
          kind: 'event',
          event: 'level_up',
          filters: [{ field: 'level', op: 'multiple_of', value: 2 }],
        },
      ],
      cooldownSeconds: 600,
      once: false,
    },
  ];
  status.routineRuns = [
    {
      id: 'run-one',
      routineId: 'mage-review',
      characterKey: status.routines[0].characterKey,
      title: 'Mage review',
      startedAt: 1000000,
      event: 'level_up',
      status: 'done',
    },
  ];
  renderApp();
  await screen.findByRole('heading', { name: 'Wisp is ready' });
  await fireEvent.click(screen.getByRole('link', { name: 'Routines' }));
  expect(screen.queryByRole('button', { name: 'Suggestions' })).toBeNull();
  expect(screen.getByText('Mage review')).toBeTruthy();
  await fireEvent.click(screen.getByText('Run history (1)'));
  expect(screen.getByText(/On level up · level is a multiple of 2/)).toBeTruthy();
  await fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('/routines/action', {
      characterKey: status.routines[0].characterKey,
      id: 'mage-review',
      operation: 'pause',
    }),
  );
  await waitFor(() =>
    expect(
      (
        screen.getByRole('button', {
          name: 'Open in game',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  await fireEvent.click(screen.getByRole('button', { name: 'Open in game' }));
  await waitFor(() => expect(request).toHaveBeenCalledWith('/routines/open', { id: 'run-one' }));
});

test('provider-neutral navigation and per-chat default model controls use the bridge contract', async () => {
  renderApp();
  await screen.findByRole('heading', { name: 'Wisp is ready' });
  await openConnections();
  expect(screen.getByRole('heading', { name: 'AI Providers' })).toBeTruthy();
  await chooseOption(
    await screen.findByRole('combobox', { name: 'Default model for new chats' }),
    'Sol',
  );
  await fireEvent.click(screen.getByRole('button', { name: 'Set default' }));
  await waitFor(() => expect(request).toHaveBeenCalledWith('/auth/model', { model: 'sol' }));
});

test('account selection is a draft until submitted and remains available for reconnect', async () => {
  status.auth.profiles.push({ id: 'second', label: 'Second account', connected: true });
  const original = vi.mocked(request).getMockImplementation()!;
  vi.mocked(request).mockImplementation(async (route, body) => {
    if (route === '/auth/select') {
      status = { ...status, auth: { ...status.auth, activeId: 'second' } };
    }
    return original(route, body);
  });
  renderApp();
  await screen.findByRole('heading', { name: 'Wisp is ready' });
  await openConnections();
  await openProvider('Manage ChatGPT', 'ChatGPT');
  expect(screen.getByRole('button', { name: 'Add account' })).toBeTruthy();

  const accounts = screen.getByRole('combobox', { name: 'Saved accounts' });
  expect(accounts.textContent).toBe('First account');
  await chooseOption(accounts, 'Second account');
  expect(request).not.toHaveBeenCalledWith('/auth/select', expect.anything());

  fireEvent.click(screen.getByRole('button', { name: 'Use account' }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('/auth/select', { profileId: 'second' }),
  );
  const reconnect = screen.getByRole<HTMLButtonElement>('button', { name: 'Reconnect' });
  await waitFor(() => expect(reconnect.disabled).toBe(false));
  fireEvent.click(reconnect);
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('/auth/start', {
      profileId: 'second',
      newAccount: false,
    }),
  );
});

test('the app preserves router history through StrictMode effect cleanup', async () => {
  const router = renderApp(true);
  await screen.findByRole('heading', { name: 'Wisp is ready' });
  await openConnections();

  await act(async () => {
    await router.navigate(-1);
  });

  expect(screen.getByRole('heading', { name: 'Wisp is ready' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Overview' }).getAttribute('aria-current')).toBe('page');
});

test('an active reply disables operations that would interrupt the bridge', async () => {
  status.activeTurns = 1;
  renderApp();
  await fireEvent.click(await screen.findByRole('link', { name: 'Settings' }));
  await screen.findByText('Working…');
  expect(screen.queryByRole('button', { name: 'Stop Wisp' })).toBeNull();
  await fireEvent.click(screen.getByRole('button', { name: 'Manage installation' }));
  expect(
    (
      screen.getByRole('button', {
        name: 'Install / update addon',
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});

test('MCP add dialog preserves structured arguments and saves without browser credentials', async () => {
  status.mcps = [
    {
      name: 'existing_tools',
      transport: 'sse',
      url: 'https://example.com/sse',
      enabled: true,
      args: [],
      hasToken: true,
    },
  ];
  status.integrations = [
    {
      id: 'mcp:existing_tools',
      name: 'Existing tools',
      group: 'integrations',
      kind: 'mcp',
      description: 'An existing connection',
      enabled: true,
      effective: true,
      available: true,
      status: 'ready',
    },
  ];
  renderApp();
  await screen.findByRole('heading', { name: 'Wisp is ready' });
  await fireEvent.click(screen.getByRole('link', { name: 'Integrations' }));
  const add = await screen.findByRole('button', { name: 'Add MCP' });
  add.focus();
  await fireEvent.click(add);
  const dialog = await screen.findByRole('dialog', { name: 'Add an MCP' });
  const fields = within(dialog);
  const name = fields.getByLabelText('Name');
  await waitFor(() => expect(document.activeElement).toBe(name));
  await fireEvent.input(name, {
    target: { value: 'my_tools' },
  });
  const endpoint = fields.getByLabelText('Endpoint URL');
  await fireEvent.input(endpoint, {
    target: { value: 'https://example.com/mcp' },
  });
  let finishSave!: () => void;
  const beforeSave = vi.mocked(request).getMockImplementation()!;
  vi.mocked(request).mockImplementation(async (route, body) => {
    if (route === '/mcps/save') {
      await new Promise<void>((resolve) => {
        finishSave = resolve;
      });
    }
    return beforeSave(route, body);
  });
  fireEvent.submit((name as HTMLInputElement).form!);
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('/mcps/save', {
      server: {
        name: 'my_tools',
        description: '',
        transport: 'http',
        enabled: true,
        args: [],
        url: 'https://example.com/mcp',
      },
    }),
  );
  expect(endpoint.matches(':disabled')).toBe(true);
  expect(fields.getByLabelText('Description').matches(':disabled')).toBe(true);
  expect(fields.getByRole('checkbox', { name: 'Enable connection' }).matches(':disabled')).toBe(
    true,
  );
  expect(
    screen.getByRole('dialog', {
      name: 'Add an MCP',
      description: 'Test the connection before saving. Local commands run on your computer.',
    }),
  ).toBe(dialog);
  await fireEvent.keyDown(dialog, { key: 'Escape' });
  expect(screen.getByRole('dialog')).toBe(dialog);
  await act(async () => {
    finishSave();
  });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(add));

  await fireEvent.click(add);
  const localDialog = await screen.findByRole('dialog', { name: 'Add an MCP' });
  const local = within(localDialog);
  expect((local.getByLabelText('Name') as HTMLInputElement).value).toBe('');
  await chooseOption(local.getByRole('combobox', { name: 'Transport' }), 'Local process (stdio)');
  await fireEvent.input(local.getByLabelText('Name'), { target: { value: 'local_tools' } });
  const command = local.getByLabelText('Executable or command');
  await fireEvent.input(command, { target: { value: 'fixture-mcp' } });
  const args = local.getByLabelText(/Arguments/);
  const testConnection = local.getByRole('button', { name: 'Test connection' });
  await fireEvent.input(args, { target: { value: '[1]' } });
  await fireEvent.click(testConnection);
  await local.findByText('Arguments must be a JSON array of strings.');
  expect(args.getAttribute('aria-invalid')).toBe('true');
  await waitFor(() => expect(document.activeElement).toBe(args));
  expect(request).not.toHaveBeenCalledWith('/mcps/test', expect.anything());
  await fireEvent.input(args, { target: { value: '["--flag","two words"]' } });
  const environment = local.getByLabelText(/Environment/);
  await fireEvent.input(environment, { target: { value: '{invalid' } });
  await fireEvent.click(testConnection);
  await local.findByText('Environment must be a JSON object with string values.');
  await waitFor(() => expect(document.activeElement).toBe(environment));
  expect(request).not.toHaveBeenCalledWith('/mcps/test', expect.anything());
  await fireEvent.input(environment, { target: { value: '{"FIXTURE":"test"}' } });
  let finish!: () => void;
  const original = vi.mocked(request).getMockImplementation()!;
  vi.mocked(request).mockImplementation(async (route, body) => {
    if (route === '/mcps/test') {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    }
    return original(route, body);
  });
  await fireEvent.click(testConnection);
  await local.findByText('Testing connection…');
  await fireEvent.keyDown(command, { key: 'Escape' });
  expect(screen.getByRole('dialog')).toBe(localDialog);
  finish();
  await local.findByText('Connected. 3 tools available.');
  expect(request).toHaveBeenCalledWith('/mcps/test', {
    server: {
      name: 'local_tools',
      description: '',
      transport: 'stdio',
      enabled: true,
      args: ['--flag', 'two words'],
      command: 'fixture-mcp',
    },
    env: { FIXTURE: 'test' },
  });
  await fireEvent.keyDown(command, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(add));

  await fireEvent.click(screen.getByRole('link', { name: 'Manage Existing tools' }));
  await screen.findByRole('heading', { name: 'Existing tools', level: 1 });
  await fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  const edit = within(await screen.findByRole('dialog', { name: 'Edit connection' }));
  const savedName = edit.getByLabelText('Name') as HTMLInputElement;
  expect(savedName.value).toBe('existing_tools');
  expect(savedName.disabled).toBe(true);
  expect(edit.getByRole('combobox', { name: 'Transport' }).textContent).toBe('SSE');
  expect((edit.getByLabelText('Endpoint URL') as HTMLInputElement).value).toBe(
    'https://example.com/sse',
  );
  expect((edit.getByLabelText(/Bearer token/) as HTMLInputElement).value).toBe('');
  expect(edit.getByText('A token is securely stored.')).toBeTruthy();
});

test('MCP transport changes do not leave hidden local validation errors blocking HTTP saves', async () => {
  renderApp();
  await screen.findByRole('heading', { name: 'Wisp is ready' });
  await fireEvent.click(screen.getByRole('link', { name: 'Integrations' }));
  await fireEvent.click(await screen.findByRole('button', { name: 'Add MCP' }));
  const dialog = within(await screen.findByRole('dialog', { name: 'Add an MCP' }));
  fireEvent.input(dialog.getByLabelText('Name'), { target: { value: 'local_tools' } });
  const transport = dialog.getByRole('combobox', { name: 'Transport' });
  await chooseOption(transport, 'Local process (stdio)');
  fireEvent.input(dialog.getByLabelText('Executable or command'), {
    target: { value: 'fixture-mcp' },
  });
  fireEvent.input(dialog.getByLabelText(/Arguments/), { target: { value: '[' } });
  fireEvent.click(dialog.getByRole('button', { name: 'Test connection' }));
  await dialog.findByText('Arguments must be a JSON array of strings.');

  await chooseOption(transport, 'Streamable HTTP');
  fireEvent.input(dialog.getByLabelText('Endpoint URL'), {
    target: { value: 'https://example.com/mcp' },
  });
  fireEvent.click(dialog.getByRole('button', { name: 'Save connection' }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('/mcps/save', {
      server: {
        name: 'local_tools',
        description: '',
        transport: 'http',
        enabled: true,
        args: [],
        url: 'https://example.com/mcp',
      },
    }),
  );
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

test('sign-in URL is handed to the native allowlisted opener', async () => {
  status.auth.status = 'signed_out';
  status.auth.activeId = undefined;
  status.auth.profiles = [];
  renderApp();
  await screen.findByText('Connect your AI account');
  await openConnections();
  await openProviderPicker();
  await openProvider('ChatGPT', 'ChatGPT');
  expect(screen.queryByRole('button', { name: 'Add account' })).toBeNull();
  await fireEvent.click(screen.getByRole('button', { name: 'Continue with ChatGPT' }));
  await waitFor(() =>
    expect(desktop).toHaveBeenCalledWith('open_sign_in', {
      url: 'https://auth.openai.com/authorize?test=1',
    }),
  );
});

test('integration cards expose availability, master and child switches through the bridge', async () => {
  status.integrations = [
    {
      id: 'integration:questie',
      name: 'Questie',
      group: 'integrations',
      kind: 'addon',
      description: 'Forever locations',
      enabled: true,
      effective: true,
      available: true,
      status: 'partial',
      version: '4',
      reason: 'Some service indexes are unavailable.',
    },
    {
      id: 'tool:find_npc_locations',
      parent: 'integration:questie',
      name: 'Find NPC locations',
      toolName: 'questie__find_npc_locations',
      group: 'integrations',
      description: 'Read spawn coordinates',
      enabled: true,
      effective: true,
      available: true,
      status: 'partial',
    },
  ];
  renderApp();
  await screen.findByRole('heading', { name: 'Wisp is ready' });
  await fireEvent.click(screen.getByRole('link', { name: 'Integrations' }));
  expect(await screen.findByText('Partial')).toBeTruthy();
  expect(screen.queryByRole('switch', { name: 'Enable Questie' })).toBeNull();
  await fireEvent.click(screen.getByRole('link', { name: 'Manage Questie' }));
  expect(await screen.findByRole('heading', { name: 'Questie', level: 1 })).toBe(
    document.activeElement,
  );
  expect(screen.getByText('Some service indexes are unavailable.')).toBeTruthy();
  await fireEvent.click(screen.getByText('Tools & capabilities (1)'));
  await fireEvent.click(screen.getByLabelText('Questie: Find NPC locations'));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('/integrations/set', {
      id: 'tool:find_npc_locations',
      enabled: false,
    }),
  );
  await waitFor(() =>
    expect(
      (screen.getByRole('switch', { name: 'Enable Questie' }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  await fireEvent.click(screen.getByRole('switch', { name: 'Enable Questie' }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('/integrations/set', {
      id: 'integration:questie',
      enabled: false,
    }),
  );
});

test('built-in capabilities stay out of integrations and memory has separate controls', async () => {
  const { defaultCapabilities } = await import('@wisp/protocol/capabilities');
  status.integrations = defaultCapabilities().map((entry) => ({
    ...entry,
    enabled: true,
    effective: true,
    available: true,
    status: 'ready',
  }));
  renderApp();
  await screen.findByRole('heading', { name: 'Wisp is ready' });
  await fireEvent.click(screen.getByRole('link', { name: 'Integrations' }));
  expect(await screen.findByRole('link', { name: 'Manage Questie' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Manage Everloot' })).toBeTruthy();
  expect(screen.queryByRole('link', { name: 'Manage World of Warcraft' })).toBeNull();
  expect(screen.queryByRole('link', { name: 'Manage Wisp' })).toBeNull();
  expect(screen.getByRole('heading', { name: 'Add a server' })).toBeTruthy();
  expect(screen.queryByText('Conversation titles')).toBeNull();
  expect(screen.queryByText('Player preferences')).toBeNull();
  await fireEvent.click(screen.getByRole('link', { name: 'Memory' }));
  await fireEvent.click(screen.getByRole('switch', { name: 'Enable Player preferences' }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('/integrations/set', {
      id: 'memory:preferences',
      enabled: false,
    }),
  );
});

test('integration categories preserve a search when returning from addon setup', async () => {
  const { defaultCapabilities } = await import('@wisp/protocol/capabilities');
  status.integrations = defaultCapabilities().map((entry) => {
    const missing = entry.id === 'integration:questie';
    return {
      ...entry,
      enabled: true,
      effective: !missing,
      available: !missing,
      status: missing ? 'missing' : 'ready',
    };
  });
  renderApp();
  await screen.findByRole('heading', { name: 'Wisp is ready' });
  await fireEvent.click(screen.getByRole('link', { name: 'Integrations' }));
  const databases = screen.getByRole('region', { name: 'Game databases' });
  expect(within(databases).getByRole('link', { name: 'Manage TheWoWDB' })).toBeTruthy();
  expect(within(databases).getByRole('link', { name: 'Manage Everloot' })).toBeTruthy();

  await fireEvent.click(screen.getByRole('button', { name: 'Quests & navigation' }));
  expect(screen.queryByRole('link', { name: 'Manage TheWoWDB' })).toBeNull();
  await fireEvent.input(screen.getByRole('searchbox', { name: 'Search integrations' }), {
    target: { value: 'questie' },
  });
  await fireEvent.click(screen.getByRole('link', { name: 'Setup instructions Questie' }));
  expect(await screen.findByText('Install or update QuestieDB for WoW Forever.')).toBeTruthy();
  await fireEvent.click(screen.getByRole('link', { name: 'Back to Integrations' }));
  expect(screen.getByRole('button', { name: 'Quests & navigation', pressed: true })).toBeTruthy();
  expect(screen.getByDisplayValue('questie')).toBeTruthy();
});

test('a configured installation stays compact until explicitly opened', async () => {
  renderApp();
  await screen.findByRole('heading', { name: 'Wisp is ready' });
  await fireEvent.click(screen.getByRole('link', { name: 'Settings' }));
  expect(screen.queryByLabelText('WoW client folder')).toBeNull();
  await fireEvent.click(screen.getByRole('button', { name: 'Manage installation' }));
  expect((screen.getByLabelText('WoW client folder') as HTMLInputElement).value).toBe('E:\\WoW');
  await fireEvent.click(screen.getByRole('button', { name: 'Done' }));
  expect(screen.queryByLabelText('WoW client folder')).toBeNull();
});

test('the next action follows the missing connection', async () => {
  status.auth.status = 'signed_out';
  renderApp();
  await fireEvent.click(await screen.findByRole('button', { name: 'Connect AI' }));
  expect(await screen.findByRole('link', { name: 'Reconnect ChatGPT' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'AI Providers' }).getAttribute('aria-current')).toBe(
    'page',
  );
  cleanup();
  status.auth.status = 'connected';
  status.gameConnected = false;
  renderApp();
  await screen.findByRole('heading', { name: 'Wisp is ready' });
  expect(screen.queryByRole('button', { name: 'Connect AI' })).toBeNull();
  await fireEvent.click(screen.getByRole('link', { name: 'Settings' }));
  await fireEvent.click(screen.getByRole('button', { name: 'Manage installation' }));
  expect(screen.getByLabelText('WoW client folder')).toBeTruthy();
});

test('sidebar status follows the game connection across pages and links back to Overview', async () => {
  status.gameConnected = false;
  renderApp();
  await screen.findByRole('heading', { name: 'Wisp is ready' });
  await openConnections();
  expect(screen.getByRole('link', { name: 'Ready · waiting for WoW' })).toBeTruthy();

  status = { ...status, gameConnected: true };
  await act(() => desktopStore.getState().actions.refresh());
  await fireEvent.click(screen.getByRole('link', { name: 'Wisp is ready' }));
  expect(await screen.findByRole('heading', { name: 'Wisp is ready' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Overview', current: 'page' })).toBeTruthy();
});

test('unreachable data pages do not report empty collections', async () => {
  const original = vi.mocked(request).getMockImplementation()!;
  vi.mocked(request).mockImplementation((route, body) =>
    route === '/status' ? Promise.reject(new Error('Service unreachable')) : original(route, body),
  );
  const nativeCall = vi.mocked(desktop).getMockImplementation()!;
  vi.mocked(desktop).mockImplementation((command, args) =>
    command === 'start_bridge'
      ? Promise.reject(new Error('Could not start Wisp'))
      : nativeCall(command, args),
  );
  renderApp();
  await screen.findByRole('heading', { name: 'Wisp is unavailable' });
  expect(screen.queryByRole('button', { name: 'Start Wisp' })).toBeNull();
  for (const page of ['Memory', 'Panels', 'Routines', 'Integrations', 'AI Providers']) {
    await fireEvent.click(screen.getByRole('link', { name: page }));
    expect(await screen.findByText('Your workspace is unavailable')).toBeTruthy();
    expect(screen.queryByText('No panels yet.')).toBeNull();
    expect(screen.queryByText('No routines yet')).toBeNull();
    expect(screen.getByRole('button', { name: 'Go to Overview' })).toBeTruthy();
  }
});

test('data pages show loading while the first status request is pending', async () => {
  let finish!: (value: Status) => void;
  vi.mocked(request).mockImplementation(async (route) =>
    route === '/status'
      ? (new Promise<Status>((resolve) => {
          finish = resolve;
        }) as never)
      : ({ models: [] } as never),
  );
  renderApp();
  await fireEvent.click(await screen.findByRole('link', { name: 'Panels' }));
  expect(screen.getByText('Loading your workspace…')).toBeTruthy();
  await waitFor(() => expect(finish).toBeDefined());
  finish(status);
  await screen.findByText('No panels yet.');
});

test('starts Wisp automatically and lets you manage providers with WoW setup deferred', async () => {
  mockUnconfiguredDetection(Promise.resolve([]));
  status.ready = false;
  status.gameConnected = false;
  renderApp(true);

  await startSetup();
  await fireEvent.click(await screen.findByRole('button', { name: 'Set up WoW later' }));
  await screen.findByRole('heading', { name: 'Set up World of Warcraft' });
  expect(
    vi.mocked(desktop).mock.calls.filter(([command]) => command === 'telemetry_onboarding'),
  ).toEqual([
    ['telemetry_onboarding', { event: { kind: 'opened', step: 'addon' } }],
    ['telemetry_onboarding', { event: { kind: 'step_viewed', step: 'addon' } }],
    ['telemetry_onboarding', { event: { kind: 'skipped', step: 'addon' } }],
  ]);
  expect(desktop).toHaveBeenCalledWith('start_bridge');
  await openConnections();
  expect(screen.getByRole('button', { name: 'Add provider' })).toBeTruthy();

  cleanup();
  renderApp();
  await screen.findByRole('heading', { name: 'Set up World of Warcraft' });
  expect(screen.queryByRole('button', { name: 'Set up WoW later' })).toBeNull();
});

test('first-time setup resumes at the provider step and opens Overview after saving a model', async () => {
  const original = vi.mocked(desktop).getMockImplementation()!;
  let installed = false;
  status.ready = false;
  status.gameConnected = false;
  status.auth = { status: 'signed_out', profiles: [], revision: 1 };
  status.model = '';
  status.modelConnected = false;
  vi.mocked(desktop).mockImplementation(async (command, args) => {
    if (command === 'desktop_info') {
      return {
        configured: installed,
        wow: installed ? 'D:\\WoW' : '',
        version: '0.0.1',
        platform: 'windows',
        dataDirectory: 'userdata',
      } as never;
    }
    if (command === 'install_addon') {
      installed = true;
    }
    if (command === 'pick_folder') {
      return 'D:\\WoW' as never;
    }
    return original(command, args);
  });
  const originalRequest = vi.mocked(request).getMockImplementation()!;
  vi.mocked(request).mockImplementation(async (route, body) => {
    if (route === '/auth/models' && status.auth.status === 'signed_out') {
      return { models: [] } as never;
    }
    if (route === '/auth/model') {
      status.model = (body as { model: string }).model;
      status.modelConnected = true;
    }
    return originalRequest(route, body);
  });
  renderApp();
  await screen.findByRole('heading', { name: 'Welcome to Wisp' });
  await startSetup();
  expect(screen.queryByRole('navigation', { name: 'Main navigation' })).toBeNull();
  await fireEvent.click(await screen.findByRole('button', { name: 'Choose folder' }));
  const install = (await screen.findByRole('button', {
    name: 'Install addon',
  })) as HTMLButtonElement;
  await waitFor(() => expect(install.disabled).toBe(false));
  await fireEvent.click(install);
  await waitFor(() => expect(desktop).toHaveBeenCalledWith('install_addon', { wow: 'D:\\WoW' }));
  await screen.findByRole('heading', { name: 'Connect AI' });
  expect(await screen.findByRole('heading', { name: 'Choose your provider' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'ChatGPT' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Start Wisp' })).toBeNull();
  expect(
    vi.mocked(desktop).mock.calls.filter(([command]) => command === 'start_bridge'),
  ).toHaveLength(1);
  expect(
    vi.mocked(desktop).mock.calls.filter(([command]) => command === 'telemetry_onboarding'),
  ).toEqual([
    ['telemetry_onboarding', { event: { kind: 'opened', step: 'addon' } }],
    ['telemetry_onboarding', { event: { kind: 'step_viewed', step: 'addon' } }],
    ['telemetry_onboarding', { event: { kind: 'step_viewed', step: 'ai_provider' } }],
  ]);

  cleanup();
  renderApp();
  await fireEvent.click(await screen.findByRole('button', { name: 'ChatGPT' }));
  expect(desktop).toHaveBeenCalledWith('telemetry_onboarding', {
    event: { kind: 'opened', step: 'ai_provider' },
  });
  expect(desktop).toHaveBeenCalledWith('telemetry_onboarding', {
    event: { kind: 'provider_selected', provider: 'openai' },
  });
  await screen.findByRole('heading', { level: 2, name: 'ChatGPT' });
  expect(screen.getByRole('heading', { level: 1, name: 'Connect AI' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Subscription' })).toBeTruthy();
  await fireEvent.click(screen.getByRole('button', { name: 'Use API key' }));
  expect(screen.getByLabelText('API key')).toBeTruthy();
  await fireEvent.click(screen.getByRole('button', { name: 'Back to ChatGPT' }));
  await fireEvent.click(screen.getByRole('button', { name: 'Continue with ChatGPT' }));
  await waitFor(() => expect(desktop).toHaveBeenCalledWith('open_sign_in', expect.anything()));
  expect(screen.queryByRole('navigation', { name: 'Main navigation' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Add account' })).toBeNull();
  expect(screen.queryByRole('heading', { name: 'Default model' })).toBeNull();

  status.auth = { ...status.auth, status: 'authorizing', revision: status.auth.revision + 1 };
  await act(() => desktopStore.getState().actions.refresh());
  await screen.findByRole('button', { name: 'Cancel sign-in' });
  status.auth = {
    ...status.auth,
    status: 'plan_permission_required',
    revision: status.auth.revision + 1,
  };
  await act(() => desktopStore.getState().actions.refresh());
  await waitFor(() =>
    expect(desktop).toHaveBeenCalledWith('telemetry_onboarding', {
      event: {
        kind: 'provider_connect_finished',
        provider: 'openai',
        method: 'subscription',
        outcome: 'failed',
        error_code: 'plan_permission_required',
      },
    }),
  );
  await fireEvent.click(screen.getByRole('button', { name: 'Continue with ChatGPT' }));
  await waitFor(() =>
    expect(
      vi.mocked(desktop).mock.calls.filter(([command]) => command === 'open_sign_in'),
    ).toHaveLength(2),
  );

  // The browser sign-in still finishes after the user leaves the ChatGPT panel.
  await fireEvent.click(screen.getByRole('button', { name: 'Back to providers' }));
  await screen.findByRole('heading', { name: 'Choose your provider' });
  status.auth = { ...status.auth, status: 'connected', revision: status.auth.revision + 1 };
  await act(() => desktopStore.getState().actions.refresh());
  const subscriptionResults = () =>
    vi
      .mocked(desktop)
      .mock.calls.filter(
        ([command, body]) =>
          command === 'telemetry_onboarding' &&
          (body as { event: { kind: string; outcome?: string } }).event.kind ===
            'provider_connect_finished' &&
          (body as { event: { outcome?: string } }).event.outcome === 'completed',
      );
  await waitFor(() => expect(subscriptionResults()).toHaveLength(1));
  expect(subscriptionResults()[0]).toEqual([
    'telemetry_onboarding',
    {
      event: {
        kind: 'provider_connect_finished',
        provider: 'openai',
        method: 'subscription',
        outcome: 'completed',
      },
    },
  ]);
  await fireEvent.click(screen.getByRole('button', { name: 'ChatGPT' }));
  await fireEvent.click(await screen.findByRole('button', { name: 'Use subscription' }));
  expect(await screen.findByRole('heading', { name: 'ChatGPT added' })).toBeTruthy();
  expect(subscriptionResults()).toHaveLength(1);
  expect(screen.getByRole('combobox', { name: 'Default model for new chats' }).textContent).toBe(
    'Choose a model',
  );
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Finish setup' }).disabled).toBe(
    true,
  );
  await chooseOption(screen.getByRole('combobox', { name: 'Default model for new chats' }), 'Sol');
  await fireEvent.click(screen.getByRole('button', { name: 'Finish setup' }));
  await screen.findByRole('heading', { name: 'You’re ready' });
  await fireEvent.click(screen.getByRole('button', { name: 'Open Wisp' }));
  await screen.findByRole('heading', { name: 'Waiting for the agent' });
  status.ready = true;
  status.gameConnected = true;
  await act(() => desktopStore.getState().actions.refresh());
  await screen.findByRole('heading', { name: 'Wisp is ready' });
  expect(request).toHaveBeenCalledWith('/auth/model', { model: 'sol' });
  expect(desktop).toHaveBeenCalledWith('telemetry_onboarding', {
    event: { kind: 'completed' },
  });
  expect(screen.getByText('Sol')).toBeTruthy();
  expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBeTruthy();

  cleanup();
  status.modelConnected = false;
  status.auth.status = 'signed_out';
  renderApp();
  await screen.findByRole('heading', { name: 'Connect your AI account' });
  expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBeTruthy();
});

test('onboarding searches the provider catalog and suggests a single saved model', async () => {
  localStorage.setItem('wisp:onboarding:v1', 'pending');
  status.auth = { status: 'signed_out', profiles: [], revision: 1 };
  status.model = '';
  status.modelConnected = false;
  const id = '35302f8c-128a-48fb-98a1-9eb03bb71f72';
  const model = { id: 'anthropic/claude-sonnet', name: 'Claude Sonnet', contextWindow: 200000 };
  const slug = `connection:${id}:${model.id}`;
  const original = vi.mocked(request).getMockImplementation()!;
  let discoveries = 0;
  vi.mocked(request).mockImplementation(async (route, body) => {
    if (route === '/connections/discover') {
      if (discoveries++ === 0) throw new Error('401 Unauthorized: PRIVATE provider message');
      return { models: [{ ...model, supportsTools: true }] } as never;
    }
    if (route === '/connections/save') {
      status.connections = [
        { id, name: 'OpenRouter', provider: 'openrouter', hasKey: true, models: [model] },
      ];
      return { id } as never;
    }
    if (route === '/auth/models') {
      return {
        models: status.connections.length
          ? [
              { slug, displayName: `OpenRouter / ${model.name}`, efforts: [] },
              { slug: 'luna', displayName: 'Luna', efforts: [] },
            ]
          : [],
      } as never;
    }
    if (route === '/auth/model') {
      status.model = (body as { model: string }).model;
      status.modelConnected = true;
    }
    return original(route, body);
  });
  renderApp();
  await fireEvent.click(await screen.findByRole('button', { name: 'Gemini' }));
  await screen.findByRole('heading', { level: 2, name: 'Gemini' });
  await fireEvent.click(screen.getByRole('button', { name: 'Back to providers' }));
  await fireEvent.click(screen.getByRole('button', { name: 'Browse providers' }));
  const catalog = within(await screen.findByRole('dialog', { name: 'Browse providers' }));
  await fireEvent.input(catalog.getByRole('searchbox', { name: 'Search providers' }), {
    target: { value: 'openrouter' },
  });
  expect(catalog.queryByRole('button', { name: 'Vercel AI Gateway' })).toBeNull();
  await fireEvent.click(catalog.getByRole('button', { name: 'OpenRouter' }));
  await screen.findByRole('heading', { level: 2, name: 'OpenRouter' });
  expect(screen.getByRole('heading', { level: 1, name: 'Connect AI' })).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'API connections' })).toBeNull();
  expect(screen.getByRole('link', { name: /Get API key/ }).getAttribute('href')).toBe(
    'https://openrouter.ai/settings/keys',
  );
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByRole('navigation', { name: 'Main navigation' })).toBeNull();
  expect(screen.queryByRole('heading', { name: 'Default model' })).toBeNull();
  await fireEvent.input(screen.getByLabelText('API key'), { target: { value: 'fixture-only' } });
  await fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
  await waitFor(() =>
    expect(desktop).toHaveBeenCalledWith('telemetry_onboarding', {
      event: {
        kind: 'provider_connect_finished',
        provider: 'openrouter',
        method: 'api_key',
        outcome: 'failed',
        error_code: 'model_discovery_failed',
      },
    }),
  );
  expect(screen.getByLabelText<HTMLInputElement>('API key').value).toBe('fixture-only');
  await fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
  expect(await screen.findByRole('heading', { name: 'OpenRouter added' })).toBeTruthy();
  expect(request).toHaveBeenCalledWith(
    '/connections/save',
    expect.objectContaining({ models: [model] }),
  );
  expect(
    vi
      .mocked(desktop)
      .mock.calls.filter(
        ([command, body]) =>
          command === 'telemetry_onboarding' &&
          (body as { event: { kind: string } }).event.kind.startsWith('provider_'),
      )
      .map(([, body]) => (body as { event: unknown }).event),
  ).toEqual([
    { kind: 'provider_selected', provider: 'google' },
    { kind: 'provider_selected', provider: 'openrouter' },
    {
      kind: 'provider_connect_finished',
      provider: 'openrouter',
      method: 'api_key',
      outcome: 'failed',
      error_code: 'model_discovery_failed',
    },
    {
      kind: 'provider_connect_finished',
      provider: 'openrouter',
      method: 'api_key',
      outcome: 'completed',
    },
  ]);
  expect(await screen.findByText(model.name)).toBeTruthy();
  expect(screen.queryByRole('combobox', { name: 'Default model for new chats' })).toBeNull();
  expect(request).not.toHaveBeenCalledWith('/auth/model', expect.anything());
  await fireEvent.click(screen.getByRole('button', { name: 'Finish setup' }));
  await fireEvent.click(await screen.findByRole('button', { name: 'Open Wisp' }));
  await screen.findByRole('heading', { name: 'Wisp is ready' });
  expect(request).toHaveBeenCalledWith('/auth/model', { model: slug });
  await openConnections();
  expect(screen.getByRole('link', { name: 'Manage OpenRouter' })).toBeTruthy();
});

test('Connect later leaves provider setup accessible from Overview', async () => {
  localStorage.setItem('wisp:onboarding:v1', 'pending');
  status.auth = { status: 'signed_out', profiles: [], revision: 1 };
  status.model = '';
  renderApp();
  await fireEvent.click(await screen.findByRole('button', { name: 'Claude' }));
  await screen.findByRole('heading', { level: 2, name: 'Claude' });
  await fireEvent.click(screen.getByRole('button', { name: 'Connect later' }));
  await screen.findByRole('heading', { name: 'Connect your AI account' });
  await openConnections();
  expect(screen.getByRole('heading', { name: 'Connect your first provider' })).toBeTruthy();
});

test('an outdated addon becomes the next action even with healthy connections', async () => {
  const original = vi.mocked(desktop).getMockImplementation()!;
  vi.mocked(desktop).mockImplementation(async (command, args) => {
    const result = await original(command, args);
    return command === 'desktop_info'
      ? ({ ...(result as object), addonOutdated: true } as never)
      : result;
  });
  renderApp();
  await screen.findByText('Update your Wisp addon');
  expect(screen.getByRole('link', { name: 'Addon update needed' })).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Wisp is ready' })).toBeNull();
  expect((screen.getByRole('button', { name: 'Update addon' }) as HTMLButtonElement).disabled).toBe(
    false,
  );
  expect(screen.getByText('Update the addon, then type /reload in WoW.')).toBeTruthy();
});
