// @effect-migrated
// Inputs each contract schema accepts, with what it decodes them to, and inputs
// it rejects. They were checked against the zod schemas these replaced, so the
// same inputs pass and fail as before.

import { maxConnectionModels } from '../src/providers.ts';

export interface ConstraintFixture {
  /** Decoded with unknown keys rejected, as zod's strict objects did. */
  readonly strict?: boolean;
  readonly accepts: readonly (readonly [input: unknown, output: unknown])[];
  readonly rejects: readonly unknown[];
}

const uuid = '3f2c1b9e-8d4a-4f6b-9c2e-1a2b3c4d5e6f';
const model = { id: 'gpt-5' };
const connection = { id: uuid, provider: 'openai', name: 'OpenAI', models: [model] };
const trigger = { kind: 'event', event: 'level_up', filters: [] };
const routine = {
  id: 'levels',
  title: 'Levels',
  instruction: 'Cheer',
  triggers: [trigger],
  cooldownSeconds: 600,
  once: false,
};
const saved = { ...routine, characterKey: 'key', enabled: true, updatedAt: 1, nextAt: 2 };
const run = {
  id: 'run',
  routineId: 'levels',
  characterKey: 'key',
  title: 'Levels',
  startedAt: 1,
  event: 'level_up',
  status: 'done',
};
const view = {
  id: 'new_panel',
  name: 'Panel',
  description: 'A panel',
  enabled: true,
  channelDefault: false,
  override: null,
};
const capability = { id: 'core:wow', name: 'WoW', group: 'core', description: 'Game' };
const auth = { status: 'signed_out', revision: 1, profiles: [] };
const status = {
  ready: true,
  gameConnected: false,
  model: 'gpt-5',
  activeTurns: 0,
  auth,
  mcps: [],
  integrations: [],
  panels: [],
  routines: [],
  routineRuns: [],
};
const mcpDefaults = { description: '', transport: 'http', args: [], enabled: true };
const http = { name: 'github', url: 'https://example.com/mcp' };
const same = <T>(input: T) => [input, input] as const;

