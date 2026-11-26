import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Effect } from 'effect';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import { CapabilitySettings } from '@wisp/bridge/capabilities';
import { AgentCapabilities, layerFromFile } from '@wisp/agent/capabilities';
import { HostError } from '@wisp/agent/engine';
import { enabledTool, toolOffered } from '@wisp/agent/enabled-tool';
import { localMemory } from '@wisp/agent/agent-memory';
import { z } from 'zod';
import { filterWebSearch } from '@wisp/agent/model-tools';

const readCapabilities = Effect.flatMap(AgentCapabilities, (settings) => settings.read).pipe(
  Effect.provide(layerFromFile()),
  Effect.provide(NodeFileSystem.layer),
);
test('settings persist, filter offered tools, and preserve child settings when an MCP is off', async () => {
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
    const initial = await Effect.runPromise(readCapabilities);
    assert.equal(toolOffered(tool, initial), true);
    assert.equal(initial.enabled('tool:search_database', false), false);
    await Promise.all([
      settings.set('tool:search_database', false),
      settings.set('mcp_tool:everloot:market_value', false),
    ]);
    assert.equal(
      toolOffered(tool, await Effect.runPromise(readCapabilities)),
      false,
      'disabled tools must be removed from the agent, not only hidden in the UI',
    );
    assert.equal(toolOffered(tool, initial), true, 'a snapshot keeps its original switches');
    await settings.set('mcp:everloot', false);
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
      await Effect.runPromise(
        Effect.flatMap(readCapabilities, (capabilities) => memory.scope('session', capabilities)),
      ),
      null,
      'disabled memory must not be recalled',
    );
    await assert.rejects(settings.set('unknown:tool', false));
    await writeFile(settings.file, '{broken json');
    await assert.rejects(
      Effect.runPromise(readCapabilities),
      (error) => error instanceof HostError && error.cause instanceof SyntaxError,
      'corrupt settings must never silently re-enable tools',
    );
    await writeFile(settings.file, JSON.stringify({ enabled: { 'tool:search_database': 'off' } }));
    await assert.rejects(
      Effect.runPromise(readCapabilities),
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
