import { test } from 'vitest';
import assert from 'node:assert/strict';
import { defaultCapabilities } from '@wisp/protocol/capabilities';
import { mcpCapabilityCatalog } from '../src/integrations/mcp/mcp-capabilities.ts';

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
