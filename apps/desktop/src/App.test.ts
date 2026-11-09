import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/svelte';
import App from './App.svelte';
import { desktop, request, type Status } from './api';
import { listen } from '@tauri-apps/api/event';
vi.mock('./api', () => ({ native: true, desktop: vi.fn(), request: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}));
let status: Status;
beforeEach(() => {
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
afterEach(cleanup);

test.each([
  { failed: false, duration: 5000 },
  { failed: true, duration: 10000 },
])('notifications expire after $duration ms (failed: $failed)', async ({ failed, duration }) => {
  render(App);
  await screen.findByText('Ready to help');
  await fireEvent.click(screen.getByRole('button', { name: 'Connections' }));
  if (failed) vi.mocked(request).mockRejectedValueOnce(new Error('Could not save settings'));
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

test('search settings keep Exa separate from model connections and do not reveal saved keys', async () => {
  status.search = { provider: 'auto', hasExaKey: true };
  render(App);
  await screen.findByText('Ready to help');
  await fireEvent.click(screen.getByRole('button', { name: 'Connections' }));
  expect(screen.getByRole('heading', { name: 'Web search' })).toBeTruthy();
  const key = screen.getByLabelText(
    'Exa API key (optional) (leave blank to keep saved key)',
  ) as HTMLInputElement;
  expect(key.value).toBe('');
  expect(key.type).toBe('password');
  await fireEvent.change(screen.getByLabelText('Search service'), { target: { value: 'exa' } });
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

test('Exa testing is available without a key and saving clears the password field', async () => {
  status.search = { provider: 'auto', hasExaKey: false };
  render(App);
  await screen.findByText('Ready to help');
  await fireEvent.click(screen.getByRole('button', { name: 'Connections' }));
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
  await fireEvent.click(screen.getByRole('button', { name: 'Save search settings' }));
  await waitFor(() =>
    expect((screen.getByLabelText('Exa API key (optional)') as HTMLInputElement).value).toBe(''),
  );
});
test('API connections expose the provider registry and save a model with protected-key input', async () => {
  render(App);
  await screen.findByText('Ready to help');
  await fireEvent.click(screen.getByRole('button', { name: 'Connections' }));
  await fireEvent.click(screen.getByRole('button', { name: 'Add connection' }));
  const provider = screen.getByLabelText('Provider');
  expect(provider.querySelectorAll('option')).toHaveLength(20);
  expect(screen.getByRole('option', { name: 'Google / Gemini' })).toBeTruthy();
  expect(screen.getByRole('option', { name: 'OpenRouter' })).toBeTruthy();
  expect(screen.queryByRole('option', { name: /Bedrock/ })).toBeNull();
  await fireEvent.input(screen.getByLabelText('Connection name'), {
    target: { value: 'My Claude' },
  });
  const key = screen.getByLabelText('API key');
  expect(key.getAttribute('type')).toBe('password');
  await fireEvent.input(key, { target: { value: 'test-api-key' } });
  await fireEvent.input(screen.getByLabelText('Models available in Wisp'), {
    target: { value: 'claude-test' },
  });
  await fireEvent.input(screen.getByLabelText('Context window in tokens'), {
    target: { value: '200000' },
  });
  await fireEvent.click(screen.getByRole('button', { name: 'Add model' }));
  await fireEvent.click(screen.getByRole('button', { name: 'Save connection' }));
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
  render(App);
  await screen.findByText('Ready to help');
  await fireEvent.click(screen.getByRole('button', { name: 'Connections' }));
  expect(screen.getByRole('button', { name: 'Continue with ChatGPT' })).toBeTruthy();
  expect(screen.getByText('My Claude')).toBeTruthy();
  await fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  expect(
    (screen.getByLabelText('API key (leave blank to keep saved key)') as HTMLInputElement).value,
  ).toBe('');
  expect((screen.getByLabelText('Provider') as HTMLSelectElement).disabled).toBe(true);
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
  render(App);
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
  render(App);
  await screen.findByText('Ready to help');
  await fireEvent.click(screen.getByRole('button', { name: 'Routines' }));
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
  render(App);
  await screen.findByText('Ready to help');
  await fireEvent.click(screen.getByRole('button', { name: 'Connections' }));
  expect(screen.getByRole('heading', { name: 'AI connections' })).toBeTruthy();
  await screen.findByRole('option', { name: 'Sol' });
  await fireEvent.change(screen.getByLabelText('Default model for new chats'), {
    target: { value: 'sol' },
  });
  await fireEvent.click(screen.getByRole('button', { name: 'Set default' }));
  await waitFor(() => expect(request).toHaveBeenCalledWith('/auth/model', { model: 'sol' }));
});

test('an active reply disables operations that would interrupt the bridge', async () => {
  status.activeTurns = 1;
  render(App);
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
  render(App);
  await screen.findByText('Ready to help');
  await fireEvent.click(screen.getByRole('button', { name: 'Integrations' }));
  await fireEvent.click(screen.getByRole('button', { name: 'Add MCP' }));
  await fireEvent.input(screen.getByLabelText('Name'), {
    target: { value: 'my_tools' },
  });
  await fireEvent.input(screen.getByLabelText('Endpoint URL'), {
    target: { value: 'https://example.com/mcp' },
  });
  await fireEvent.click(screen.getByRole('button', { name: 'Save connection' }));
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
});

test('sign-in URL is handed to the native allowlisted opener', async () => {
  status.auth.status = 'signed_out';
  status.auth.activeId = undefined;
  status.auth.profiles = [];
  render(App);
  await screen.findByText('Connect your AI account');
  await fireEvent.click(screen.getByRole('button', { name: 'Connections' }));
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
  render(App);
  await screen.findByText('Ready to help');
  await fireEvent.click(screen.getByRole('button', { name: 'Integrations' }));
  expect(screen.getByText('partial')).toBeTruthy();
  expect(screen.getByText('Some service indexes are unavailable.')).toBeTruthy();
  await fireEvent.click(screen.getByLabelText('Questie: Find NPC locations'));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('/integrations/set', {
      id: 'tool:find_npc_locations',
      enabled: false,
    }),
  );
  await waitFor(() =>
    expect((screen.getByLabelText('Enable Questie') as HTMLInputElement).disabled).toBe(false),
  );
  await fireEvent.click(screen.getByLabelText('Enable Questie'));
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
  render(App);
  await screen.findByText('Ready to help');
  await fireEvent.click(screen.getByRole('button', { name: 'Integrations' }));
  expect(screen.queryByRole('checkbox', { name: 'Enable World of Warcraft' })).toBeNull();
  expect(screen.queryByRole('checkbox', { name: 'Enable Wisp' })).toBeNull();
  expect(screen.queryByText('Conversation titles')).toBeNull();
  expect(screen.getByRole('checkbox', { name: 'Enable Questie' })).toBeTruthy();
  expect(screen.queryByText('Player preferences')).toBeNull();
  await fireEvent.click(screen.getByRole('button', { name: 'Memory' }));
  await fireEvent.click(screen.getByRole('checkbox', { name: 'Enable Player preferences' }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('/integrations/set', {
      id: 'memory:preferences',
      enabled: false,
    }),
  );
});

test('a configured installation stays compact until explicitly opened', async () => {
  render(App);
  await screen.findByText('Everything is ready');
  expect(screen.queryByLabelText('WoW client folder')).toBeNull();
  await fireEvent.click(screen.getByRole('button', { name: 'Manage installation' }));
  expect((screen.getByLabelText('WoW client folder') as HTMLInputElement).value).toBe('E:\\WoW');
  await fireEvent.click(screen.getByRole('button', { name: 'Done' }));
  expect(screen.queryByLabelText('WoW client folder')).toBeNull();
});

test('the next action follows the missing connection', async () => {
  status.auth.status = 'signed_out';
  render(App);
  await fireEvent.click(await screen.findByRole('button', { name: 'Connect AI' }));
  expect(screen.getByRole('button', { name: 'Continue with ChatGPT' })).toBeTruthy();
  cleanup();
  status.auth.status = 'connected';
  status.gameConnected = false;
  render(App);
  await screen.findByText('Ready when you enter Azeroth');
  expect(screen.queryByRole('button', { name: 'Connect AI' })).toBeNull();
  await fireEvent.click(screen.getByRole('button', { name: 'Check installation' }));
  expect(screen.getByLabelText('WoW client folder')).toBeTruthy();
});

test('unreachable data pages do not report empty collections', async () => {
  const original = vi.mocked(request).getMockImplementation()!;
  vi.mocked(request).mockImplementation((route, body) =>
    route === '/status' ? Promise.reject(new Error('Service unreachable')) : original(route, body),
  );
  render(App);
  await screen.findByText('Start Wisp to continue');
  for (const page of ['Memory', 'Panels', 'Routines', 'Integrations']) {
    await fireEvent.click(screen.getByRole('button', { name: page }));
    expect(screen.getByText('Connect to Wisp to view your data')).toBeTruthy();
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
  render(App);
  await fireEvent.click(screen.getByRole('button', { name: 'Panels' }));
  expect(screen.getByText('Loading your workspace…')).toBeTruthy();
  await waitFor(() => expect(finish).toBeDefined());
  finish(status);
  await screen.findByText('No panels yet.');
});

test('first-time setup leads from choosing a folder to installing the addon', async () => {
  const original = vi.mocked(desktop).getMockImplementation()!;
  vi.mocked(desktop).mockImplementation(async (command, args) => {
    if (command === 'desktop_info') {
      return {
        configured: false,
        wow: '',
        version: '0.0.1',
        platform: 'windows',
        dataDirectory: 'userdata',
      } as never;
    }
    if (command === 'pick_folder') {
      return 'D:\\WoW' as never;
    }
    return original(command, args);
  });
  render(App);
  await fireEvent.click(await screen.findByRole('button', { name: 'Choose game folder' }));
  await fireEvent.click(await screen.findByRole('button', { name: 'Install addon' }));
  await waitFor(() => expect(desktop).toHaveBeenCalledWith('install_addon', { wow: 'D:\\WoW' }));
});

test('an outdated addon becomes the next action even with healthy connections', async () => {
  const original = vi.mocked(desktop).getMockImplementation()!;
  vi.mocked(desktop).mockImplementation(async (command, args) => {
    const result = await original(command, args);
    return command === 'desktop_info'
      ? ({ ...(result as object), addonOutdated: true } as never)
      : result;
  });
  render(App);
  await screen.findByText('Update your Wisp addon');
  expect(screen.queryByText('Everything is ready')).toBeNull();
  expect((screen.getByRole('button', { name: 'Update addon' }) as HTMLButtonElement).disabled).toBe(
    false,
  );
  expect(screen.getByText('Update the addon, then type /reload in WoW.')).toBeTruthy();
});
