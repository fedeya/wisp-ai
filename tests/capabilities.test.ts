import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Effect } from 'effect';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import { CapabilitySettings } from '@wisp/bridge/capabilities';
import { AgentCapabilities } from '@wisp/agent/capabilities';
import { HostError } from '@wisp/agent/engine';
import { enabledTool, toolOffered } from '@wisp/agent/enabled-tool';
import { localMemory } from '@wisp/agent/agent-memory';
import { mcpConnections } from '@wisp/agent/mcp-tools';
import { z } from 'zod';
import { filterWebSearch } from '@wisp/agent/model-tools';

// Tool names are <connection>__<tool>; a connection name must keep them legal function names.
const CONNECTION_NAME = /^[a-z][a-z0-9-]*$/;

const readFlags = Effect.flatMap(AgentCapabilities, (settings) => settings.read).pipe(
  Effect.provide(AgentCapabilities.layer()),
  Effect.provide(NodeFileSystem.layer),
);
const readConnections = (configFile?: string) =>
  Effect.runPromise(
    Effect.flatMap(readFlags, (flags) => mcpConnections(flags, () => configFile)).pipe(
      Effect.provide(NodeFileSystem.layer),
    ),
  );

test('settings persist, filter real tool/MCP definitions, and preserve child settings when an MCP is off', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'wow-wisp-capabilities-'));
  const previous = process.env.WOW_CAPABILITIES_FILE;
  try {
    const settings = new CapabilitySettings(path.join(directory, 'capabilities.json'));
    process.env.WOW_CAPABILITIES_FILE = settings.file;
    await settings.load();
    const tool = enabledTool('search_database', {
      description: 'target',
      inputSchema: z.object({}),
      execute: () => null,
    });
    assert.equal(tool.capability, 'tool:search_database');
    assert.equal(toolOffered(tool, await Effect.runPromise(readFlags)), true);
    await Promise.all([
      settings.set('tool:search_database', false),
      settings.set('mcp_tool:everloot:market_value', false),
    ]);
    assert.equal(
      toolOffered(tool, await Effect.runPromise(readFlags)),
      false,
      'disabled tools must be removed from the agent, not only hidden in the UI',
    );
    const connection = await readConnections();
    assert.deepEqual(Object.keys(connection), ['everloot', 'everloot-search', 'everloot-changes']);
    assert.ok(Object.keys(connection).every((name) => CONNECTION_NAME.test(name)));
    assert.equal(connection.everloot!.allow!.includes('market_value'), false);
    assert.ok(connection.everloot!.allow!.includes('auction_history'));
    assert.equal(connection['everloot-search']!.provided?.version, 'forever');
    assert.equal(connection['everloot-changes']!.provided?.game, 'forever');
    for (const definition of Object.values(connection)) {
      assert.ok(
        !definition.allow?.some((name) =>
          ['get_by_name', 'get_entity', 'answer_sources', 'fetch', 'search'].includes(name),
        ),
        'unfiltered cross-version lookup must not be exposed',
      );
    }
    await settings.set('mcp:everloot', false);
    assert.deepEqual(await readConnections(), {});
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
      await Effect.runPromise(Effect.flatMap(readFlags, (flags) => memory.scope('session', flags))),
      null,
      'disabled memory must not be recalled',
    );
    await assert.rejects(settings.set('unknown:tool', false));
    await writeFile(settings.file, '{broken json');
    await assert.rejects(
      Effect.runPromise(readFlags),
      (error) => error instanceof HostError && error.cause instanceof SyntaxError,
      'corrupt settings must never silently re-enable tools',
    );
    await writeFile(settings.file, JSON.stringify({ enabled: { 'tool:search_database': 'off' } }));
    await assert.rejects(
      Effect.runPromise(readFlags),
      (error) =>
        error instanceof HostError &&
        error.cause instanceof Error &&
        error.cause.message === 'Invalid capability settings; the file was preserved',
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

// Everloot is on by default; these tests look at the player's own servers only.
async function withoutEverloot(work: () => Promise<void>) {
  const previous = process.env.WOW_CAPABILITIES_FILE;
  const directory = await mkdtemp(path.join(tmpdir(), 'wisp-no-everloot-'));
  try {
    process.env.WOW_CAPABILITIES_FILE = path.join(directory, 'capabilities.json');
    await writeFile(
      process.env.WOW_CAPABILITIES_FILE,
      JSON.stringify({ enabled: { 'mcp:everloot': false } }),
    );
    await work();
  } finally {
    if (previous === undefined) {
      delete process.env.WOW_CAPABILITIES_FILE;
    } else {
      process.env.WOW_CAPABILITIES_FILE = previous;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

test('a fresh install has no custom MCP connections until configured', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'wisp-external-missing-'));
  const previous = process.env.WOW_MCP_CONFIG;
  try {
    process.env.WOW_MCP_CONFIG = path.join(directory, 'mcp.json');
    await withoutEverloot(async () => {
      assert.deepEqual(await readConnections(process.env.WOW_MCP_CONFIG), {});
      await writeFile(process.env.WOW_MCP_CONFIG!, 'invalid JSON');
      await assert.rejects(
        readConnections(process.env.WOW_MCP_CONFIG),
        (error) => error instanceof HostError && error.cause instanceof SyntaxError,
      );
    });
  } finally {
    if (previous === undefined) {
      delete process.env.WOW_MCP_CONFIG;
    } else {
      process.env.WOW_MCP_CONFIG = previous;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test('custom MCP connections use legal names and the configured bridge origin', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'wisp-external-'));
  const previous = process.env.WOW_MCP_CONFIG;
  const flags = process.env.WOW_CAPABILITIES_FILE;
  const origin = process.env.WOW_BRIDGE_URL;
  try {
    process.env.WOW_MCP_CONFIG = path.join(directory, 'mcp.json');
    process.env.WOW_CAPABILITIES_FILE = path.join(directory, 'capabilities.json');
    await writeFile(
      process.env.WOW_CAPABILITIES_FILE,
      JSON.stringify({ enabled: { 'mcp:everloot': false } }),
    );
    process.env.WOW_BRIDGE_URL = 'http://127.0.0.1:49521';
    await writeFile(
      process.env.WOW_MCP_CONFIG,
      JSON.stringify({ servers: { my_tools: { enabled: true, description: 'Test' } } }),
    );
    const connections = await readConnections(process.env.WOW_MCP_CONFIG);
    assert.deepEqual(Object.keys(connections), ['my-tools']);
    assert.match(Object.keys(connections)[0]!, CONNECTION_NAME);
    assert.equal(connections['my-tools']!.url, 'http://127.0.0.1:49521/mcp/my_tools');
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
