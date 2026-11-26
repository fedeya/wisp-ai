import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { defaultCapabilities } from '@wisp/protocol/capabilities';
import { Effect } from 'effect';
import { CapabilitySettings } from '../src/integrations/capabilities.ts';
import {
  createMcpCapabilities,
  mcpCapabilityCatalog,
} from '../src/integrations/mcp/mcp-capabilities.ts';
import { mcpDefinition } from '../src/integrations/mcp/mcp-manager.ts';

type Server = Parameters<typeof mcpCapabilityCatalog>[0][number];

test('adds MCP servers and tools after the built-in capabilities without URL secrets', () => {
  const servers = [
    {
      name: 'notes',
      url: 'https://user:secret@example.com/mcp?token=abc#frag',
      enabled: true,
      tools: [{ name: 'search', description: 'd'.repeat(600) }],
    },
    { name: 'local', enabled: false, description: 'Local helper' },
  ] as unknown as Server[];
  const catalog = mcpCapabilityCatalog(servers);
  const added = catalog.slice(defaultCapabilities().length);
  assert.deepEqual(added, [
    {
      id: 'mcp:notes',
      kind: 'mcp',
      name: 'notes',
      group: 'integrations',
      defaultEnabled: true,
      description: 'notes - https://example.com/mcp',
    },
    {
      id: 'mcp_tool:notes:search',
      name: 'search',
      group: 'integrations',
      parent: 'mcp:notes',
      description: 'd'.repeat(500),
    },
    {
      id: 'mcp:local',
      kind: 'mcp',
      name: 'local',
      group: 'integrations',
      defaultEnabled: false,
      description: 'Local helper - Local stdio server',
    },
  ]);
});

test('a capability write failure restores the MCP server switch and preserves the error', async () => {
  const server = mcpDefinition.parse({ name: 'notes', url: 'https://example.com/mcp' });
  const switches: boolean[] = [];
  const manager = {
    list: () => [{ ...server }],
    setEnabled: (_key: string, enabled: boolean) =>
      Effect.sync(() => {
        switches.push(enabled);
        server.enabled = enabled;
        return undefined;
      }),
  };
  const settings = new CapabilitySettings('unused');
  const failure = Error('Capability write failed');
  using set = vi.spyOn(settings, 'set').mockRejectedValue(failure);
  const { setCapability } = createMcpCapabilities(manager, settings);

  await assert.rejects(Effect.runPromise(setCapability('mcp:notes', false)), (error) => {
    assert.equal(error, failure);
    return true;
  });
  assert.deepEqual(switches, [false, true]);
  assert.deepEqual(set.mock.calls, [['mcp:notes', false]]);
});
