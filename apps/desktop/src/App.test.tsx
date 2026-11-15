import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';

import App, { createDesktopRouter } from './App';
import { desktopStore } from './desktop-controller';
import { desktop, request, type Status } from './api';
import { listen } from '@tauri-apps/api/event';
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks';
import { chooseOption, openSelect } from './select-test-helpers';
vi.mock('./api', () => ({ native: true, desktop: vi.fn(), request: vi.fn() }));
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
afterEach(() => {
  cleanup();
  for (const router of routers.splice(0)) router.dispose();
  clearMocks();
});

async function openConnections() {
  await fireEvent.click(screen.getByRole('link', { name: 'Connections' }));
  await screen.findByRole('heading', { name: 'Default model' });
}

async function openSearchSettings() {
  await fireEvent.click(screen.getByRole('link', { name: 'Integrations' }));
  await fireEvent.click(await screen.findByRole('button', { name: 'Configure web search' }));
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
  vi.useFakeTimers();
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

test('Connections links to collapsed web search settings in Integrations without exposing saved keys', async () => {
  status.search = { provider: 'auto', hasExaKey: true };
  renderApp();
  await screen.findByRole('heading', { name: 'Wisp is ready' });
  await openConnections();
  expect(
    screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent),
  ).toEqual(['ChatGPT', 'API connections', 'Default model']);
  await fireEvent.click(screen.getByRole('link', { name: 'Configure web search in Integrations' }));
  await screen.findByRole('heading', { name: 'Integrations' });
  const configure = screen.getByRole('button', { name: 'Configure web search' });
  expect(configure.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByRole('combobox', { name: 'Search service' })).toBeNull();
  await fireEvent.click(configure);
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
test('API connections expose the provider registry and save a model with protected-key input', async () => {
  renderApp();
  await screen.findByRole('heading', { name: 'Wisp is ready' });
  await openConnections();
  await fireEvent.click(screen.getByRole('button', { name: 'Add connection' }));
  const provider = await screen.findByRole('combobox', { name: 'Provider' });
  const providers = within(await openSelect(provider));
  expect(providers.getAllByRole('option')).toHaveLength(20);
  expect(providers.getByRole('option', { name: 'Google / Gemini' })).toBeTruthy();
  expect(providers.getByRole('option', { name: 'OpenRouter' })).toBeTruthy();
  expect(providers.queryByRole('option', { name: /Bedrock/ })).toBeNull();
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  await fireEvent.input(screen.getByLabelText('Connection name'), {
    target: { value: 'My Claude' },
  });
  const key = screen.getByLabelText('API key');
  expect(key.getAttribute('type')).toBe('password');
  await fireEvent.input(key, { target: { value: 'test-api-key' } });
  const draftModel = screen.getByLabelText('Models available in Wisp');
  const addModel = screen.getByRole('button', { name: 'Add model' });
  await fireEvent.input(draftModel, { target: { value: 'discarded-model' } });
  await fireEvent.click(addModel);
  await fireEvent.input(screen.getByLabelText('Models available in Wisp'), {
    target: { value: 'claude-test' },
  });
  await fireEvent.input(screen.getByLabelText('Context window in tokens'), {
    target: { value: '200000' },
  });
  await fireEvent.click(addModel);
  await fireEvent.click(await screen.findByRole('button', { name: 'Remove discarded-model' }));
  const contextWindow = (await screen.findByLabelText(
    'Context window for claude-test',
  )) as HTMLInputElement;
  expect(contextWindow.value).toBe('200000');
  const save = screen.getByRole('button', { name: 'Save connection' }) as HTMLButtonElement;
  await fireEvent.input(contextWindow, { target: { value: '' } });
  expect(save.disabled).toBe(true);
  expect(screen.getByText('Enter a context window for this model.')).toBeTruthy();
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
      name: 'My Claude',
      apiKey: 'test-api-key',
      baseURL: undefined,
      models: [{ id: 'claude-test', contextWindow: 200000 }],
    }),
  );
  await waitFor(() => expect(screen.queryByLabelText('API key')).toBeNull());
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
  ];
  renderApp();
  await screen.findByRole('heading', { name: 'Wisp is ready' });
  await openConnections();
  expect(screen.getByRole('button', { name: 'Continue with ChatGPT' })).toBeTruthy();
  expect(screen.getByText('My Claude')).toBeTruthy();
  await fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  expect(
    ((await screen.findByLabelText('API key (leave blank to keep saved key)')) as HTMLInputElement)
      .value,
  ).toBe('');
  expect(screen.getByRole<HTMLButtonElement>('combobox', { name: 'Provider' }).disabled).toBe(true);
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
  expect(screen.getByRole('button', { name: 'Add account' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'AI connections' })).toBeTruthy();
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
  await screen.findByText('Working…');
  expect((screen.getByRole('button', { name: 'Stop Wisp' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
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
  expect(await screen.findByText('partial')).toBeTruthy();
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
  expect(await screen.findByRole('switch', { name: 'Enable Questie' })).toBeTruthy();
  expect(screen.queryByRole('switch', { name: 'Enable World of Warcraft' })).toBeNull();
  expect(screen.queryByRole('switch', { name: 'Enable Wisp' })).toBeNull();
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

test('a configured installation stays compact until explicitly opened', async () => {
  renderApp();
  await screen.findByRole('heading', { name: 'Wisp is ready' });
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
  expect(await screen.findByRole('button', { name: 'Continue with ChatGPT' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Connections' }).getAttribute('aria-current')).toBe(
    'page',
  );
  cleanup();
  status.auth.status = 'connected';
  status.gameConnected = false;
  renderApp();
  await screen.findByRole('heading', { name: 'Waiting for WoW' });
  expect(screen.queryByRole('button', { name: 'Connect AI' })).toBeNull();
  await fireEvent.click(screen.getByRole('button', { name: 'Manage installation' }));
  expect(screen.getByLabelText('WoW client folder')).toBeTruthy();
});

test('unreachable data pages do not report empty collections', async () => {
  const original = vi.mocked(request).getMockImplementation()!;
  vi.mocked(request).mockImplementation((route, body) =>
    route === '/status' ? Promise.reject(new Error('Service unreachable')) : original(route, body),
  );
  renderApp();
  await screen.findByText('Start Wisp to continue');
  for (const page of ['Memory', 'Panels', 'Routines', 'Integrations']) {
    await fireEvent.click(screen.getByRole('link', { name: page }));
    expect(await screen.findByText('Connect to Wisp to view your data')).toBeTruthy();
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

test('first-time setup resumes at the provider step and opens Overview after saving a model', async () => {
  const original = vi.mocked(desktop).getMockImplementation()!;
  let installed = false;
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
  await screen.findByRole('heading', { name: 'Set up Wisp' });
  expect(screen.queryByRole('navigation', { name: 'Main navigation' })).toBeNull();
  await fireEvent.click(await screen.findByRole('button', { name: 'Choose folder' }));
  const install = (await screen.findByRole('button', {
    name: 'Install addon',
  })) as HTMLButtonElement;
  await waitFor(() => expect(install.disabled).toBe(false));
  await fireEvent.click(install);
  await waitFor(() => expect(desktop).toHaveBeenCalledWith('install_addon', { wow: 'D:\\WoW' }));
  await screen.findByRole('heading', { name: 'Connect your AI provider' });

  cleanup();
  renderApp();
  await screen.findByRole('button', { name: 'Continue with ChatGPT' });
  expect(screen.queryByRole('navigation', { name: 'Main navigation' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Add account' })).toBeNull();
  expect((screen.getByRole('button', { name: 'Finish setup' }) as HTMLButtonElement).disabled).toBe(
    true,
  );

  status.auth.status = 'connected';
  status.auth.revision += 1;
  await act(() => desktopStore.getState().actions.refresh());
  await chooseOption(screen.getByRole('combobox', { name: 'Default model for new chats' }), 'Sol');
  await fireEvent.click(screen.getByRole('button', { name: 'Finish setup' }));
  await screen.findByRole('heading', { name: 'Wisp is ready' });
  expect(request).toHaveBeenCalledWith('/auth/model', { model: 'sol' });
  expect(screen.getByText('Sol')).toBeTruthy();
  expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBeTruthy();

  cleanup();
  status.modelConnected = false;
  status.auth.status = 'signed_out';
  renderApp();
  await screen.findByRole('heading', { name: 'Connect your AI account' });
  expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBeTruthy();
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
  expect(screen.queryByRole('heading', { name: 'Wisp is ready' })).toBeNull();
  expect((screen.getByRole('button', { name: 'Update addon' }) as HTMLButtonElement).disabled).toBe(
    false,
  );
  expect(screen.getByText('Update the addon, then type /reload in WoW.')).toBeTruthy();
});
