import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CapabilitySettings } from '@wisp/bridge/capabilities';
import { capabilityEnabled, connectionTools } from '@wisp/agent/capabilities';
import { enabledTool } from '@wisp/agent/enabled-tool';
import { localMemory } from '@wisp/agent/agent-memory';
import { dynamicEvaluate } from './node_modules/eve/dist/src/dynamic/definition.js';
import external from '../apps/agent/agent/connections/external.ts';
import everloot from '../apps/agent/agent/connections/everloot.ts';
import { filterWebSearch } from '@wisp/agent/model-tools';
import { namedEntries } from './node_modules/eve/dist/src/definitions/named.js';
import { CONNECTION_SLUG_PATTERN } from './node_modules/eve/dist/src/discover/grammar.js';
import { readStampedConnectionProtocol } from './node_modules/eve/dist/src/public/definitions/connections/protocol.js';
import { resolveDynamicConnectionValue } from './node_modules/eve/dist/src/runtime/resolve-connection.js';

test('settings persist, filter real tool/MCP definitions, and preserve child settings when an MCP is off', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'wow-wisp-capabilities-'));
  const previous = process.env.WOW_CAPABILITIES_FILE;
  try {
    const settings = new CapabilitySettings(path.join(directory, 'capabilities.json'));
    process.env.WOW_CAPABILITIES_FILE = settings.file;
    await settings.load();
    const definition = { description: 'target' };
    const resolve = dynamicEvaluate(enabledTool('search_database', definition));
    assert.equal(await resolve({} as never), definition);
    await Promise.all([
      settings.set('tool:search_database', false),
      settings.set('mcp_tool:everloot:market_value', false),
    ]);
    assert.equal(
      await resolve({} as never),
      null,
      'disabled tools must be removed from Eve, not only hidden in the UI',
    );
    assert.equal(await capabilityEnabled('tool:search_database'), false);
    const connection = await dynamicEvaluate(everloot)({} as never);
    assert.ok(connection);
    const source = {
      logicalPath: 'connections/everloot.ts',
      slug: 'everloot',
      sourceId: 'connections/everloot.ts',
      sourceKind: 'module' as const,
    };
    const kind = {
      noun: 'connection',
      made: 'defineMcpClientConnection()',
      is: (value: unknown) => readStampedConnectionProtocol(value) !== undefined,
      pattern: CONNECTION_SLUG_PATTERN,
      rule: 'Expected a valid connection slug',
    };
    const runtimeConnections = namedEntries(source, connection, kind).map(({ name, entry }) =>
      resolveDynamicConnectionValue(entry, { ...source, connectionName: name }),
    );
    assert.deepEqual(
      runtimeConnections.map((c) => c.connectionName),
      ['everloot', 'everloot-search', 'everloot-changes'],
    );
    assert.throws(
      () => namedEntries(source, { everloot_search: connection['everloot-search'] }, kind),
      /illegal connection name/,
    );
    assert.equal(
      'allow' in connection.everloot.tools! &&
        connection.everloot.tools.allow.includes('market_value'),
      false,
    );
    assert.ok(
      (await connectionTools('everloot', ['auction_history', 'market_value'])).includes(
        'auction_history',
      ),
    );
    assert.equal(connection['everloot-search'].toolCall?.providedArguments?.version, 'forever');
    assert.equal(connection['everloot-changes'].toolCall?.providedArguments?.game, 'forever');
    for (const definition of Object.values(connection)) {
      assert.ok(
        !(
          'allow' in definition.tools! &&
          definition.tools.allow.some((name) =>
            ['get_by_name', 'get_entity', 'answer_sources', 'fetch', 'search'].includes(name),
          )
        ),
        'unfiltered cross-version lookup must not be exposed',
      );
    }
    await settings.set('mcp:everloot', false);
    assert.equal(await dynamicEvaluate(everloot)({} as never), null);
    assert.equal(
      settings.snapshot().find((entry) => entry.id === 'mcp_tool:everloot:auction_history')
        ?.effective,
      false,
    );
    await settings.set('mcp:everloot', true);
    assert.equal(
      settings.snapshot().find((entry) => entry.id === 'mcp_tool:everloot:market_value')?.enabled,
      false,
    );
    const restarted = new CapabilitySettings(settings.file);
    await restarted.load();
    assert.equal(restarted.enabled('tool:search_database'), false);
    await settings.set('memory:preferences', false);
    const memory = localMemory('preferences');
    assert.equal(
      await (memory.scope as any)({ session: { id: 'session' } }),
      null,
      'disabled memory must not be recalled',
    );
    await assert.rejects(settings.set('unknown:tool', false));
    await writeFile(settings.file, '{broken json');
    await assert.rejects(
      capabilityEnabled('tool:search_database'),
      'corrupt settings must never silently re-enable tools',
    );
  } finally {
    if (previous === undefined) {
      delete process.env.WOW_CAPABILITIES_FILE;
    } else {
      process.env.WOW_CAPABILITIES_FILE = previous;
    }
    assert.ok(directory.startsWith(path.join(tmpdir(), 'wow-wisp-capabilities-')));
    await rm(directory, { recursive: true, force: true });
  }
});
test('disabled native search is removed from model calls without affecting other tools', () => {
  const input = {
    prompt: [],
    tools: [
      { type: 'provider' as const, id: 'openai.web_search' as const, name: 'web_search', args: {} },
      { type: 'function' as const, name: 'query_character', inputSchema: {} },
    ],
    toolChoice: { type: 'tool' as const, toolName: 'web_search' },
  };
  assert.equal(filterWebSearch(input, true), input);
  const filtered = filterWebSearch(input, false);
  assert.deepEqual(
    filtered.tools?.map((tool) => tool.name),
    ['query_character'],
  );
  assert.deepEqual(filtered.toolChoice, { type: 'auto' });
});

