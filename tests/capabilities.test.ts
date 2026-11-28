import { assert, it, layer } from '@effect/vitest';
import { Effect, FileSystem } from 'effect';
import { HostError } from '@wisp/agent/engine';
import { enabledTool, toolOffered } from '@wisp/agent/enabled-tool';
import { localMemory } from '@wisp/agent/agent-memory';
import * as Memory from '@wisp/agent/memory';
import { z } from 'zod';
import { filterWebSearch } from '@wisp/agent/model-tools';
import * as Everloot from '@wisp/agent/everloot';
import { defaultCapabilities } from '@wisp/protocol/capabilities';
import { agentReads, capabilitiesIn, capabilityFiles, platform } from './capability-fixture.ts';

layer(platform)('capability settings', (it) => {
  it.effect(
    'settings persist, filter offered tools, and preserve child settings when an MCP is off',
    () =>
      Effect.gen(function* () {
        const files = yield* capabilityFiles;
        const catalog = [...defaultCapabilities(), ...Everloot.capabilities];
        const { settings } = yield* capabilitiesIn(files, catalog);
        // The agent reads the saved switches straight from the file.
        const readCapabilities = agentReads(files.file);
        const tool = enabledTool('search_database', {
          description: 'target',
          inputSchema: z.object({}),
          execute: () => null,
        });
        assert.equal(tool.capability, 'tool:search_database');
        const initial = yield* readCapabilities;
        assert.equal(toolOffered(tool, initial), true);
        assert.equal(initial.enabled('tool:search_database', false), false);
        yield* Effect.all(
          [
            settings.set('tool:search_database', false),
            settings.set('mcp_tool:everloot:market_value', false),
          ],
          { concurrency: 'unbounded' },
        );
        assert.equal(
          toolOffered(tool, yield* readCapabilities),
          false,
          'disabled tools must be removed from the agent, not only hidden in the UI',
        );
        assert.equal(toolOffered(tool, initial), true, 'a snapshot keeps its original switches');
        yield* settings.set('mcp:everloot', false);
        assert.equal(
          (yield* settings.snapshot).find(
            (entry) => entry.id === 'mcp_tool:everloot:auction_history',
          )?.effective,
          false,
        );
        yield* settings.set('mcp:everloot', true);
        assert.equal(
          (yield* settings.snapshot).find((entry) => entry.id === 'mcp_tool:everloot:market_value')
            ?.enabled,
          false,
        );
        const restarted = yield* capabilitiesIn(files, catalog);
        assert.equal(yield* restarted.settings.enabled('tool:search_database'), false);
        yield* settings.set('memory:preferences', false);
        const unexpectedAccess = Effect.die('Disabled memory should not call its host');
        const memory = localMemory(
          'preferences',
          Memory.Service.of({
            characterKey: () => unexpectedAccess,
            read: () => unexpectedAccess,
            update: () => unexpectedAccess,
          }),
          Effect.runPromise,
        );
        assert.equal(
          yield* Effect.flatMap(readCapabilities, (capabilities) =>
            memory.scope('session', capabilities),
          ),
          null,
          'disabled memory must not be recalled',
        );
        assert.equal(
          (yield* Effect.flip(settings.set('unknown:tool', false)))._tag,
          'UnknownCapability',
        );
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(files.file, '{broken json');
        const broken = yield* Effect.flip(readCapabilities);
        assert.ok(
          broken instanceof HostError &&
            broken.cause instanceof Error &&
            broken.cause.message === 'Expected a valid JSON string',
          'corrupt settings must never silently re-enable tools',
        );
        yield* fs.writeFileString(
          files.file,
          JSON.stringify({ enabled: { 'tool:search_database': 'off' } }),
        );
        const invalid = yield* Effect.flip(readCapabilities);
        assert.ok(
          invalid instanceof HostError &&
            invalid.cause instanceof Error &&
            invalid.cause.message === 'Invalid capability settings; the file was preserved',
        );
      }),
  );
});

it('disabled native search is removed from model calls without affecting other tools', () => {
  const input = {
    prompt: [],
    tools: [
      {
        type: 'provider' as const,
        id: 'openai.web_search' as const,
        name: 'web_search',
        args: {},
      },
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