export const constraintFixtures: Record<string, ConstraintFixture> = {
  'features.featureName': {
    accepts: [same('new_panel'), same('a'), same('a'.repeat(63))],
    rejects: ['', 'New', '1a', 'new-panel', 'a'.repeat(64), 1],
  },
  'features.featureOverrides': {
    accepts: [same({}), same({ new_panel: true, other: false })],
    rejects: [{ 'New Panel': true }, { new_panel: 'yes' }, [], null],
  },
  'features.featureViewSchema': {
    accepts: [same(view), same({ ...view, override: true })],
    rejects: [
      { ...view, override: undefined },
      { ...view, id: 'Bad' },
    ],
  },
  'features.featuresStateSchema': {
    accepts: [same({ channel: 'nightly', flags: [view] })],
    rejects: [{ channel: 'beta', flags: [] }, { channel: 'stable' }],
  },
  'character-key.characterName': {
    accepts: [same({ name: 'Fedrath', realm: '' })],
    rejects: [{ name: '', realm: '' }, { name: 'Fedrath' }],
  },
  'capabilities.capabilitySchema': {
    accepts: [same(capability), same({ ...capability, kind: 'mcp', defaultEnabled: false })],
    rejects: [
      { ...capability, group: 'other' },
      { ...capability, kind: 'plugin' },
      { ...capability, description: undefined },
    ],
  },
  'capabilities.capabilityViewSchema': {
    accepts: [
      same({ ...capability, enabled: true, effective: true, available: false, status: 'x' }),
    ],
    rejects: [capability],
  },
  'mcp-setup.mcpName': {
    accepts: [same('github'), same('my_tools2'), same('a'.repeat(48))],
    rejects: ['', 'GitHub', '1tools', 'wow', 'wisp', '__proto__', 'constructor', 'a'.repeat(49)],
  },
  'mcp-setup.mcpDefinition': {
    accepts: [
      [http, { ...mcpDefaults, ...http }],
      [
        { name: 'local', transport: 'stdio', command: 'node', args: ['server.js'] },
        { ...mcpDefaults, name: 'local', transport: 'stdio', command: 'node', args: ['server.js'] },
      ],
      [
        { ...http, transport: 'sse', url: 'http://localhost:3000/sse', enabled: false },
        {
          ...mcpDefaults,
          ...http,
          transport: 'sse',
          url: 'http://localhost:3000/sse',
          enabled: false,
        },
      ],
    ],
    rejects: [
      { name: 'github' },
      { name: 'local', transport: 'stdio' },
      { ...http, url: 'ftp://example.com' },
      { ...http, url: 'https://user:secret@example.com/mcp' },
      { ...http, url: 'not a url' },
      { ...http, description: 'x'.repeat(501) },
      { ...http, args: Array.from({ length: 51 }, () => 'x') },
      { ...http, transport: 'websocket' },
      { ...http, name: 'wow' },
    ],
  },
  'mcp-setup.mcpSetup': {
    accepts: [
      [
        { server: http, token: 'secret', env: { API_KEY: 'x' } },
        { server: { ...mcpDefaults, ...http }, token: 'secret', env: { API_KEY: 'x' } },
      ],
    ],
    rejects: [
      { server: http, env: { '1KEY': 'x' } },
      { server: http, env: { KEY: 'x'.repeat(10_001) } },
      { server: http, token: 'x'.repeat(10_001) },
      { token: 'secret' },
    ],
  },
  'providers.providerId': {
    accepts: [same('openai'), same('compatible')],
    rejects: ['chatgpt', ''],
  },
  'providers.reasoningEffort': {
    accepts: [same('xhigh'), same('enabled')],
    rejects: ['extreme'],
  },
  'providers.connectionModel': {
    accepts: [
      [{ id: '  gpt-5  ' }, model],
      [
        { id: 'gpt-5', name: ' GPT 5 ', contextWindow: 100_000_000, reasoningEfforts: ['low'] },
        { id: 'gpt-5', name: 'GPT 5', contextWindow: 100_000_000, reasoningEfforts: ['low'] },
      ],
    ],
    rejects: [
      { id: '' },
      { id: '   ' },
      { id: 'gpt 5' },
      { id: 'gpt-5?x=1' },
      { id: 'gpt#5' },
      { id: 'x'.repeat(201) },
      { id: 'gpt-5', name: '  ' },
      { id: 'gpt-5', contextWindow: 0 },
      { id: 'gpt-5', contextWindow: 1.5 },
      { id: 'gpt-5', contextWindow: 100_000_001 },
      { id: 'gpt-5', reasoningEfforts: Array.from({ length: 9 }, () => 'low') },
    ],
  },
  'providers.discoveredConnectionModel': {
    accepts: [same({ ...model, supportsTools: true })],
    rejects: [{ ...model, supportsTools: 'yes' }],
  },
  'providers.connectionConfig': {
    accepts: [
      same(connection),
      [
        { ...connection, name: ' Lab ', baseURL: ' https://api.example.com/v1 ' },
        { ...connection, name: 'Lab', baseURL: 'https://api.example.com/v1' },
      ],
    ],
    rejects: [
      { ...connection, id: 'not-a-uuid' },
      { ...connection, provider: 'chatgpt' },
      { ...connection, name: '' },
      { ...connection, name: 'x'.repeat(81) },
      { ...connection, baseURL: 'not a url' },
      { ...connection, baseURL: 'https://example.com/' + 'x'.repeat(1000) },
      { ...connection, models: [] },
      { ...connection, models: Array.from({ length: maxConnectionModels + 1 }, () => model) },
    ],
  },
  'providers.connectionSetup': {
    accepts: [
      same({ provider: 'openai', models: [model] }),
      [
        { provider: 'openai', models: [model], apiKey: ' sk-test ' },
        { provider: 'openai', models: [model], apiKey: 'sk-test' },
      ],
    ],
    rejects: [
      { provider: 'openai', models: [model], id: 'bad' },
      { provider: 'openai', models: [model], apiKey: 'x'.repeat(4097) },
      { provider: 'openai' },
    ],
  },
  'providers.connectionDiscovery': {
    accepts: [same({ provider: 'anthropic' })],
    rejects: [{ provider: 'anthropic', name: '' }],
  },
  'providers.connectionView': {
    accepts: [same({ ...connection, hasKey: true })],
    rejects: [connection],
  },
  'routines.routineTrigger': {
    accepts: [
      [{ kind: 'event', event: 'level_up' }, trigger],
      same({
        kind: 'event',
        event: 'level_up',
        filters: [{ field: 'level', op: 'multiple_of', value: 2 }],
      }),
      same({
        kind: 'event',
        event: 'zone_changed',
        filters: [{ field: 'zone', op: 'contains', value: 'Wood' }],
      }),
      same({ kind: 'interval', seconds: 60 }),
    ],
    rejects: [
      { kind: 'interval', seconds: 59 },
      { kind: 'interval', seconds: 90.5 },
      { kind: 'interval', seconds: 2_592_001 },
      { kind: 'event', event: 'jumped' },
      { kind: 'event', event: 'level_up', filters: [{ field: 'zone', op: 'eq', value: 'x' }] },
      { kind: 'event', event: 'level_up', filters: [{ field: 'level', op: 'eq', value: 'x' }] },
      { kind: 'event', event: 'level_up', filters: [{ field: 'level', op: 'contains', value: 1 }] },
      { kind: 'event', event: 'zone_changed', filters: [{ field: 'zone', op: 'gte', value: 'a' }] },
      {
        kind: 'event',
        event: 'level_up',
        filters: [{ field: 'level', op: 'multiple_of', value: 0 }],
      },
      { kind: 'event', event: 'level_up', filters: Array.from({ length: 9 }, () => ({})) },
    ],
  },
  'routines.routineDefinition': {
    accepts: [
      same(routine),
      [{ id: 'levels', title: ' Levels ', instruction: ' Cheer ', triggers: [trigger] }, routine],
    ],
    rejects: [
      { ...routine, id: '1levels' },
      { ...routine, id: 'x'.repeat(65) },
      { ...routine, title: '  ' },
      { ...routine, title: 'x'.repeat(101) },
      { ...routine, instruction: 'x'.repeat(6001) },
      { ...routine, triggers: [] },
      { ...routine, triggers: Array.from({ length: 9 }, () => trigger) },
      { ...routine, cooldownSeconds: 59 },
      { ...routine, cooldownSeconds: 86_401 },
      { ...routine, once: 'yes' },
    ],
  },
  'routines.routineInput': {
    strict: true,
    accepts: [
      same({ operation: 'catalog' }),
      same({ operation: 'get', id: 'levels' }),
      same({ operation: 'save', routine }),
    ],
    rejects: [
      { operation: 'list', extra: true },
      { operation: 'get' },
      { operation: 'run', id: 'levels' },
      { operation: 'save', routine: { ...routine, extra: true } },
      { operation: 'save', routine: { ...routine, triggers: [{ ...trigger, extra: true }] } },
    ],
  },
  'routines.routineEvent': {
    strict: true,
    accepts: [
      [
        { event: 'bags_changed', values: [] },
        { event: 'bags_changed', values: {} },
      ],
      same({ event: 'level_up', values: { level: 10 } }),
      same({ event: 'zone_changed', values: { zone: 'Elwynn', indoors: false } }),
    ],
    rejects: [
      { event: 'level_up', values: [10] },
      { event: 'level_up', values: { ['x'.repeat(41)]: 1 } },
      { event: 'level_up', values: { level: 'x'.repeat(301) } },
      { event: 'level_up', values: { level: Number.POSITIVE_INFINITY } },
      {
        event: 'level_up',
        values: Object.fromEntries(Array.from({ length: 9 }, (_, i) => ['k' + i, i])),
      },
      { event: 'level_up', values: {}, extra: true },
      { event: 'jumped', values: {} },
    ],
  },
  'routines.savedRoutine': {
    strict: true,
    accepts: [
      same(saved),
      same({ ...saved, pending: { event: 'level_up', values: { level: 2 }, at: 3 } }),
    ],
    rejects: [
      { ...saved, characterKey: '' },
      { ...saved, enabled: undefined },
      { ...saved, extra: true },
    ],
  },
  'routines.routineRun': {
    accepts: [same(run), same({ ...run, finishedAt: 2, summary: 'Done' })],
    rejects: [
      { ...run, id: '' },
      { ...run, status: 'skipped' },
    ],
  },
  'search.wowheadQuery': {
    strict: true,
    accepts: [
      [{ query: ' Mage guide ' }, { query: 'Mage guide', depth: 'standard', queries: [] }],
      same({
        query: 'Mage guide',
        depth: 'deep',
        maxResults: 12,
        maxQueries: 6,
        timeoutSeconds: 180,
        excerptCharacters: 12_000,
        queries: ['Frost', 'Fire'],
      }),
    ],
    rejects: [
      { query: '' },
      { query: '   ' },
      { query: 'x'.repeat(1001) },
      { query: 'x', depth: 'thorough' },
      { query: 'x', maxResults: 0 },
      { query: 'x', maxResults: 13 },
      { query: 'x', maxQueries: 7 },
      { query: 'x', timeoutSeconds: 9 },
      { query: 'x', excerptCharacters: 12_001 },
      { query: 'x', maxResults: 2.5 },
      { query: 'x', queries: ['a', 'b', 'c', 'd', 'e', 'f'] },
      { query: 'x', queries: [' '] },
      { query: 'x', agentSession: 'session' },
    ],
  },
  'search.searchConfig': {
    accepts: [[{}, { provider: 'auto' }], same({ provider: 'disabled' })],
    rejects: [{ provider: 'bing' }],
  },
  'search.searchSetup': {
    accepts: [[{ apiKey: ' key ' }, { provider: 'auto', apiKey: 'key' }]],
    rejects: [{ apiKey: 'x'.repeat(4097) }],
  },
  'search.searchState': {
    accepts: [same({ provider: 'exa', hasExaKey: true })],
    rejects: [{ provider: 'exa' }],
  },
  'desktop.desktopInfoSchema': {
    accepts: [
      same({ configured: true, dataDirectory: 'C:/Wisp', platform: 'windows', version: '0.3.2' }),
      same({
        wow: null,
        configured: false,
        dataDirectory: 'C:/Wisp',
        platform: 'windows',
        version: '0.3.2',
        addonOutdated: null,
        addonUpdateNotice: null,
      }),
    ],
    rejects: [
      { configured: true, dataDirectory: 'C:/Wisp', platform: 'windows' },
      {
        configured: true,
        dataDirectory: 'C:/Wisp',
        platform: 'windows',
        version: '0.3.2',
        addonUpdateNotice: 'later',
      },
    ],
  },
  'desktop.statusSchema': {
    accepts: [
      [
        status,
        {
          ...status,
          connections: [],
          characters: {},
          appUpdate: null,
          features: { channel: 'stable', flags: [] },
        },
      ],
    ],
    rejects: [
      { ...status, activeTurns: -1 },
      { ...status, activeTurns: 0.5 },
      { ...status, characters: { key: { name: '' } } },
    ],
  },
  'desktop-routes./auth/start.output': {
    accepts: [
      [
        { authorizationUrl: ' https://auth.example.com/authorize\n' },
        { authorizationUrl: 'https://auth.example.com/authorize' },
      ],
    ],
    rejects: [{ authorizationUrl: 'not a url' }, {}],
  },
  'desktop-routes./search/remove-exa.input': {
    accepts: [same({})],
    rejects: [{ provider: 'exa' }, [], null],
  },
  'desktop-routes./app-update.input': {
    accepts: [same({ version: null }), same({ version: '0.4.0' })],
    rejects: [{ version: '' }, { version: 'x'.repeat(65) }, {}],
  },
  'desktop-routes./connections/remove.input': {
    accepts: [same({ id: uuid })],
    rejects: [{ id: 'connection' }],
  },
  'desktop-routes./features/set.input': {
    accepts: [same({ id: 'new_panel', enabled: null })],
    rejects: [{ id: 'New', enabled: true }, { id: 'new_panel' }],
  },
};