test('a fresh install has no custom MCP connections until configured', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'wisp-external-missing-'));
  const previous = process.env.WOW_MCP_CONFIG;
  try {
    process.env.WOW_MCP_CONFIG = path.join(directory, 'mcp.json');
    assert.equal(await dynamicEvaluate(external)({} as never), null);
    await writeFile(process.env.WOW_MCP_CONFIG, 'invalid JSON');
    await assert.rejects(async () => dynamicEvaluate(external)({} as never), SyntaxError);
  } finally {
    if (previous === undefined) {
      delete process.env.WOW_MCP_CONFIG;
    } else {
      process.env.WOW_MCP_CONFIG = previous;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test('custom MCP connections use legal Eve names and the configured bridge origin', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'wisp-external-'));
  const previous = process.env.WOW_MCP_CONFIG;
  const flags = process.env.WOW_CAPABILITIES_FILE;
  const origin = process.env.WOW_BRIDGE_URL;
  try {
    process.env.WOW_MCP_CONFIG = path.join(directory, 'mcp.json');
    process.env.WOW_CAPABILITIES_FILE = '';
    process.env.WOW_BRIDGE_URL = 'http://127.0.0.1:49521';
    await writeFile(
      process.env.WOW_MCP_CONFIG,
      JSON.stringify({ servers: { my_tools: { enabled: true, description: 'Test' } } }),
    );
    const connections = await dynamicEvaluate(external)({} as never);
    assert.ok(connections);
    assert.deepEqual(Object.keys(connections), ['my-tools']);
    assert.match(Object.keys(connections)[0], CONNECTION_SLUG_PATTERN);
    assert.equal(connections['my-tools'].url, 'http://127.0.0.1:49521/mcp/my_tools');
  } finally {
    if (previous === undefined) {
      delete process.env.WOW_MCP_CONFIG;
    } else {
      process.env.WOW_MCP_CONFIG = previous;
    }
    if (flags === undefined) {
      delete process.env.WOW_CAPABILITIES_FILE;
    } else {
      process.env.WOW_CAPABILITIES_FILE = flags;
    }
    if (origin === undefined) {
      delete process.env.WOW_BRIDGE_URL;
    } else {
      process.env.WOW_BRIDGE_URL = origin;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
