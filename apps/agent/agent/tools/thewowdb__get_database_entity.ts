import { defineTool } from 'eve/tools';
import { databaseEntity } from '@wisp/protocol/database';
import { enabledTool } from '@wisp/agent/enabled-tool';
import { agentRPC } from '@wisp/agent/agent-rpc';

export default enabledTool(
  'get_database_entity',
  defineTool({
    deferred: true,
    description:
      'Get a verified Forever item, spell, quest, NPC or zone from the primary TheWoWDB catalog. Use IDs verified by search or user/game references. Returns structured facts, source links, attribution and build. Does not prove the character owns/knows/completed anything. Resolve native map IDs separately with wow__inspect_map.',
    inputSchema: databaseEntity,
    label: { start: ({ kind }) => 'Reading Forever ' + kind + ' data' },
    execute: (args, ctx) =>
      agentRPC(
        'database',
        { eveSession: ctx.session.id, operation: 'get', ...args },
        ctx.abortSignal,
      ),
  }),
);
